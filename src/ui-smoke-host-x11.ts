import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import {
  eventually,
  run,
  smokeFailure,
  type SmokeControl,
  type SmokeHost,
  type SmokeWindow,
} from "./ui-smoke-host.js";

/**
 * The X11 smoke host: Xvfb for a display, xdotool and xwininfo for the window,
 * ffmpeg for the picture.
 *
 * Moved here from `ui-smoke.ts` when Windows got a host of its own; the commands,
 * the flags, and the measured button positions are unchanged, because they were
 * measured on a real machine and re-deriving them would be re-doing the one part
 * of this file that cannot be reasoned out.
 */

/**
 * Where the three confirmation buttons sit, in window-relative pixels.
 *
 * Coordinates, and not the keyboard, because a keyboard is not available here:
 * under a bare Xvfb there is no window manager to give the window focus, so
 * `xdotool key` is delivered to nothing and every key press silently does
 * nothing. Measured on this machine: a synthetic click lands and answers, a
 * synthetic Return does not.
 *
 * That is also why this file cannot assert the no-default-button rule. A Return
 * that produces no answer here proves only that no key arrived, which would be a
 * pass for the wrong reason — the honest thing is to leave the claim to the Slint
 * source, where no button is `primary` and none is given focus, and to say so
 * rather than to fake the measurement.
 *
 * A hardcoded position is a real cost, and it is bounded: each entry asserts
 * which answer it produced, so a layout change that moves a button makes the
 * expected answer wrong or absent. It cannot silently hit a neighbour and pass.
 *
 * The Windows host needs no such table — UI Automation gives it each control's
 * own rectangle — which is a difference in what the two platforms make available,
 * not a disagreement about what is being tested.
 */
const CONTROL_POSITION: Record<SmokeControl, { readonly x: number; readonly y: number }> = {
  decline: { x: 426, y: 307 },
  later: { x: 504, y: 307 },
  allow: { x: 574, y: 307 },
  // The Review button on the deferred notice, which takes the place of the card.
  review: { x: 574, y: 200 },
};

async function requireCommand(command: string, packageHint: string): Promise<void> {
  if ((await run("sh", ["-c", `command -v ${command}`])).code !== 0) {
    smokeFailure(`${command} is not installed; install ${packageHint}, then rerun \`bun run ui:smoke\`.`);
  }
}

export function createX11SmokeHost(): SmokeHost {
  let display: string | undefined;
  let server: ChildProcess | undefined;

  const displayEnvironment = (): NodeJS.ProcessEnv => {
    if (display === undefined) smokeFailure("the X display was used before it was started");
    return { ...process.env, DISPLAY: display };
  };

  return {
    kind: "x11",

    endpoint: (directory: string) => join(directory, "panel.sock"),

    prepare: async () => {
      await requireCommand("Xvfb", "the Xvfb package");
      await requireCommand("xdotool", "the xdotool package");
      await requireCommand("xwininfo", "the x11-utils package");
      await requireCommand("ffmpeg", "the ffmpeg package");

      const started = spawn(
        "Xvfb",
        ["-displayfd", "1", "-screen", "0", "1280x1024x24", "-nolisten", "tcp"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      server = started;
      display = await new Promise<string>((done, reject) => {
        let output = "";
        started.once("error", () => reject(new Error("could not start Xvfb")));
        started.once("exit", (code) =>
          reject(new Error(`Xvfb exited before selecting a display (code ${code ?? "signal"})`)),
        );
        started.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          const line = output.match(/^\s*(\d+)\s*\n/);
          if (line?.[1] !== undefined) done(`:${line[1]}`);
        });
      });
      return `display ${display}`;
    },

    panelEnvironment: () => {
      if (display === undefined) smokeFailure("the panel environment was read before Xvfb started");
      return { DISPLAY: display };
    },

    /**
     * `processId` is deliberately unused. This host owns the display it searches:
     * Xvfb is started by `prepare` for this run alone, so the only Squid window
     * that can exist on it is the one this run spawned. Filtering by pid would
     * mean reading `_NET_WM_PID` through another tool on the prerequisite list to
     * rule out a window that cannot be there.
     */
    awaitWindow: (title: string, _processId: number) =>
      eventually("a mapped Squid window", async () => {
        const env = displayEnvironment();
        const found = await run("xdotool", ["search", "--name", `^${title}$`], env);
        for (const id of found.stdout.trim().split(/\s+/)) {
          if (id.length === 0) continue;
          const info = await run("xwininfo", ["-id", id], env);
          if (info.code !== 0 || !info.stdout.includes("IsViewable")) continue;
          const read = (label: string): number | null => {
            const match = info.stdout.match(new RegExp(`${label}:\\s+(-?\\d+)`));
            return match?.[1] === undefined ? null : Number(match[1]);
          };
          const x = read("Absolute upper-left X");
          const y = read("Absolute upper-left Y");
          const width = read("Width");
          const height = read("Height");
          if (x === null || y === null || width === null || height === null) continue;
          return { id, x, y, width, height };
        }
        return null;
      }),

    activate: async (window: SmokeWindow, control: SmokeControl) => {
      const at = CONTROL_POSITION[control];
      const result = await run(
        "xdotool",
        ["mousemove", "--window", window.id, String(at.x), String(at.y), "click", "1"],
        displayEnvironment(),
      );
      if (result.code !== 0) {
        smokeFailure(
          `could not click ${control} at ${at.x},${at.y}: ${result.stderr.trim() || "xdotool failed"}`,
        );
      }
    },

    /**
     * Screenshot of one window, cropped to exactly that window's geometry.
     *
     * `ffmpeg -f x11grab` rather than ImageMagick's `import`: the same tool is
     * already the repo's image converter, and its `+x,y` offset plus
     * `-video_size` crop to the window without a second process. `import
     * -window` would be one call, but it puts ImageMagick on the prerequisite
     * list for a check whose whole job is to be runnable.
     *
     * Cropping rather than grabbing the whole root: under a bare Xvfb there is
     * no window manager, so the rest of the screen is uninitialised noise that
     * would dominate any visual review of the panel itself.
     */
    screenshot: async (window: SmokeWindow, path: string) => {
      if (display === undefined) smokeFailure("a screenshot was taken before Xvfb started");
      const result = await run("ffmpeg", [
        "-loglevel", "error",
        "-f", "x11grab",
        "-video_size", `${window.width}x${window.height}`,
        "-i", `${display}+${window.x},${window.y}`,
        "-frames:v", "1",
        "-y", path,
      ]);
      if (result.code !== 0) {
        smokeFailure(`could not save ${path}: ${result.stderr.trim() || "ffmpeg x11grab failed"}`);
      }
    },

    dispose: async () => {
      if (server !== undefined && server.exitCode === null && !server.killed) {
        server.kill("SIGTERM");
      }
      server = undefined;
    },
  };
}
