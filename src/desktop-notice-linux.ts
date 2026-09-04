import { commandDesktopNotifierFactory } from "./desktop-notice-command.js";
import type { DesktopNotice, DesktopNotifierFactory } from "./desktop-notice.js";

/**
 * Speaking up on a freedesktop desktop, through `notify-send`.
 *
 * `notify-send` rather than the D-Bus call it makes, because the call is the
 * easy half: `org.freedesktop.Notifications.Notify` takes `susssasa{sv}i`, and
 * reaching it without a library means the SASL handshake and the whole
 * marshalling layer in a process whose one dependency budget is already spent.
 * A helper that every desktop already ships is the cheaper correct answer, and
 * it is the same trade the screen readers make: the platform's own tool, spawned.
 *
 * **Where the popup appears is not ours to choose, and that is by design.** The
 * notification spec describes passive popups and says nothing about placement:
 * the daemon decides, per desktop and per user preference, and it is also what
 * honours do-not-disturb and keeps a missed notice in a history. Asking for a
 * corner would mean drawing our own window, which would give up all three.
 */

const PROGRAM = "notify-send";

/**
 * The argument list for one notice.
 *
 * Separate and exported because it is the part worth asserting: a host is not
 * needed to check that a body which happens to start with a dash is still a
 * body.
 *
 * **`--` is load-bearing, not defensive.** Measured: `notify-send "-weird" "x"`
 * fails with `Error parsing option -r` — the summary was read as the short flags
 * `-w -e -i -r -d`. An agent reply routinely starts with a dash, because a list
 * is how a model summarises what it did, so without the terminator the notices
 * most worth reading are exactly the ones that would silently fail.
 *
 * `--app-name` so the desktop can say who spoke; no `--urgency` and no
 * `--expire-time`, because both are the user's setting to make in their own
 * notification preferences, and a program that pins them has decided something
 * it was not asked to decide.
 */
export function notifySendArguments(notice: DesktopNotice): readonly string[] {
  return ["--app-name=Squid", "--", notice.title, notice.body];
}

export interface LinuxDesktopNotifierOptions {
  readonly platform?: NodeJS.Platform;
  /** Overridden in tests; the mechanism's own default is right in production. */
  readonly timeoutMs?: number;
}

export function createLinuxDesktopNotifier(
  options: LinuxDesktopNotifierOptions = {},
): DesktopNotifierFactory {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    throw new Error(
      `The Linux desktop notifier requires linux; this process reports ${platform}.`,
    );
  }

  return commandDesktopNotifierFactory({
    program: PROGRAM,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    send: async (notice, onSpawned) => {
      // stdout is ignored rather than piped: `notify-send` prints an id only when
      // asked, and a pipe nobody reads is a buffer that can fill.
      const child = Bun.spawn([PROGRAM, ...notifySendArguments(notice)], {
        stdout: "ignore",
        stderr: "pipe",
      });
      onSpawned(child);
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stderr, exitCode };
    },
  });
}
