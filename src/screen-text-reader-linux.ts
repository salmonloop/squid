import {
  parseIdentityFrame,
  pollingScreenTextReaderFactory,
} from "./screen-text-reader-subprocess.js";
import type { ScreenTextReaderFactory } from "./screen-text-source.js";

const DEFAULT_POLL_MS = 1_000;

/**
 * Queries the X11 foreground window with `xdotool`, emitting three
 * separator-joined fields: window pid, owning process name, window title.
 *
 * The separator is written as a POSIX **octal** escape, and that is not a style
 * choice. `/bin/sh` is `dash` on Debian and Ubuntu, whose `printf` implements only
 * the escapes POSIX requires — `\\x1f` is not among them, so it printed the four
 * characters `\\`, `x`, `1`, `f` and every field of every sample arrived fused into
 * one. The reader looked healthy: it produced a frame per poll, whose
 * `applicationId` was the whole record and whose name and title were gone.
 *
 * `xdotool` is an X11 tool: under Wayland it fails, the exit code lands in a
 * diagnostic, and the reader keeps polling rather than dying — the same
 * degrade-don't-fail posture as every other backend. And the identity record is
 * all it can honestly produce: X11 exposes no focused-element role and no
 * selection text to a window-level query, so those fields stay absent and the
 * protocol's neutral values stand in. Reading focus and text on Linux is AT-SPI
 * work, and is a different backend, not a richer script.
 */
export const FOREGROUND_SCRIPT = `
win=$(xdotool getactivewindow 2>/dev/null) || exit 1
pid=$(xdotool getwindowpid "$win" 2>/dev/null) || true
name=
if [ -n "$pid" ]; then name=$(ps -p "$pid" -o comm= 2>/dev/null || true); fi
title=$(xdotool getwindowname "$win" 2>/dev/null) || true
printf '%s\\037%s\\037%s\\n' "$pid" "$name" "$title"
`;

export interface LinuxScreenTextReaderOptions {
  /** Poll interval. Default 1000ms. */
  readonly pollMs?: number;
  /** The host to judge against. Defaults to this process; see the macOS reader. */
  readonly platform?: NodeJS.Platform;
}

/**
 * A `ScreenTextReaderFactory` backed by `xdotool` on X11.
 *
 * Throws immediately off Linux rather than degrading, because a caller that
 * reached this function on another platform chose the wrong backend and silence
 * would hide that. Like the macOS reader, this file needs a real host to be
 * verified end to end — CI exercises the seam and the parser, and the backend
 * itself is verified by hand with `SQUID_SCREEN_READER=linux bun run watch:screen`.
 */
export function createLinuxScreenTextReader(
  options: LinuxScreenTextReaderOptions = {},
): ScreenTextReaderFactory {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    throw new Error(
      `The Linux screen text reader requires linux; this process reports ${platform}.`,
    );
  }

  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  return pollingScreenTextReaderFactory({
    program: "xdotool",
    pollMs,
    parse: parseIdentityFrame,
    run: async (onSpawned) => {
      const child = Bun.spawn(["/bin/sh", "-c", FOREGROUND_SCRIPT], {
        stdout: "pipe",
        stderr: "pipe",
      });
      onSpawned(child);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, exitCode };
    },
  });
}
