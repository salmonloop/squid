/**
 * Visual smoke harness for the resident Slint panel.
 *
 * This drives the compiled `squid-ui` binary and a fixture speaking the
 * production newline-delimited wire. Everything the machine has to provide — a
 * display, a window, a click, a picture — comes from a `SmokeHost`, so the
 * assertions below are the same on every platform and the platform differences
 * live in one file each. It is intentionally outside the ordinary offline suite.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isPanelNamedPipe } from "./resolve-panel.js";
import {
  eventually,
  INTERACTION_TIMEOUT_MS,
  resolveSmokeHost,
  smokeFailure,
  wait,
  type SmokeHost,
  type SmokeWindow,
} from "./ui-smoke-host.js";

const WINDOW_TITLE = "Squid";
/** The prompt the fixture raises, and the only id an answer may name. */
const PROMPT_ID = 41;
/** How long to wait for an answer that must NOT arrive. Short: absence is the assertion. */
const NEGATIVE_WAIT_MS = 700;

interface PanelReply {
  readonly type?: unknown;
  readonly op?: unknown;
  readonly promptId?: unknown;
  readonly answer?: unknown;
}

/** One connection, as `Bun.listen` hands it to the handlers below. */
type FixtureSocket = { write(data: string): number };

interface Fixture {
  readonly endpoint: string;
  readonly replies: readonly PanelReply[];
  readonly close: () => Promise<void>;
  waitFor(
    description: string,
    predicate: (reply: PanelReply) => boolean,
    timeoutMs?: number,
  ): Promise<PanelReply>;
}

const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/**
 * Ends the panel, and means it.
 *
 * `SIGTERM` first because a process asked to leave should be asked; `SIGKILL`
 * after a grace period because this is a harness and a panel that outlives its
 * run is not a tidiness problem — it is a window with the same title as the next
 * run's, on a desktop the next run searches by title. Leaked panels are how an
 * earlier version of this file ended up testing a previous run's window.
 */
async function stopPanel(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 2_000;
  while (child.exitCode === null && Date.now() < deadline) await wait(50);
  if (child.exitCode === null) child.kill("SIGKILL");
}

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
  { type: "config", id: "inputSuggestions", label: "Input suggestions", kind: "enum", value: "on", applies: "now", group: "Screen", description: "Suggests text when focusing an input field and auto-types on accept.", values: "on;off" }, 
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

/**
 * The fixture: one server on the endpoint, speaking the production wire.
 *
 * `Bun.listen({ unix })` and not `node:net`'s `createServer`, for the reason
 * `panel-server.ts` gives and this file learned the hard way: Bun inspects the
 * string and takes its named-pipe branch when the value spells one, so the same
 * call binds a Unix socket and a Windows pipe. `node:net` does not — it mangles
 * `\\.\pipe\<name>` into a relative path and refuses to bind it — so a fixture
 * written on it can never stand in for the server the panel actually talks to.
 * The one listen path here is the one listen path in production.
 *
 * On Windows the panel opens a fresh connection for every line it writes, so a
 * connection is not a client: `announce` replies on the connection that sent
 * `subscribe`, which is the reader, and the write-only connections come and go
 * carrying one line each. Per-connection state therefore hangs off the socket
 * rather than being a single "the client" — the same shape the real server uses.
 */
function panelFixture(endpoint: string): Promise<Fixture> {
  const replies: PanelReply[] = [];
  const buffers = new Map<FixtureSocket, string>();
  /**
   * The connection that subscribed, which is the only one worth writing to.
   *
   * On Unix this is the same socket every request arrives on, so it changes
   * nothing. On Windows it is the difference between a fixture that works and one
   * that looks like it does: the panel writes each line on a fresh write-only
   * connection and closes it, so a dump replied to *that* connection is sent into
   * a socket nobody will ever read. An earlier version did exactly that, and the
   * symptom was a panel that showed "The session has not reported what it can
   * watch yet" while the fixture's log claimed it had answered — the same shape as
   * the real server's `clients` set, and for the same reason.
   */
  let reader: FixtureSocket | undefined;

  const send = (socket: FixtureSocket, message: Record<string, unknown>): void => {
    socket.write(`${JSON.stringify(message)}\n`);
  };

  const announce = (socket: FixtureSocket): void => {
    // Current protocol states: both service outcomes, unavailable source,
    // and a prompt only because this wire revision implements it.
    send(socket, { type: "service", agentState: "needs_config" });
    send(socket, { type: "service", agentState: "ready" });
    // Deliberately no `gate`. This is the shape of a default run — pause control
    // is off unless configured, so the field is omitted — and it is the state the
    // header used to render as "Not watching yet" while its own cards said
    // "Watching". The fixture used to send `gate: "open"` here and nothing else,
    // which is why that defect shipped: the one end-to-end check never rendered
    // the common case.
    send(socket, { type: "world_state", updatedAt: "2026-09-01T12:00:00.000Z", lastEvent: "file_saved", application: "Smoke Fixture", window: "panel-smoke.ts", selectionLength: 7, recentActions: "file_saved", episodeEvents: 1 });
    send(socket, { type: "agent", at: "2026-09-01T12:00:01.000Z", status: "replied", text: "Smoke fixture connected." });
    send(socket, { type: "prompt", promptId: PROMPT_ID, kind: "run_tests", summary: "bun test", expiresAt: "2026-09-01T12:05:00.000Z" });
  };

  const consume = (socket: FixtureSocket, chunk: Uint8Array): void => {
    const parts = `${buffers.get(socket) ?? ""}${Buffer.from(chunk).toString("utf8")}`.split("\n");
    buffers.set(socket, parts.pop() ?? "");
    for (const part of parts) {
      const line = part.trim();
      if (line.length === 0) continue;
      try {
        const reply = JSON.parse(line) as PanelReply;
        replies.push(reply);
        if (reply.type === "subscribe") {
          reader = socket;
          announce(socket);
        }
        // Answered to the reader, never to the connection that asked: see the
        // note on `reader`. `?? socket` keeps a dump reachable if a request
        // somehow arrives before a subscribe, rather than dropping it silently.
        const back = reader ?? socket;
        if (reply.type === "config_get") {
          for (const row of CONFIG_ROWS) send(back, row);
          send(back, { type: "config_end", count: CONFIG_ROWS.length });
        }
        if (reply.type === "source_get") {
          for (const row of SOURCE_ROWS) send(back, row);
          send(back, { type: "source_end", count: SOURCE_ROWS.length });
        }
      } catch {
        /* Production server refuses malformed input; fixture does not invent a reply. */
      }
    }
  };

  const server = Bun.listen<undefined>({
    unix: endpoint,
    socket: {
      open: (socket) => {
        buffers.set(socket, "");
      },
      data: (socket, chunk) => consume(socket, chunk),
      close: (socket) => {
        buffers.delete(socket);
        if (reader === socket) reader = undefined;
      },
      // A per-write connection on Windows is closed by the panel the moment its
      // line is out, which surfaces here as a reset. Not an error worth ending a
      // run over, and swallowing it is what keeps one platform's transport shape
      // from failing the other platform's assertions.
      error: (socket) => {
        buffers.delete(socket);
        if (reader === socket) reader = undefined;
      },
    },
  });

  // Unreferenced immediately: a listener counts as work in progress, so a run that
  // has printed its verdict would sit open forever waiting for a connection nobody
  // is going to make. The script's own steps are what keep this process alive, and
  // when they finish it must exit — a harness that hangs on success leaves a window
  // with the next run's title on the desktop the next run searches.
  server.unref();

  return Promise.resolve({
    endpoint,
    replies,
    close: async () => {
      server.stop(true);
      // A named pipe has no filesystem entry, so there is nothing to unlink —
      // the same question `panel-server.ts` asks through the same function, so
      // the fixture and the server cannot disagree about what this endpoint is.
      if (!isPanelNamedPipe(endpoint)) await rm(endpoint, { force: true });
    },
    waitFor: (description, predicate, timeoutMs = INTERACTION_TIMEOUT_MS) =>
      eventually(description, async () => replies.find(predicate) ?? null, timeoutMs),
  });
}

/**
 * The status header's own words, when the host can read them.
 *
 * Only some hosts can: this reads what a screen reader would hear from the status
 * card, which UI Automation exposes on Windows and which a bare X server has no
 * equivalent for. So the claim is checked where it can be checked and skipped —
 * out loud — where it cannot. A skipped assertion that says so is worth more than
 * one faked on a platform that cannot make it.
 *
 * Returns `null` when the host cannot read text at all, which the caller must
 * treat as "not checked" rather than as "nothing was said".
 */
async function readHeader(host: SmokeHost, window: SmokeWindow, when: string): Promise<string | null> {
  const read = host.readStatus;
  if (read === undefined) {
    log(`ui:smoke skipped the header assertion (${when}): the ${host.kind} host cannot read text on screen`);
    return null;
  }
  const status = await read(window);
  if (status === null) {
    smokeFailure(`the status card published nothing ${when}; a screen reader would hear no state at all`);
  }
  log(`ui:smoke header ${when}: ${status}`);
  return status;
}

async function main(): Promise<void> {
  const host = await resolveSmokeHost();
  // URL.pathname is POSIX-shaped even on Windows (`/C:/...`), and `resolve`
  // interprets that as a directory below the drive it is already on — producing
  // `C:\\C:\\...`. `fileURLToPath` is the one standard conversion that knows the
  // host's path dialect, which is exactly why every entry point must use it here
  // instead of shaving the slash itself.
  const root = resolve(dirname(fileURLToPath(new URL(import.meta.url))), "..");
  const defaultBinary = join(root, "ui", "target", "release", process.platform === "win32" ? "squid-ui.exe" : "squid-ui");
  const binary = process.argv[2] ?? defaultBinary;
  try {
    await access(binary);
  } catch {
    smokeFailure(
      `compiled panel missing at ${binary}; run \`cargo build --release --manifest-path ui/Cargo.toml\`, or pass its path after \`bun run ui:smoke --\`.`,
    );
  }

  const outputDirectory = await mkdtemp(join(tmpdir(), "squid-ui-smoke-"));
  let fixture: Fixture | undefined;
  let panel: ChildProcess | undefined;
  try {
    fixture = await panelFixture(host.endpoint(outputDirectory));
    const where = await host.prepare();
    // The panel's own two streams, into a file beside the screenshots. Piping them
    // nowhere is what the first version did, and it meant a panel that refused its
    // endpoint failed this run with a timeout and no reason anywhere on disk.
    const panelLog = join(outputDirectory, "panel.log");
    const panelLogFd = openSync(panelLog, "w");
    try {
      panel = spawn(binary, [], {
        env: { ...process.env, ...host.panelEnvironment(), SQUID_PANEL_SOCKET: fixture.endpoint },
        stdio: ["ignore", panelLogFd, panelLogFd],
      });
    } finally {
      closeSync(panelLogFd);
    }
    log(`ui:smoke output directory: ${outputDirectory}`);
    log(`ui:smoke host: ${host.kind} on ${where}, panel: ${basename(binary)} (log: ${panelLog})`);
    await fixture.waitFor("panel subscription", (reply) => reply.type === "subscribe");
    const window = await host.awaitWindow(WINDOW_TITLE, panel.pid ?? 0);
    log(`ui:smoke window: ${window.id} at ${window.width}x${window.height}+${window.x}+${window.y}`);

    const pending = join(outputDirectory, "01-decision-pending.png");
    await host.screenshot(window, pending);
    log(`ui:smoke screenshot: ${pending}`);

    // The header, while the decision is live. A pending confirmation outranks a
    // healthy session in the status precedence, and that ordering is the fix for
    // the worst thing the old panel did: say "Squid is ready" in calm green while
    // a confirmation sat unanswered below the settings form.
    const whilePending = await readHeader(host, window, "with a decision pending");
    if (whilePending !== null && !/waiting for you/i.test(whilePending)) {
      smokeFailure(`a pending decision did not reach the header, which says: ${whilePending}`);
    }

    // Later is the third answer, and it must not answer. The request stays
    // pending on the brain's side; only what this surface shows changes.
    await host.activate(window, "later");
    await wait(NEGATIVE_WAIT_MS);
    const afterDefer = answerFor(fixture, PROMPT_ID);
    if (afterDefer !== undefined) {
      smokeFailure(`Later sent an answer (${JSON.stringify(afterDefer.answer)}); deferring is not deciding`);
    }
    const deferred = join(outputDirectory, "02-decision-deferred.png");
    await host.screenshot(window, deferred);
    log(`ui:smoke screenshot: ${deferred}`);

    // Bringing it back has to work, or Later would be a way to lose a decision.
    await host.activate(window, "review");
    await wait(NEGATIVE_WAIT_MS);

    await host.activate(window, "decline");
    const answer = await fixture.waitFor(
      "the declined answer",
      (reply) => reply.type === "answer" && reply.promptId === PROMPT_ID,
    );
    if (answer.answer !== "declined") {
      smokeFailure(`clicking Decline produced ${JSON.stringify(answer.answer)}; the buttons have moved`);
    }
    log(`ui:smoke answered ${JSON.stringify(answer.answer)}`);

    // The panel must stop showing a settled decision. A prompt still on screen
    // after an answer invites a second click on a question already closed.
    const settled = join(outputDirectory, "03-decision-settled.png");
    await host.screenshot(window, settled);
    log(`ui:smoke screenshot: ${settled}`);

    // The header, now that nothing outranks the session's own state. This is the
    // regression the fixture was rewritten to catch: the dump it is holding
    // carries two running sources and no `gate` — the shape of every default run —
    // and the header used to answer that with "Not watching yet" while the cards
    // below it said "Watching".
    const whenSettled = await readHeader(host, window, "with the decision settled");
    if (whenSettled !== null) {
      const idle = /not watching|nothing switched on|nothing reported yet/i.exec(whenSettled);
      if (idle !== null) {
        smokeFailure(
          `the header claims "${idle[0]}" while the catalog reports two running sources: ${whenSettled}`,
        );
      }
      if (!/watching/i.test(whenSettled)) {
        smokeFailure(`the header does not say what the session is doing: ${whenSettled}`);
      }
    }

    // One prompt, one answer. Clicking where the buttons were must not produce a
    // second line for the same id.
    const before = fixture.replies.filter((reply) => reply.type === "answer").length;
    await host.activate(window, "allow").catch(() => {
      // On a host that finds controls by name, the settled card is gone and
      // there is nothing named Allow left to click — which is itself the
      // assertion below, reached by a different route. A host that clicks a
      // measured position has no way to know that and clicks anyway.
    });
    await wait(NEGATIVE_WAIT_MS);
    const after = fixture.replies.filter((reply) => reply.type === "answer").length;
    if (after !== before) {
      smokeFailure(`a settled prompt accepted another answer (${before} then ${after})`);
    }

    log("ui:smoke passed");
  } finally {
    await stopPanel(panel);
    await host.dispose();
    await fixture?.close();
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
