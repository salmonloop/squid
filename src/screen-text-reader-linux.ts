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
 * `xdotool` is an X11 tool: under Wayland it fails, the exit code lands in a
 * diagnostic, and the reader keeps polling rather than dying — the same
 * degrade-don't-fail posture as every other backend. And the identity record is
 * all it can honestly produce: X11 exposes no focused-element role and no
 * selection text to a window-level query, so those fields stay absent and the
 * protocol's neutral values stand in. Reading focus and text on Linux is AT-SPI
 * work, and is a different backend, not a richer script.
 */
const FOREGROUND_SCRIPT = `
win=$(xdotool getactivewindow 2>/dev/null) || exit 1
pid=$(xdotool getwindowpid "$win" 2>/dev/null) || true
name=
if [ -n "$pid" ]; then name=$(ps -p "$pid" -o comm= 2>/dev/null || true); fi
title=$(xdotool getwindowname "$win" 2>/dev/null) || true
printf '%s\\x1f%s\\x1f%s\\n' "$pid" "$name" "$title"
`;

export interface LinuxScreenTextReaderOptions {
  /** Poll interval. Default 1000ms. */
  readonly pollMs?: number;
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
  if (process.platform !== "linux") {
    throw new Error(
      `The Linux screen text reader requires linux; this process reports ${process.platform}.`,
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
