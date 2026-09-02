/**
 * Visual smoke harness for the resident Slint panel.
 *
 * This drives the compiled `squid-ui` binary, a Unix-socket fixture speaking
 * the production newline-delimited wire, and Xvfb/xdotool. It is intentionally
 * outside the ordinary offline suite.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const POLL_MS = 100;
const STARTUP_TIMEOUT_MS = 15_000;
const INTERACTION_TIMEOUT_MS = 5_000;
const WINDOW_TITLE = "Squid";
/** The prompt the fixture raises, and the only id an answer may name. */
const PROMPT_ID = 41;

interface CommandResult { readonly code: number | null; readonly stdout: string; readonly stderr: string }
interface PanelReply { readonly type?: unknown; readonly op?: unknown; readonly promptId?: unknown; readonly answer?: unknown }
interface WindowGeometry { readonly id: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
interface Fixture {
  readonly socketPath: string;
  readonly replies: readonly PanelReply[];
  readonly close: () => Promise<void>;
  waitFor(description: string, predicate: (reply: PanelReply) => boolean, timeoutMs?: number): Promise<PanelReply>;
}

const log = (line: string): void => { process.stdout.write(`${line}\n`); };
function fail(message: string): never { throw new Error(`ui:smoke failed — ${message}`); }
function wait(ms: number): Promise<void> { return new Promise((done) => setTimeout(done, ms)); }

async function eventually<T>(description: string, operation: () => Promise<T | null>, timeoutMs = STARTUP_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value !== null) return value;
    await wait(POLL_MS);
  }
  return fail(`timed out waiting for ${description}`);
}

function run(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((done) => {
    const child = spawn(command, args, { env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", () => done({ code: null, stdout, stderr }));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

async function requireCommand(command: string, packageHint: string): Promise<void> {
  if ((await run("sh", ["-c", `command -v ${command}`])).code !== 0) {
    fail(`${command} is not installed; install ${packageHint}, then rerun \`bun run ui:smoke\`.`);
  }
}

function stop(child: ChildProcess | undefined): void {
  if (child !== undefined && child.exitCode === null && !child.killed) child.kill("SIGTERM");
}

async function startDisplay(): Promise<{ readonly display: string; readonly server: ChildProcess }> {
  const server = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1280x1024x24", "-nolisten", "tcp"], { stdio: ["ignore", "pipe", "pipe"] });
  const display = await new Promise<string>((done, reject) => {
    let output = "";
    server.once("error", () => reject(new Error("could not start Xvfb")));
    server.once("exit", (code) => reject(new Error(`Xvfb exited before selecting a display (code ${code ?? "signal"})`)));
    server.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.match(/^\s*(\d+)\s*\n/);
      if (line?.[1] !== undefined) done(`:${line[1]}`);
    });
  });
  return { display, server };
}

function panelFixture(socketPath: string): Promise<Fixture> {
  return new Promise((done, reject) => {
    const replies: PanelReply[] = [];
    const clients = new Set<Socket>();
    const server: Server = createServer((socket) => {
      clients.add(socket);
      let buffer = "";
      const send = (message: Record<string, unknown>): void => { socket.write(`${JSON.stringify(message)}\n`); };
      const announce = (): void => {
        // Current protocol states: both service outcomes, unavailable source,
        // and a prompt only because this wire revision implements it.
        send({ type: "service", agentState: "needs_config" });
        send({ type: "service", agentState: "ready" });
        send({ type: "world_state", updatedAt: "2026-09-01T12:00:00.000Z", lastEvent: "file_saved", application: "Smoke Fixture", window: "panel-smoke.ts", gate: "open", selectionLength: 7, recentActions: "file_saved", episodeEvents: 1 });
        send({ type: "agent", at: "2026-09-01T12:00:01.000Z", status: "replied", text: "Smoke fixture connected." });
        send({ type: "prompt", promptId: PROMPT_ID, kind: "run_tests", summary: "bun test", expiresAt: "2026-09-01T12:05:00.000Z" });
      };
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) {
            try {
              const reply = JSON.parse(line) as PanelReply;
              replies.push(reply);
              if (reply.type === "subscribe") announce();
              if (reply.type === "config_get") { for (const row of CONFIG_ROWS) send(row); send({ type: "config_end", count: CONFIG_ROWS.length }); }
              if (reply.type === "source_get") { for (const row of SOURCE_ROWS) send(row); send({ type: "source_end", count: SOURCE_ROWS.length }); }
            } catch { /* Production server refuses malformed input; fixture does not invent a reply. */ }
          }
          newline = buffer.indexOf("\n");
        }
      });
      socket.on("close", () => clients.delete(socket));
    });
    server.once("error", reject);
    server.listen(socketPath, () => done({
      socketPath, replies,
      close: async () => {
        for (const client of clients) client.destroy();
        await new Promise<void>((closed) => server.close(() => closed()));
        await rm(socketPath, { force: true });
      },
      waitFor: (description, predicate, timeoutMs = INTERACTION_TIMEOUT_MS) => eventually(description, async () => replies.find(predicate) ?? null, timeoutMs),
    }));
  });
}

/**
 * The panel window's id and absolute geometry, once it is actually on screen.
 *
 * `IsViewable` rather than mere existence: `xdotool search` keeps matching a
 * window after it is unmapped, so presence is not the question. Geometry is
 * read from the same `xwininfo` call that proved viewability, because a second
 * call could land after a resize and crop the screenshot to the wrong box.
 */
async function awaitWindow(display: string): Promise<WindowGeometry> {
  const env = { ...process.env, DISPLAY: display };
  return eventually("a mapped Squid window", async () => {
    const found = await run("xdotool", ["search", "--name", `^${WINDOW_TITLE}$`], env);
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
  });
}

/**
 * Screenshot of one window, cropped to exactly that window's geometry.
 *
 * `ffmpeg -f x11grab` rather than ImageMagick's `import`: the same tool is
 * already the repo's image converter, and its `+x,y` offset plus `-video_size`
 * crop to the window without a second process. `import -window` would be one
 * call, but it puts ImageMagick on the prerequisite list for a check whose
 * whole job is to be runnable.
 *
 * Cropping rather than grabbing the whole root: under a bare Xvfb there is no
 * window manager, so the rest of the screen is uninitialised noise that would
 * dominate any visual review of the panel itself.
 */
async function screenshot(display: string, geometry: WindowGeometry, path: string): Promise<void> {
  const result = await run("ffmpeg", [
    "-loglevel", "error",
    "-f", "x11grab",
    "-video_size", `${geometry.width}x${geometry.height}`,
    "-i", `${display}+${geometry.x},${geometry.y}`,
    "-frames:v", "1",
    "-y", path,
  ]);
  if (result.code !== 0) fail(`could not save ${path}: ${result.stderr.trim() || "ffmpeg x11grab failed"}`);
}

/** How long to wait for an answer that must NOT arrive. Short: absence is the assertion. */
const NEGATIVE_WAIT_MS = 700;

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
 */
const BUTTONS = {
  decline: { x: 426, y: 307 },
  later: { x: 504, y: 307 },
  allow: { x: 574, y: 307 },
} as const;

/** The Review button on the deferred notice, which takes the place of the card. */
const REVIEW = { x: 574, y: 200 } as const;

/**
 * The settings dump the fixture serves.
 *
 * Grouped, described, and deliberately not contiguous by group — the real schema
 * interleaves them, so a renderer that detected runs instead of bucketing by
 * value would pass against a tidier fixture and fail against the brain. One
 * secret row carries `secretPresent` so the screenshots show a stored credential
 * reading as stored rather than as an empty box.
 */
const CONFIG_ROWS: readonly Record<string, unknown>[] = [
  { type: "config", id: "modelId", label: "Model", kind: "text", value: "gpt-5", applies: "restart", group: "Model", description: "Which model answers when Squid needs to think." },
  { type: "config", id: "apiKey", label: "API key", kind: "secret", value: "", applies: "restart", group: "Model", description: "Lets Squid reach the model. Stored by Pi, never shown here.", secretPresent: 1 },
  { type: "config", id: "watchRoot", label: "Watched folder", kind: "text", value: "/home/you/project", applies: "restart", group: "Files", description: "The folder Squid notices changes in." },
  { type: "config", id: "retentionHours", label: "Keep activity for", kind: "int", value: "24", applies: "restart", group: "History", description: "How long Squid keeps what it recorded before deleting it." },
  { type: "config", id: "screenReader", label: "Screen reading", kind: "enum", value: "", applies: "restart", group: "Screen", description: "How Squid reads the words on screen.", values: "linux" },
  { type: "config", id: "excludeApplications", label: "Never watch these apps", kind: "text", value: "1Password", applies: "restart", group: "Privacy", description: "Squid records nothing at all from the apps you list." },
  { type: "config", id: "databasePath", label: "Where history is kept", kind: "text", value: "", applies: "restart", group: "History", description: "The file Squid writes its record to. Empty keeps it in memory only." },
];

/** The catalog the fixture serves: one running, one off, one that needs setting up. */
const SOURCE_ROWS: readonly Record<string, unknown>[] = [
  { type: "source", id: "filesystem-local", label: "Files", state: "running" },
  { type: "source", id: "screen-text-host", label: "Screen", state: "running" },
  { type: "source", id: "browser-page-host", label: "Browser", state: "unsupported" },
];

/** Whether any answer for this prompt has reached the fixture yet. */
function answerFor(fixture: Fixture, promptId: number): PanelReply | undefined {
  return fixture.replies.find((reply) => reply.type === "answer" && reply.promptId === promptId);
}

async function click(display: string, windowId: string, at: { readonly x: number; readonly y: number }): Promise<void> {
  const result = await run(
    "xdotool",
    ["mousemove", "--window", windowId, String(at.x), String(at.y), "click", "1"],
    { ...process.env, DISPLAY: display },
  );
  if (result.code !== 0) fail(`could not click at ${at.x},${at.y}: ${result.stderr.trim() || "xdotool failed"}`);
}

async function main(): Promise<void> {
  await requireCommand("Xvfb", "the Xvfb package");
  await requireCommand("xdotool", "the xdotool package");
  await requireCommand("xwininfo", "the x11-utils package");
  await requireCommand("ffmpeg", "the ffmpeg package");
  const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
  const binary = process.argv[2] ?? join(root, "ui", "target", "release", "squid-ui");
  try { await access(binary); } catch { fail(`compiled panel missing at ${binary}; run \`cargo build --release --manifest-path ui/Cargo.toml\`, or pass its path after \`bun run ui:smoke --\`.`); }

  const outputDirectory = await mkdtemp(join(tmpdir(), "squid-ui-smoke-"));
  let fixture: Fixture | undefined;
  let display: { readonly display: string; readonly server: ChildProcess } | undefined;
  let panel: ChildProcess | undefined;
  try {
    fixture = await panelFixture(join(outputDirectory, "panel.sock"));
    display = await startDisplay();
    panel = spawn(binary, [], { env: { ...process.env, DISPLAY: display.display, SQUID_PANEL_SOCKET: fixture.socketPath }, stdio: ["ignore", "pipe", "pipe"] });
    log(`ui:smoke output directory: ${outputDirectory}`);
    log(`ui:smoke display: ${display.display}, panel: ${basename(binary)}`);
    await fixture.waitFor("panel subscription", (reply) => reply.type === "subscribe");
    const window = await awaitWindow(display.display);
    log(`ui:smoke window: ${window.id} at ${window.width}x${window.height}+${window.x}+${window.y}`);

    const pending = join(outputDirectory, "01-decision-pending.png");
    await screenshot(display.display, window, pending);
    log(`ui:smoke screenshot: ${pending}`);

    // Later is the third answer, and it must not answer. The request stays
    // pending on the brain's side; only what this surface shows changes.
    await click(display.display, window.id, BUTTONS.later);
    await wait(NEGATIVE_WAIT_MS);
    const afterDefer = answerFor(fixture, PROMPT_ID);
    if (afterDefer !== undefined) {
      fail(`Later sent an answer (${JSON.stringify(afterDefer.answer)}); deferring is not deciding`);
    }
    const deferred = join(outputDirectory, "02-decision-deferred.png");
    await screenshot(display.display, window, deferred);
    log(`ui:smoke screenshot: ${deferred}`);

    // Bringing it back has to work, or Later would be a way to lose a decision.
    await click(display.display, window.id, REVIEW);
    await wait(NEGATIVE_WAIT_MS);

    await click(display.display, window.id, BUTTONS.decline);
    const answer = await fixture.waitFor(
      "the declined answer",
      (reply) => reply.type === "answer" && reply.promptId === PROMPT_ID,
    );
    if (answer.answer !== "declined") {
      fail(`clicking Decline produced ${JSON.stringify(answer.answer)}; the buttons have moved`);
    }
    log(`ui:smoke answered ${JSON.stringify(answer.answer)}`);

    // The panel must stop showing a settled decision. A prompt still on screen
    // after an answer invites a second click on a question already closed.
    const settled = join(outputDirectory, "03-decision-settled.png");
    await screenshot(display.display, window, settled);
    log(`ui:smoke screenshot: ${settled}`);

    // One prompt, one answer. Clicking where the buttons were must not produce a
    // second line for the same id.
    const before = fixture.replies.filter((reply) => reply.type === "answer").length;
    await click(display.display, window.id, BUTTONS.allow);
    await wait(NEGATIVE_WAIT_MS);
    const after = fixture.replies.filter((reply) => reply.type === "answer").length;
    if (after !== before) fail(`a settled prompt accepted another answer (${before} then ${after})`);

    log("ui:smoke passed");
  } finally {
    stop(panel);
    stop(display?.server);
    await fixture?.close();
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
