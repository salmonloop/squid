import { spawn } from "node:child_process";

/**
 * What the visual smoke needs from the machine it runs on.
 *
 * The assertions in `ui-smoke.ts` are the test: a deferred decision must not
 * answer, a reopened one must come back, a declined one must send exactly one
 * answer, and a settled one must accept no second. None of that is
 * platform-specific. What *is* platform-specific is four mechanical things —
 * where a fixture can listen, how a window is found, how a control is pressed,
 * and how the result is photographed — so those four are the whole of this
 * interface and nothing else crosses it.
 *
 * One interface with two backends rather than two harnesses, for the reason the
 * screen readers are shaped the same way: a second copy of the assertions is a
 * second place for them to drift, and the one that drifts is the one nobody runs.
 *
 * The resolver lives in this file rather than its own `resolve-` module, unlike
 * `resolveScreenReader`: that one is shared by two entry points, and this one has
 * exactly one caller. A separate file would be a second import for no second
 * reader.
 */

/** The controls the smoke presses, named for intent rather than position. */
export type SmokeControl = "decline" | "later" | "allow" | "review";

/** A window on screen, in whatever pixels the host measures in. */
export interface SmokeWindow {
  /** The host's own handle for it, for logging and for follow-up calls. */
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SmokeHost {
  readonly kind: "x11" | "windows";
  /**
   * Where the fixture listens, in the shape this platform's panel can open: a
   * filesystem socket path on Unix, a named pipe on Windows. The smoke's own
   * temporary directory is offered because one platform wants a path inside it
   * and the other wants a name in a namespace that has no directories.
   */
  endpoint(directory: string): string;
  /**
   * Verifies prerequisites and starts anything the panel needs to draw into,
   * returning one line naming what it got. Called before the panel is spawned,
   * so a missing tool fails before there is a process to clean up.
   */
  prepare(): Promise<string>;
  /** What the panel needs in its environment to find this host's display. */
  panelEnvironment(): Readonly<Record<string, string>>;
  /**
   * The panel's window, once it is on screen.
   *
   * `processId` is the panel this run spawned, and whether a host needs it says
   * something about the desktop it works on: Windows shares one with everything
   * the person has open, so a search by title alone can return a Squid window
   * from another run — including a leaked one — and test it instead. Under a
   * private Xvfb no such window can exist, so that host may honestly ignore it.
   */
  awaitWindow(title: string, processId: number): Promise<SmokeWindow>;
  activate(window: SmokeWindow, control: SmokeControl): Promise<void>;
  screenshot(window: SmokeWindow, path: string): Promise<void>;
  /**
   * The status header's accessible description, or `null` when the panel
   * published none.
   *
   * Optional because it is a capability, not a requirement: reading text on
   * screen needs an accessibility client, which Windows has and a bare X server
   * does not. A host that omits it says so by omitting it, and the smoke skips
   * the assertions that need it out loud rather than pretending to make them.
   */
  readStatus?(window: SmokeWindow): Promise<string | null>;
  /** Releases whatever `prepare` acquired. Must be safe to call twice. */
  dispose(): Promise<void>;
}

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function smokeFailure(message: string): never {
  throw new Error(`ui:smoke failed — ${message}`);
}

export function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Runs a command to completion, capturing both streams.
 *
 * Never rejects: a command that could not be spawned reports `code: null`, which
 * every caller here already has to handle for a command that ran and failed. One
 * shape for both keeps the failure messages at the call site, where the caller
 * knows what it was asking for.
 *
 * A spawn failure puts its own message in `stderr`. Discarding it would leave
 * every such failure reading as a bare `null` exit — the least diagnosable thing
 * a harness can say about a tool it could not start.
 */
export function run(
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((done) => {
    const child = spawn(command, [...args], {
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: Error) => done({ code: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

const POLL_MS = 100;
export const STARTUP_TIMEOUT_MS = 15_000;
export const INTERACTION_TIMEOUT_MS = 5_000;

/**
 * Polls until an operation produces something, or the deadline passes.
 *
 * `null` means "not yet" rather than an exception, so a window that has not been
 * mapped is not reported as an error until it is actually too late to matter.
 */
export async function eventually<T>(
  description: string,
  operation: () => Promise<T | null>,
  timeoutMs = STARTUP_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value !== null) return value;
    await wait(POLL_MS);
  }
  return smokeFailure(`timed out waiting for ${description}`);
}

/**
 * Chooses the host backend for this machine.
 *
 * A refusal rather than a fallback on any other platform, for the same reason
 * `resolveScreenReader` refuses: a smoke run that silently did something other
 * than what it was asked looks exactly like one that worked. macOS is absent
 * because nobody has written it, and saying so is more useful than a driver that
 * throws halfway through a run.
 */
export async function resolveSmokeHost(
  platform: NodeJS.Platform = process.platform,
): Promise<SmokeHost> {
  if (platform === "linux") {
    const { createX11SmokeHost } = await import("./ui-smoke-host-x11.js");
    return createX11SmokeHost();
  }
  if (platform === "win32") {
    const { createWindowsSmokeHost } = await import("./ui-smoke-host-windows.js");
    return createWindowsSmokeHost();
  }
  return smokeFailure(
    `no visual smoke host for ${platform}; this check runs on Linux (Xvfb) or Windows (the interactive desktop).`,
  );
}
