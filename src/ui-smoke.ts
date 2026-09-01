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

interface CommandResult { readonly code: number | null; readonly stdout: string; readonly stderr: string }
interface PanelReply { readonly type?: unknown; readonly op?: unknown; readonly promptId?: unknown; readonly answer?: unknown }
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
        send({ type: "prompt", promptId: 41, kind: "run_tests", summary: "bun test", expiresAt: "2026-09-01T12:05:00.000Z" });
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
              if (reply.type === "config_get") { send({ type: "config", id: "model", label: "Model", kind: "text", value: "", applies: "restart" }); send({ type: "config_end", count: 1 }); }
              if (reply.type === "source_get") { send({ type: "source", id: "screen", label: "Screen text", state: "unsupported" }); send({ type: "source_end", count: 1 }); }
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

async function awaitWindow(display: string): Promise<string> {
  const env = { ...process.env, DISPLAY: display };
  return eventually("a mapped Squid window", async () => {
    const found = await run("xdotool", ["search", "--name", `^${WINDOW_TITLE}$`], env);
    for (const id of found.stdout.trim().split(/\s+/)) {
      if (id.length === 0) continue;
      const info = await run("xwininfo", ["-id", id], env);
      if (info.code === 0 && info.stdout.includes("IsViewable")) return id;
    }
    return null;
  });
}

async function screenshot(display: string, windowId: string, path: string): Promise<void> {
  const result = await run("import", ["-display", display, "-window", windowId, path], { ...process.env, DISPLAY: display });
  if (result.code !== 0) fail(`could not save ${path}: ${result.stderr.trim() || "ImageMagick import failed"}`);
}

async function clickApprove(display: string, windowId: string): Promise<void> {
  const env = { ...process.env, DISPLAY: display };
  // Slint has no stable accessibility selector. The prompt order is Decline,
  // Approve, so keyboard traversal is preferred. The final click is a documented
  // window-relative fallback for host themes that alter focus traversal.
  if ((await run("xdotool", ["windowactivate", "--sync", windowId, "key", "Tab", "Tab", "Return"], env)).code === 0) return;
  if ((await run("xdotool", ["mousemove", "--window", windowId, "400", "760", "click", "1"], env)).code !== 0) fail("could not drive panel input with xdotool");
}

async function main(): Promise<void> {
  await requireCommand("Xvfb", "the Xvfb package");
  await requireCommand("xdotool", "the xdotool package");
  await requireCommand("xwininfo", "the x11-utils package");
  await requireCommand("import", "ImageMagick");
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
    const windowId = await awaitWindow(display.display);
    const mapped = join(outputDirectory, "mapped.png");
    await screenshot(display.display, windowId, mapped);
    log(`ui:smoke screenshot: ${mapped}`);
    await clickApprove(display.display, windowId);
    const answer = await fixture.waitFor("approved prompt reply", (reply) => reply.type === "answer" && reply.promptId === 41 && reply.answer === "approved");
    const after = join(outputDirectory, "after-approve.png");
    await screenshot(display.display, windowId, after);
    log(`ui:smoke screenshot: ${after}`);
    log(`ui:smoke passed (${JSON.stringify(answer)})`);
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
