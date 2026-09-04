import { describeErrorForAudit } from "./audit-text.js";
import type {
  DesktopNotice,
  DesktopNotifierFactory,
} from "./desktop-notice.js";

/**
 * A notifier that says one thing by running one command.
 *
 * Every host that can show a desktop notification can be asked to from a child
 * process — `notify-send` on a freedesktop desktop, `osascript` on macOS,
 * PowerShell on Windows — so the loop is shared here and each platform
 * contributes only the command. That split is the same one
 * `screen-text-reader-subprocess.ts` makes for the same reason: the mechanism is
 * one thing to get right once, and a platform file that also owned scheduling
 * would be three copies of it.
 *
 * The arithmetic that shaped the Windows *reader* does not apply here, and it is
 * worth saying why, because the conclusion is the opposite. A per-sample spawn
 * was indefensible for a screen reader — a thousand milliseconds of process
 * startup against forty of real work, every second, forever. A notice happens
 * when the agent finishes a turn, which is seconds apart at best and usually
 * far rarer, so a spawn per notice is a cost nobody can measure and it buys the
 * simplest possible failure model: nothing is resident, so nothing can be
 * resident and wrong.
 *
 * **Every delivery has a deadline, because a helper can block for minutes.**
 * Measured on a host with no notification daemon: `notify-send` does not fail,
 * it asks D-Bus to start the service and waits out the activation timeout —
 * `service_start_timeout=120000ms`, two minutes, and only then exits 1. A
 * notifier that waited for that would hold its single delivery slot through two
 * hundred agent turns, and every notice in between would be silently dropped by
 * the replacement rule below. So the deadline is part of the mechanism rather
 * than a platform's problem: any host's helper can hang, and none of them is
 * worth waiting for once the moment it was describing has passed.
 */

/** What one invocation did. */
export interface NoticeDelivery {
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Runs one notice to completion.
 *
 * Hands the spawned process back so `close()` can kill a delivery still in
 * flight, for the same reason the poll loop does: a child that outlives the
 * notifier that started it is a leak nobody can see.
 */
export type NoticeSender = (
  notice: DesktopNotice,
  onSpawned: (child: { kill(): void }) => void,
) => Promise<NoticeDelivery>;

export interface CommandDesktopNotifierOptions {
  /** The program named in diagnostics, e.g. `"notify-send"`. */
  readonly program: string;
  readonly send: NoticeSender;
  /**
   * How long one delivery may take before it is killed and reported.
   *
   * Generous for the work — handing two strings to a daemon that is already
   * running is milliseconds — and far short of the two minutes a missing daemon
   * costs, which is the case this bounds.
   */
  readonly timeoutMs?: number;
}

/** Long enough for any working host, short enough that a hung one is news. */
const DEFAULT_TIMEOUT_MS = 5_000;

export function commandDesktopNotifierFactory(
  options: CommandDesktopNotifierOptions,
): DesktopNotifierFactory {
  const { program, send } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return ({ onDiagnostic }) => {
    let closed = false;
    let delivering: Promise<void> | null = null;
    let queued: DesktopNotice | null = null;
    let active: { kill(): void } | null = null;
    let lastErrorMessage: string | null = null;

    /**
     * One diagnostic per transition, not per failure.
     *
     * A desktop with no notification daemon fails identically every time, and a
     * turn loop that ran all night would otherwise write the same line into the
     * log a thousand times. Cleared on the first success, so a daemon that comes
     * back and goes away again is two events rather than silence.
     */
    const report = (message: string): void => {
      // Nothing after close is news. `close()` kills the delivery in flight, and
      // a killed child exits non-zero — so without this guard every clean stop
      // with notices enabled would write one invented failure into the log. The
      // streaming screen reader draws the same line for the same reason: an exit
      // that close() caused neither restarts nor reports.
      if (closed) return;
      if (message === lastErrorMessage) return;
      lastErrorMessage = message;
      onDiagnostic({ kind: "notice_error", message, occurredAt: new Date().toISOString() });
    };

    const deliver = async (notice: DesktopNotice): Promise<void> => {
      let delivery: NoticeDelivery | undefined;
      let failure: unknown;
      // Resolved either way, so the race below reports a winner rather than
      // rejecting: a helper that could not even start is a diagnostic, not an
      // exception for the turn loop above to catch.
      const running = send(notice, (child) => {
        active = child;
      }).then(
        (result) => {
          delivery = result;
        },
        (error: unknown) => {
          failure = error;
        },
      );

      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => resolve("deadline"), timeoutMs);
      });

      try {
        const winner = await Promise.race([running.then(() => "settled" as const), deadline]);
        if (winner === "deadline") {
          // Killed and abandoned rather than awaited. The child is gone, so
          // nothing is leaked, and waiting for it to notice would spend the
          // slot this deadline exists to free.
          active?.kill();
          report(`${program} did not finish within ${timeoutMs}ms; the notice was dropped`);
          return;
        }
        if (failure !== undefined) {
          report(`${program} could not run: ${describeErrorForAudit(failure)}`);
          return;
        }
        if (delivery !== undefined && delivery.exitCode === 0) {
          lastErrorMessage = null;
          return;
        }
        const exitCode = delivery?.exitCode ?? "no code";
        report(`${program} exited ${exitCode}: ${delivery?.stderr.trim() || "no stderr output"}`);
      } finally {
        clearTimeout(timer);
        active = null;
      }
    };

    /**
     * One delivery at a time, and the newest notice wins the slot.
     *
     * The same trade the agent turn loop makes one layer up: observations keep
     * arriving while a turn runs, and the *latest* world is the useful one, so a
     * queue of stale ones is worse than a replacement. A backlog of notices is
     * worse still — every one of them interrupts a person, and a burst that
     * emptied itself onto the desktop one popup at a time would be the interface
     * shouting about a past it has already moved on from.
     */
    const pump = (): void => {
      if (delivering !== null) return;
      const next = queued;
      queued = null;
      if (next === null) return;
      delivering = deliver(next).then(() => {
        delivering = null;
        pump();
      });
    };

    return {
      notify: (notice) => {
        if (closed) return;
        queued = notice;
        pump();
      },

      close: async () => {
        closed = true;
        // Dropped rather than flushed: a notice whose run is over has nothing
        // left to interrupt, and delivering it during shutdown would announce
        // something after the thing that could act on it is gone.
        queued = null;
        active?.kill();
        await delivering;
      },
    };
  };
}
