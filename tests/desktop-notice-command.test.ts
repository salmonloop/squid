import { describe, expect, it } from "bun:test";
import { commandDesktopNotifierFactory } from "../src/desktop-notice-command.js";
import type { NoticeDelivery, NoticeSender } from "../src/desktop-notice-command.js";
import type { DesktopNotice, DesktopNoticeDiagnostic } from "../src/desktop-notice.js";

/**
 * The shared half of every desktop notifier: one delivery at a time, a deadline
 * on each, one diagnostic per failure transition, and no child left behind.
 *
 * Driven by an injected sender rather than a real program, for the same reason
 * the subprocess readers are: the loop is what has the bugs, and a suite that
 * spawned `notify-send` would test whoever's machine ran it. The one thing this
 * cannot check is that the arguments are right — `desktop-notice-linux.test.ts`
 * owns that, and it needs no host either.
 */

interface PendingSend {
  readonly notice: DesktopNotice;
  settle(delivery: NoticeDelivery): void;
  fail(error: unknown): void;
  killed: boolean;
}

function fakeSender(): { readonly send: NoticeSender; readonly sends: PendingSend[] } {
  const sends: PendingSend[] = [];
  const send: NoticeSender = (notice, onSpawned) =>
    new Promise<NoticeDelivery>((resolve, reject) => {
      const pending: PendingSend = {
        notice,
        settle: resolve,
        fail: reject,
        killed: false,
      };
      sends.push(pending);
      onSpawned({
        kill: () => {
          pending.killed = true;
          // What a real child does when it is killed: it exits, and the sender
          // that was reading it resolves. A fake that ignored the kill would
          // make `close()` look like it hangs when the shape it is testing is
          // exactly the one that does not.
          resolve({ stderr: "", exitCode: 143 });
        },
      });
    });
  return { send, sends };
}

function notifierUnderTest(timeoutMs?: number): {
  readonly notify: (notice: DesktopNotice) => void;
  readonly close: () => Promise<void>;
  readonly sends: PendingSend[];
  readonly diagnostics: DesktopNoticeDiagnostic[];
} {
  const { send, sends } = fakeSender();
  const diagnostics: DesktopNoticeDiagnostic[] = [];
  const notifier = commandDesktopNotifierFactory({
    program: "fake-notify",
    send,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })({ onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
  return { notify: notifier.notify, close: notifier.close, sends, diagnostics };
}

/**
 * Lets the loop finish reacting to whatever just settled.
 *
 * Needed because `close()` suppresses the report from the delivery it kills, and
 * an outcome that has settled but not yet been reported is indistinguishable
 * from one the kill caused. That is the deliberate trade — inventing a failure on
 * every clean stop is worse than losing one line during shutdown — so a test
 * asserting a *real* failure has to let it land first, exactly as a run does.
 */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const NOTICE: DesktopNotice = { title: "Squid replied", body: "ran the tests; they pass" };

describe("commandDesktopNotifierFactory", () => {
  it("runs the command with the notice, and says nothing when it succeeds", async () => {
    const { notify, close, sends, diagnostics } = notifierUnderTest();
    notify(NOTICE);
    await Promise.resolve();
    expect(sends).toHaveLength(1);
    expect(sends[0]?.notice).toEqual(NOTICE);
    sends[0]?.settle({ stderr: "", exitCode: 0 });
    await close();
    expect(diagnostics).toEqual([]);
  });

  it("reports a non-zero exit with the program, the code, and its stderr", async () => {
    const { notify, close, sends, diagnostics } = notifierUnderTest();
    notify(NOTICE);
    await Promise.resolve();
    sends[0]?.settle({ stderr: "no daemon\n", exitCode: 1 });
    await settled();
    await close();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.kind).toBe("notice_error");
    expect(diagnostics[0]?.message).toBe("fake-notify exited 1: no daemon");
  });

  it("reports a sender that could not run at all", async () => {
    const { notify, close, sends, diagnostics } = notifierUnderTest();
    notify(NOTICE);
    await Promise.resolve();
    sends[0]?.fail(new Error("spawn fake-notify ENOENT"));
    await settled();
    await close();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("fake-notify could not run");
    expect(diagnostics[0]?.message).toContain("ENOENT");
  });

  /**
   * A desktop with no daemon fails identically forever, and a turn loop running
   * overnight must not write the same line a thousand times. The success in the
   * middle is what makes this a transition rather than a mute: a daemon that
   * comes back and goes away again is two events, not one.
   */
  it("collapses an unchanged failure and reports it again after a success", async () => {
    const { notify, close, sends, diagnostics } = notifierUnderTest();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      notify(NOTICE);
      await Promise.resolve();
      sends[attempt]?.settle({ stderr: "no daemon", exitCode: 1 });
      await settled();
    }
    expect(diagnostics).toHaveLength(1);

    notify(NOTICE);
    await Promise.resolve();
    sends[3]?.settle({ stderr: "", exitCode: 0 });
    await settled();

    notify(NOTICE);
    await Promise.resolve();
    sends[4]?.settle({ stderr: "no daemon", exitCode: 1 });
    await settled();
    await close();
    expect(diagnostics).toHaveLength(2);
  });
  /**
   * The deadline, which exists because a helper can block for minutes.
   *
   * Measured on a host with no notification daemon: `notify-send` asks D-Bus to
   * start the service and waits out `service_start_timeout=120000ms` before
   * exiting 1. Without a deadline that one call would hold the single delivery
   * slot through two hundred agent turns, and every notice in between would be
   * silently replaced — the failure would present as silence, not as an error.
   */
  it("kills a delivery that overruns its deadline and frees the slot", async () => {
    const { notify, close, sends, diagnostics } = notifierUnderTest(20);
    notify(NOTICE);
    await Promise.resolve();
    expect(sends).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sends[0]?.killed).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toBe("fake-notify did not finish within 20ms; the notice was dropped");

    // The point of killing it: the next notice is delivered rather than queued
    // behind a call that will never come back.
    notify({ title: "Squid replied", body: "second" });
    await Promise.resolve();
    expect(sends).toHaveLength(2);
    expect(sends[1]?.notice.body).toBe("second");
    sends[1]?.settle({ stderr: "", exitCode: 0 });
    await close();
  });

  /**
   * The newest notice wins the slot, and the ones it overtook are dropped.
   *
   * The same trade the agent turn loop makes one layer up: the latest world is
   * the useful one, so a queue of stale observations is worse than a
   * replacement. It is stronger here — a backlog would empty itself onto the
   * desktop one popup at a time, interrupting a person repeatedly about a past
   * Squid has already moved past.
   */
  it("delivers the newest queued notice and drops the ones it overtook", async () => {
    const { notify, close, sends } = notifierUnderTest();
    notify({ title: "Squid replied", body: "first" });
    await Promise.resolve();
    expect(sends).toHaveLength(1);

    notify({ title: "Squid replied", body: "second" });
    notify({ title: "Squid replied", body: "third" });
    expect(sends).toHaveLength(1);

    sends[0]?.settle({ stderr: "", exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sends).toHaveLength(2);
    expect(sends[1]?.notice.body).toBe("third");
    sends[1]?.settle({ stderr: "", exitCode: 0 });
    await close();
  });

  it("drops what it has not started, kills what it has, and stays shut", async () => {
    const { notify, close, sends, diagnostics } = notifierUnderTest();
    notify({ title: "Squid replied", body: "in flight" });
    await Promise.resolve();
    notify({ title: "Squid replied", body: "queued" });
    expect(sends).toHaveLength(1);

    await close();
    // The queued one never ran: a run that is over has nothing left for the
    // person to interrupt.
    expect(sends).toHaveLength(1);
    expect(sends[0]?.killed).toBe(true);

    notify({ title: "Squid replied", body: "after close" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sends).toHaveLength(1);
    // A killed delivery is shutdown, not a fault worth a line in the log.
    expect(diagnostics).toEqual([]);
  });
});
