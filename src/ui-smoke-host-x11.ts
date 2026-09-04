import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  eventually,
  run,
  smokeFailure,
  type SmokeControl,
  type SmokeHost,
  type SmokeWindow,
} from "./ui-smoke-host.js";

/**
 * The X11 smoke host: Xvfb for a display, a private session bus for the panel's
 * accessibility, xdotool and xwininfo for the window, ffmpeg for the picture.
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

/**
 * The AT-SPI cache query that reads the panel's accessibility tree in one call.
 *
 * `--json=short` so the reply parses without a D-Bus type system: the signature
 * `a((so)(so)(so)iiassusau)` is nested GVariant that no shell tool decodes, but
 * every node's `name` and `description` land in the JSON as plain strings, and
 * `readStatus` finds the one node the header owns by its accessible name.
 */
const CACHE_SCRIPT = `
address=$(busctl --user call org.a11y.Bus /org/a11y/bus org.a11y.Bus GetAddress 2>/dev/null | sed 's/^s "//; s/"$//') || exit 1
for peer in $(busctl --address="$address" list --no-legend 2>/dev/null | awk '$3 == "squid-ui" {print $1}'); do
  busctl --address="$address" --json=short call \\
    "$peer" /org/a11y/atspi/cache org.a11y.atspi.Cache GetItems 2>/dev/null && exit 0
done
exit 1
`;

/**
 * One AT-SPI cache item, narrowed to the fields this check reads.
 *
 * The full reply type is `a((so)(so)(so)iiassusau)` — three references, two
 * ints, interfaces, name, a number, description, and states — but only the
 * position of the two strings matters here, and their positions come from the
 * measured reply on this machine, not from the spec: element 6 is the
 * accessible name ("Squid status"), element 8 the accessible description.
 */
type CacheItem = readonly [
  unknown,
  unknown,
  unknown,
  number,
  number,
  readonly string[],
  string,
  number,
  string,
  readonly unknown[],
];

async function requireCommand(command: string, packageHint: string): Promise<void> {
  if ((await run("sh", ["-c", `command -v ${command}`])).code !== 0) {
    smokeFailure(`${command} is not installed; install ${packageHint}, then rerun \`bun run ui:smoke\`.`);
  }
}

/**
 * Waits for a file to exist and hold something, then returns its content.
 *
 * The session bus announces its address through this channel instead of a pipe:
 * the process that keeps the bus alive (`sleep infinity`, exec'd by the wrapper)
 * would otherwise inherit that pipe's write end and hold it open for the life of
 * the bus — which is longer than the run is willing to wait, and long enough
 * that an orphaned keeper once kept a finished smoke run from ever exiting.
 */
const waitForFile = async (path: string): Promise<string> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const content = await readFile(path, "utf8").catch(() => null);
    if (content !== null && content.trim().length > 0) return content;
    await new Promise((done) => setTimeout(done, 50));
  }
  return smokeFailure(`nothing was ever written to ${path}`);
};

/**
 * Reads one line from a child's stdout, then severs the pipe.
 *
 * `-displayfd 1` writes the chosen display number and never writes again, so
 * once the line has arrived the pipe has served its purpose; the child is
 * detached, and a pipe left hanging off a long-lived detached child is the
 * same exit-hang the bus address had. Any late write from the child hits a
 * closed pipe and dies loudly rather than sitting unheard.
 */
const readFirstLine = async (child: ChildProcess, what: string): Promise<string> => {
  const line = await new Promise<string>((done, reject) => {
    let buffer = "";
    const onExit = (code: number | null): void =>
      reject(new Error(`${what} exited before writing anything (code ${code ?? "signal"})`));
    child.once("error", () => reject(new Error(`${what} could not be started`)));
    child.once("exit", onExit);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/^(.*)\n/);
      if (match?.[1] !== undefined) {
        child.removeListener("exit", onExit);
        done(match[1]);
      }
    });
  });
  child.stdout?.destroy();
  return line;
};

/**
 * Signals a child's whole process group, not just the child itself.
 *
 * Both long-lived children are spawned `detached`, so each leads its own group
 * and everything it starts or activates — the D-Bus daemon, the at-spi pair the
 * bus pulls in by activation — is born into that group. `child.kill` reaches
 * only the leader and orphans the rest; a group signal is what actually tears
 * the family down. A missing group means it is already gone, which is the
 * outcome the signal was reaching for anyway.
 */
const stopGroup = (child: ChildProcess | undefined, signal: NodeJS.Signals): void => {
  if (child?.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone; that is what the signal was for.
  }
};

export function createX11SmokeHost(): SmokeHost {
  let display: string | undefined;
  let server: ChildProcess | undefined;
  let bus: ChildProcess | undefined;
  let busAddress: string | undefined;
  let addressFile: string | undefined;

  const displayEnvironment = (): NodeJS.ProcessEnv => {
    if (display === undefined) smokeFailure("the X display was used before it was started");
    return { ...process.env, DISPLAY: display };
  };

  const busEnvironment = (): NodeJS.ProcessEnv => {
    if (busAddress === undefined) smokeFailure("the session bus was used before it was started");
    return { ...process.env, DBUS_SESSION_BUS_ADDRESS: busAddress };
  };

  // The last line of defence against the run that hung: if the process is
  // leaving through any path that skips dispose — an uncaught throw, a signal —
  // the two detached groups would otherwise outlive it, holding the pipes and
  // the display that made the last run unkillable. One pass with SIGKILL, no
  // await, no error reporting: this is cleanup, not the run's voice.
  process.on("exit", () => {
    stopGroup(server, "SIGKILL");
    stopGroup(bus, "SIGKILL");
  });

  return {
    kind: "x11",

    endpoint: (directory: string) => join(directory, "panel.sock"),

    prepare: async () => {
      await requireCommand("Xvfb", "the Xvfb package");
      await requireCommand("xdotool", "the xdotool package");
      await requireCommand("xwininfo", "the x11-utils package");
      await requireCommand("ffmpeg", "the ffmpeg package");
      await requireCommand("dbus-run-session", "the dbus-user-session or dbus-x11 package");
      await requireCommand("busctl", "the systemd package");

      // One session bus for this run. The panel's AccessKit adapter joins the
      // a11y side of this bus; without it there is no accessibility
      // infrastructure to join and `readStatus` would have nothing to ask.
      //
      // Three measures here, all paid for by a run that hung. The address is
      // written to a temp file rather than a pipe, because the first version
      // piped `printf` and then `exec`'d into `sleep infinity` on the same
      // stdout — and a keeper that inherits the pipe and outlives the wrapper
      // keeps that pipe open forever, so the run that failed in `readStatus`
      // hung with its own error message locked inside buffered output. The
      // keeper runs `detached`, its own process group, because D-Bus
      // activation puts its children in the wrapper's group: killing the
      // wrapper alone left the dbus-daemon and the at-spi pair orphaned and
      // alive, while `process.kill(-pid)` takes the whole family. And `unref`
      // lets this process exit even if dispose is somehow skipped.
      const addressPath = join(tmpdir(), `squid-smoke-bus-${process.pid}`);
      addressFile = addressPath;
      bus = spawn(
        "dbus-run-session",
        ["--", "bash", "-c", 'printf "%s\\n" "$DBUS_SESSION_BUS_ADDRESS" > "$1"; exec sleep infinity', "bash", addressPath],
        { stdio: "ignore", detached: true },
      );
      bus.unref();
      const address = (await waitForFile(addressPath)).trim();
      if (!address.startsWith("unix:")) {
        smokeFailure(`the session bus published a nonsense address: ${JSON.stringify(address)}`);
      }
      busAddress = address;

      const xvfb = spawn(
        "Xvfb",
        ["-displayfd", "1", "-screen", "0", "1280x1024x24", "-nolisten", "tcp"],
        { stdio: ["ignore", "pipe", "ignore"], detached: true },
      );
      xvfb.unref();
      server = xvfb;
      display = `:${(await readFirstLine(xvfb, "Xvfb")).trim()}`;

      // Reading the header needs the accessibility infrastructure on this bus,
      // and it arrives by D-Bus activation — nobody has to start it. But it
      // stays dormant until `org.a11y.Status.IsEnabled` is true, which is what
      // a screen reader does on a real desktop. Flipping it here, before the
      // panel exists, means the panel's first tree lands on an activated bus.
      // The interface is `org.a11y.Status`, not `org.a11y.Bus` — the property
      // lives one interface over from the one whose name the bus answers to.
      const flip = await run(
        "busctl",
        ["--user", "set-property", "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Status", "IsEnabled", "b", "true"],
        busEnvironment(),
      );
      if (flip.code !== 0) {
        smokeFailure(`could not enable accessibility on the session bus: ${flip.stderr.trim() || "busctl failed"}`);
      }
      return `display ${display}, session bus with accessibility enabled`;
    },

    panelEnvironment: () => {
      if (display === undefined) smokeFailure("the panel environment was read before Xvfb started");
      if (busAddress === undefined) smokeFailure("the panel environment was read before the bus started");
      return { DISPLAY: display, DBUS_SESSION_BUS_ADDRESS: busAddress };
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

    /**
     * The header's accessible description, read the way a screen reader reads it.
     *
     * The panel's AccessKit adapter publishes its tree onto the session bus once
     * `org.a11y.Status.IsEnabled` is true, and this run flipped that switch in
     * `prepare`. What is left is to ask for the tree — and the AT-SPI cache
     * answers in one call with the whole thing, nodes included, so no walking
     * the hierarchy node by node.
     *
     * Polled with `eventually` rather than read once: the tree can land later
     * than the window maps, and a single read at map time would report "nothing
     * published" for a panel that simply had not finished. Returning `null` from
     * the poll means "not yet"; the deadline covers the honest failure.
     *
     * The JSON reply parses without a D-Bus type system: `data` holds the
     * method's one out parameter — the node list itself — and each cache
     * item's element 6 is the accessible name and element 8 the accessible
     * description. Finding by name rather than by path — the node ids are
     * generated, the label is the stable thing.
     */
    readStatus: async () =>
      eventually("the panel's accessibility tree on the session bus", async () => {
        const dump = await run("sh", ["-c", CACHE_SCRIPT], busEnvironment());
        if (dump.code !== 0) return null;
        try {
          // `data` wraps the out parameter: one element, the node list itself.
          const reply = JSON.parse(dump.stdout) as { data?: CacheItem[][] };
          const nodes = reply.data?.[0] ?? [];
          const header = nodes.find((item) => item[6] === "Squid status");
          const description = header?.[8]?.trim();
          return description === undefined || description.length === 0 ? null : description;
        } catch {
          // A truncated or foreign reply is "cannot read yet", not a crash: the
          // next poll repeats the whole question.
          return null;
        }
      }),

    /**
     * Tears down both process groups — Xvfb's, then the bus keeper's, in the
     * order they were acquired. The group signal is what makes this one call
     * enough: the bus's group contains the keeper, the daemon, and everything
     * activation started, so nothing survives to inherit a pipe or a display.
     * If the process dies between SIGTERM and this point, the `exit` hook
     * below repeats the question with SIGKILL.
     */
    dispose: async () => {
      stopGroup(server, "SIGTERM");
      server = undefined;
      stopGroup(bus, "SIGTERM");
      bus = undefined;
      busAddress = undefined;
      if (addressFile !== undefined) await rm(addressFile, { force: true }).catch(() => undefined);
    },
  };
}
