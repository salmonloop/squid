import { commandDesktopNotifierFactory } from "./desktop-notice-command.js";
import type { DesktopNotice, DesktopNotifierFactory } from "./desktop-notice.js";

/**
 * Speaking up on macOS, through `osascript` and Notification Center.
 *
 * **The messenger is visible, and that is the honest cost of working without an
 * installer — the same trade the Windows balloon already accepted.** Notification
 * Center attributes a notice to the bundle that sent it, and Squid ships as a
 * zip with no bundle; `osascript` is a command-line tool with a bundle of its
 * own, so the notice reads "Script Editor" (or "osascript", by OS version) as
 * its sender. The title and body are Squid's words; what the attribution line
 * names is the messenger. The routes without that cost all need something Squid
 * does not have: a signed .app bundle to register an identity, or a
 * UserNotifications session that only a bundled process can host. When one of
 * those arrives, this file is what gets replaced — the same sentence the
 * Windows backend ends on.
 *
 * `osascript` rather than the Swift bridge it implies, because the bridge is
 * the easy half to get wrong: UNUserNotificationCenter requires a running app
 * with an identity and a delegate on the main thread, and holding all of that
 * for the sake of a byline is not this dependency budget. A helper every Mac
 * already ships is the cheaper correct answer, and it is the same trade the
 * Linux backend makes with `notify-send`: the platform's own tool, spawned.
 *
 * **No sound flag, no critical alert.** How loudly a notice arrives and how it
 * behaves in Focus and Do Not Disturb are the user's own settings to make in
 * System Settings; a program that pinned them has decided something it was not
 * asked to decide — the same rule the Linux backend states about urgency, and
 * `display notification ... with sound` would break it the first time a person
 * had their Mac muted for a reason.
 */

const PROGRAM = "osascript";

/**
 * The fixed script one delivery runs.
 *
 * Everything in it is constant. The notice itself never touches the AppleScript
 * source: a title containing a quote, a backslash, or a `"` character must be
 * a title, not a script, and the arguments after `--` arrive as *data* in the
 * run handler's parameter list — AppleScript never reparses them. That is the
 * same injection the Windows backend removes rather than escapes, arrived at
 * by the platform's own argv mechanism instead of a stdin JSON round trip.
 */
export const noticeScript =
  "on run {theTitle, theBody}\n" +
  "display notification theBody with title theTitle\n" +
  "end run";

/** The interpreter's own flags, before the script. */
export const noticeArguments: readonly string[] = ["-e"];

/**
 * The argument list for one notice, script and payload together.
 *
 * Separate and exported because it is the part worth asserting: no host is
 * needed to check that a body which happens to start with a dash is still a
 * body. `--` is load-bearing the same way it is for `notify-send` — osascript
 * uses getopt, so a title beginning `-` would otherwise be read as a flag, and
 * a model summarising its work routinely starts with a dash because a list is
 * how it writes.
 */
export function noticeArgumentList(notice: DesktopNotice): readonly string[] {
  // A fresh array every call: the spawn owns its argv, and a shared array a
  // caller could mutate would make one notice's flags the next one's.
  return [PROGRAM, ...noticeArguments, noticeScript, "--", notice.title, notice.body];
}

/**
 * How long one delivery may take before it is killed and reported.
 *
 * The mechanism's own default of five seconds bounds it: a process spawn plus
 * an AppleScript compile is well under a second on a healthy host, and the
 * deadline exists to catch a hung one, not to budget a working one.
 */
export interface MacosDesktopNotifierOptions {
  readonly platform?: NodeJS.Platform;
  /** Overridden in tests; the mechanism's own default is right in production. */
  readonly timeoutMs?: number;
}

export function createMacosDesktopNotifier(
  options: MacosDesktopNotifierOptions = {},
): DesktopNotifierFactory {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error(
      `The macOS desktop notifier requires darwin; this process reports ${platform}.`,
    );
  }

  return commandDesktopNotifierFactory({
    program: PROGRAM,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    send: async (notice, onSpawned) => {
      // `Bun.spawn` takes a mutable array; the fresh array above is exactly
      // why the cast is safe — nothing else holds a reference to it.
      const argv = [...noticeArgumentList(notice)];
      const child = Bun.spawn(argv, {
        // Nothing is read from stdout, and a pipe nobody reads is a buffer
        // that can fill — the same rule the Linux backend states.
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
