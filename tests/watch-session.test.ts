import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import { describe, expect, it } from "bun:test";
import type {
  ActivityEventEmitter,
  ActivitySource,
  ActivitySourceDiagnostic,
} from "../src/activity-source.js";
import { createActivityEvent, type ActivityEvent } from "../src/protocol.js";
import { startWatchSession, type WatchSourceContext } from "../src/watch-session.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import type { ResidentSession, ResidentSessionFactory } from "../src/resident-agent.js";

/**
 * A source that emits exactly what a test hands it, recording lifecycle so the
 * session's start and stop ordering is observable. Nothing here touches the
 * filesystem, a screen reader, or a subprocess — the point of these tests is the
 * session wiring, not any particular backend.
 */
class ScriptedSource implements ActivitySource {
  public started = false;
  public stopped = false;
  public emit: ActivityEventEmitter | undefined;

  public constructor(
    public readonly id: string,
    private readonly lifecycle: string[],
    private readonly failOnStart: Error | undefined = undefined,
  ) {}

  public async start(emit: ActivityEventEmitter): Promise<void> {
    if (this.failOnStart !== undefined) throw this.failOnStart;
    this.started = true;
    this.emit = emit;
    this.lifecycle.push(`start:${this.id}`);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.lifecycle.push(`stop:${this.id}`);
  }
}

/**
 * A recording stand-in for the agent's Pi session.
 *
 * No suite in this repository starts a real `ModelRuntime`, and the resident
 * agent is no exception: what these tests need to see is *that the loop reached
 * the agent*, in what order, and with what — which a fake records exactly and a
 * live model would only obscure.
 */
interface AgentLog {
  readonly calls: string[];
  readonly observed: string[];
  readonly prompts: string[];
  disposed: number;
}

function fakeAgentFactory(
  log: AgentLog,
  options: {
    readonly promptError?: Error;
    readonly reply?: string;
    /** A session whose turn never settles — the wedge the watchdog exists to break. */
    readonly neverIdle?: boolean;
  } = {},
): ResidentSessionFactory {
  return async (): Promise<ResidentSession> => {
    let idle: (() => void) | undefined;
    let aborted = false;
    return {
      async prompt(text: string): Promise<void> {
        log.calls.push("prompt");
        log.prompts.push(text);
        if (options.promptError !== undefined) throw options.promptError;
      },
      async observe(customType: string, content: string): Promise<void> {
        log.calls.push("observe");
        log.observed.push(`${customType}:${content}`);
      },
      async waitForIdle(): Promise<void> {
        log.calls.push("waitForIdle");
        // A wedged turn settles only when aborted — and once aborted, the
        // session is idle for good: a real session falls back to idle the
        // moment its abort lands, so any later waitForIdle (the watchdog's
        // grace, say) resolves instead of outliving the abort.
        if (options.neverIdle === true && !aborted) {
          await new Promise<void>((resolve) => {
            idle = resolve;
          });
        }
      },
      async abort(): Promise<void> {
        log.calls.push("abort");
        aborted = true;
        idle?.();
      },
      getLastAssistantText(): string | undefined {
        return options.reply;
      },
      dispose(): void {
        log.calls.push("dispose");
        log.disposed += 1;
      },
    };
  };
}

function emptyAgentLog(): AgentLog {
  return { calls: [], observed: [], prompts: [], disposed: 0 };
}

/** A save the filesystem source could really produce: path known, owner not. */
function fileSaved(eventId: string, path: string): ActivityEvent {
  return createActivityEvent({
    kind: "file_saved",
    eventId,
    source: { kind: "filesystem", instanceId: "fs-1" },
    sessionId: "fs-session",
    sequence: Number(eventId.split("-").at(-1) ?? 0),
    payload: { path, applicationId: null },
  });
}

/** The same save shape, with an explicit occurredAt for retention windows. */
function fileSavedAt(eventId: string, occurredAt: string): ActivityEvent {
  return createActivityEvent({
    kind: "file_saved",
    eventId,
    source: { kind: "filesystem", instanceId: "fs-1" },
    sessionId: "fs-session",
    sequence: 0,
    occurredAt,
    payload: { path: "src/ancient.test.ts", applicationId: null },
  });
}

/** A foreground fact only a screen source can produce. */
function applicationActivated(eventId: string, applicationId: string): ActivityEvent {
  return createActivityEvent({
    kind: "application_activated",
    eventId,
    source: { kind: "host", instanceId: "screen-1" },
    sessionId: "screen-session",
    sequence: Number(eventId.split("-").at(-1) ?? 0),
    payload: { applicationId, applicationName: "Visual Studio Code" },
  });
}

/** The default posture both watches ship with: no capability variables set. */
const OFFLINE_ENV: Record<string, string | undefined> = {};

async function startSession(options: {
  readonly sources: readonly ActivitySource[];
  readonly env?: Record<string, string | undefined>;
  readonly log?: (line: string) => void;
  readonly logError?: (line: string) => void;
  readonly agentLog?: AgentLog;
  readonly agentOptions?: {
    readonly promptError?: Error;
    readonly reply?: string;
    readonly neverIdle?: boolean;
  };
}) {
  const seenContexts: WatchSourceContext[] = [];
  const agentLog = options.agentLog ?? emptyAgentLog();
  const result = await startWatchSession({
    workingDirectory: "/tmp",
    env: options.env ?? OFFLINE_ENV,
    log: options.log ?? (() => {}),
    logError: options.logError ?? (() => {}),
    createAgentSession: fakeAgentFactory(agentLog, options.agentOptions ?? {}),
    createSources: async (context) => {
      seenContexts.push(context);
      return options.sources;
    },
    describeEvent: (event, ingested) => ({
      kind: event.kind,
      disposition: ingested.ingest.disposition,
    }),
  });
  return { result, seenContexts, agentLog };
}

/**
 * Settles the ingest pipeline *and* the agent turn it started.
 *
 * `awaitIdle` drains the runtime's own ingests; the agent turn is chained onto
 * one and the runtime does not know it exists. A test that awaited only the
 * runtime would assert against a turn still in flight — which is exactly the
 * drop `stop` orders itself to avoid, so it must not be papered over here.
 */
async function settle(session: { stop(): Promise<void> }): Promise<void> {
  await session.stop();
}

describe("startWatchSession", () => {
  it("starts every source in order and stops them in reverse", async () => {
    const lifecycle: string[] = [];
    const first = new ScriptedSource("alpha", lifecycle);
    const second = new ScriptedSource("beta", lifecycle);
    const { result } = await startSession({ sources: [first, second] });
    if ("configError" in result) throw new Error(result.configError);

    expect(lifecycle).toEqual(["start:alpha", "start:beta"]);
    expect(result.session.sourceIds).toEqual(["alpha", "beta"]);

    await result.session.stop();
    // Reverse order matters: a later source must never emit into a runtime an
    // earlier one has already begun tearing down.
    expect(lifecycle).toEqual(["start:alpha", "start:beta", "stop:beta", "stop:alpha"]);
  });

  /**
   * The reason this module exists. What the agent can conclude about a save
   * depends on facts no single source produces: the filesystem source reports a
   * path with `applicationId: null`, and only a screen source knows what is in
   * front. A session must therefore project both streams into one state.
   */
  it("projects events from two independent sources into one world state", async () => {
    const lifecycle: string[] = [];
    const files = new ScriptedSource("filesystem", lifecycle);
    const screen = new ScriptedSource("screen-text", lifecycle);
    const { result } = await startSession({ sources: [files, screen] });
    if ("configError" in result) throw new Error(result.configError);

    await screen.emit!(applicationActivated("screen-0", "com.microsoft.VSCode"));
    await files.emit!(fileSaved("fs-1", "src/x.test.ts"));
    await result.session.runtime.runtime.awaitIdle();

    const state = result.session.runtime.core.currentState;
    // Both halves are present in one projection — the fact a single-source run
    // can never assemble.
    expect(state.activeApplication?.id).toBe("com.microsoft.VSCode");
    const save = state.recentActions.find((action) => action.kind === "file_saved");
    expect(save?.target).toBe("src/x.test.ts");
    // The save's owner stays unknown. Attributing it to whatever happened to be
    // in the foreground is the guess the projection refuses to make.
    expect(save?.applicationId).toBeNull();

    await settle(result.session);
  });

  it("shares one store and runtime across sources", async () => {
    const lifecycle: string[] = [];
    const first = new ScriptedSource("alpha", lifecycle);
    const second = new ScriptedSource("beta", lifecycle);
    const { result } = await startSession({ sources: [first, second] });
    if ("configError" in result) throw new Error(result.configError);

    await first.emit!(fileSaved("fs-1", "a.ts"));
    await second.emit!(fileSaved("fs-2", "b.ts"));
    await result.session.runtime.runtime.awaitIdle();

    expect(await result.session.runtime.store.all()).toHaveLength(2);
    await settle(result.session);
  });

  it("hands every source the same diagnostic sink and sink paths", async () => {
    const lifecycle: string[] = [];
    const logged: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result, seenContexts } = await startSession({
      sources: [source],
      logError: (line) => logged.push(line),
    });
    if ("configError" in result) throw new Error(result.configError);

    const context = seenContexts[0]!;
    // In-memory run: no sink path, which is what keeps a filesystem source from
    // computing exclusions it does not need.
    expect(context.databasePath).toBeUndefined();

    const diagnostic: ActivitySourceDiagnostic = {
      kind: "watcher_error",
      message: "a watcher failed",
      occurredAt: new Date().toISOString(),
    };
    context.onDiagnostic(diagnostic);
    expect(logged.some((line) => line.includes("a watcher failed"))).toBe(true);

    await settle(result.session);
  });

  it("refuses a session with no sources instead of running a blind core", async () => {
    const { result } = await startSession({ sources: [] });
    expect("configError" in result && result.configError).toContain("at least one activity source");
  });

  it("stops already-started sources when a later one fails to start", async () => {
    const lifecycle: string[] = [];
    const healthy = new ScriptedSource("alpha", lifecycle);
    const broken = new ScriptedSource("beta", lifecycle, new Error("reader unavailable"));

    const { result, agentLog } = await startSession({ sources: [healthy, broken] });

    // A half-started session is worse than none: the caller has no handle to
    // stop the source that did start, so the session must unwind itself.
    expect("configError" in result).toBe(true);
    if ("configError" in result) {
      expect(result.configError).toContain("reader unavailable");
    }
    expect(healthy.stopped).toBe(true);
    // The agent was created before the sources started, so the unwind has to
    // dispose it too — otherwise a failed startup leaks a live session.
    expect(agentLog.disposed).toBe(1);
  });

  it("names every source and the agent in the startup banner", async () => {
    const lifecycle: string[] = [];
    const { result } = await startSession({
      sources: [new ScriptedSource("filesystem", lifecycle), new ScriptedSource("screen", lifecycle)],
    });
    if ("configError" in result) throw new Error(result.configError);

    expect(result.session.banner.sources).toBe("filesystem,screen");
    expect(result.session.banner.store).toBe("memory");
    expect(result.session.banner.agent).toBe("resident");
    await settle(result.session);
  });

  it("is idempotent on stop so a second signal cannot double-dispose", async () => {
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result, agentLog } = await startSession({ sources: [source] });
    if ("configError" in result) throw new Error(result.configError);

    await result.session.stop();
    await result.session.stop();
    expect(lifecycle.filter((entry) => entry === "stop:alpha")).toHaveLength(1);
    // The agent's session is disposed once too: a second signal must not tear
    // down a session that is already gone.
    expect(agentLog.disposed).toBe(1);
  });

  it("logs one described line per ingested event", async () => {
    const lifecycle: string[] = [];
    const lines: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result } = await startSession({ sources: [source], log: (line) => lines.push(line) });
    if ("configError" in result) throw new Error(result.configError);

    await source.emit!(fileSaved("fs-1", "src/x.test.ts"));
    await result.session.runtime.runtime.awaitIdle();

    const described = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(described.some((line) => line.kind === "file_saved")).toBe(true);
    await settle(result.session);
  });

  it("reports a config error rather than starting when retention is malformed", async () => {
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const result = await startWatchSession({
      workingDirectory: "/tmp",
      env: { SQUID_RETENTION_HOURS: "soon" },
      log: () => {},
      logError: () => {},
      createAgentSession: fakeAgentFactory(emptyAgentLog()),
      createSources: async () => [source],
      describeEvent: () => ({}),
    });

    expect("configError" in result).toBe(true);
    if ("configError" in result) {
      expect(result.configError).toContain("SQUID_RETENTION_HOURS");
    }
    // Nothing starts on a policy that cannot be honored, and the error names the
    // variable the user must fix.
    expect(lifecycle).toEqual([]);
    expect(source.started).toBe(false);
  });

  /**
   * Retention prunes before restore, and both halves are observable without a
   * test hook: the prune through the durable database it empties (the seeded
   * ancient event is gone), the ordering through the dedupe index — an event
   * restored from history replays as "duplicate", while one deleted before
   * restore is accepted as new. The session needs a real SQLite store here
   * because the in-memory one has nothing to persist between seeding and startup.
   */
  it("states the retention bound in the banner and prunes old history before restore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squid-watch-retention-"));
    try {
      const databasePath = join(dir, "events.db");
      const seedStore = new SqliteEventStore(databasePath);
      await seedStore.append(fileSavedAt("evt-ancient", "2020-01-01T00:00:00.000Z"));
      seedStore.close();

      const lifecycle: string[] = [];
      const source = new ScriptedSource("alpha", lifecycle);
      // One hour of retention: the seeded event predates any real cutoff.
      const result = await startWatchSession({
        workingDirectory: "/tmp",
        env: { ...OFFLINE_ENV, SQUID_RETENTION_HOURS: "1" },
        databasePath,
        log: () => {},
        logError: () => {},
        createAgentSession: fakeAgentFactory(emptyAgentLog()),
        createSources: async () => [source],
        describeEvent: () => ({}),
      });
      if ("configError" in result) throw new Error(result.configError);
      const { session } = result;

      expect(session.banner.retention).toBe(1);
      expect(session.banner.prunedEvents).toBe(1);

      // Prune-before-restore, observed through behavior: replaying the deleted
      // id must be accepted fresh — had restore seen it first, this would be
      // disposition "duplicate".
      const replay = await session.runtime.core.ingest(
        fileSavedAt("evt-ancient", "2026-08-22T12:00:00.000Z"),
      );
      expect(replay.disposition).toBe("accepted");

      const reopened = new SqliteEventStore(databasePath);
      try {
        expect((await reopened.all()).map((e) => e.eventId)).toEqual(["evt-ancient"]);
      } finally {
        reopened.close();
      }
      await session.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The closed loop, asserted end to end.
 *
 * This is the requirement the whole pivot exists to satisfy, and a green gate
 * cannot see it: every module could typecheck and every other test pass while the
 * ingest closure quietly never reached the agent. So these assert the wiring
 * itself — an event arrives, the agent's senses are updated, and it is given a
 * turn.
 */
describe("the resident agent in the ingest loop", () => {
  it("observes the projection and then takes a turn, in that order", async () => {
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result, agentLog } = await startSession({ sources: [source] });
    if ("configError" in result) throw new Error(result.configError);

    await source.emit!(fileSaved("fs-1", "src/x.test.ts"));
    await result.session.stop();

    // Observe before prompt: the prompt is what makes the agent think, and it
    // must think about the world *including* this event, not the one before it.
    const observeAt = agentLog.calls.indexOf("observe");
    const promptAt = agentLog.calls.indexOf("prompt");
    expect(observeAt).toBeGreaterThanOrEqual(0);
    expect(promptAt).toBeGreaterThan(observeAt);
  });

  it("appends an observation naming the event kind", async () => {
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result, agentLog } = await startSession({ sources: [source] });
    if ("configError" in result) throw new Error(result.configError);

    await source.emit!(fileSaved("fs-1", "src/x.test.ts"));
    await result.session.stop();

    expect(agentLog.observed).toHaveLength(1);
    expect(agentLog.observed[0]).toContain("observation:");
    expect(agentLog.observed[0]).toContain("file_saved");
  });

  it("leaves the agent alone when an event changed nothing", async () => {
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result, agentLog } = await startSession({ sources: [source] });
    if ("configError" in result) throw new Error(result.configError);

    const save = fileSaved("fs-1", "src/x.test.ts");
    await source.emit!(save);
    await source.emit!(save);
    await result.session.stop();

    // Two emissions, one turn: the duplicate moved nothing in the world, so
    // there is nothing new to think about and no turn to spend.
    expect(agentLog.calls.filter((call) => call === "prompt")).toHaveLength(1);
    expect(agentLog.calls.filter((call) => call === "observe")).toHaveLength(1);
  });

  it("gives the agent permission to do nothing", async () => {
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result, agentLog } = await startSession({ sources: [source] });
    if ("configError" in result) throw new Error(result.configError);

    await source.emit!(fileSaved("fs-1", "src/x.test.ts"));
    await result.session.stop();

    // Without this the loop's steady state is activity rather than attention: a
    // model handed a fresh observation every few seconds reads each one as a
    // request for action.
    expect(agentLog.prompts[0]).toContain("otherwise stop without acting");
  });

  it("serializes turns so two observations never interleave on one session", async () => {
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result, agentLog } = await startSession({ sources: [source] });
    if ("configError" in result) throw new Error(result.configError);

    await source.emit!(fileSaved("fs-1", "a.ts"));
    await source.emit!(fileSaved("fs-2", "b.ts"));
    await result.session.stop();

    // Each prompt is followed by its own idle wait before the next begins.
    // Overlapping prompts on one session are not two opinions — they are one
    // conversation with interleaved turns.
    const turnCalls = agentLog.calls.filter((call) => call === "prompt" || call === "waitForIdle");
    expect(turnCalls).toEqual(["prompt", "waitForIdle", "prompt", "waitForIdle"]);
  });

  it("logs what the agent said", async () => {
    const lifecycle: string[] = [];
    const lines: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result } = await startSession({
      sources: [source],
      log: (line) => lines.push(line),
      agentOptions: { reply: "ran the tests; they pass" },
    });
    if ("configError" in result) throw new Error(result.configError);

    await source.emit!(fileSaved("fs-1", "src/x.test.ts"));
    await result.session.stop();

    const reported = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.agent === "replied");
    expect(reported?.text).toBe("ran the tests; they pass");
  });

  it("survives a failed turn and keeps ingesting", async () => {
    const lifecycle: string[] = [];
    const errors: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result, agentLog } = await startSession({
      sources: [source],
      logError: (line) => errors.push(line),
      agentOptions: { promptError: new Error("the model refused") },
    });
    if ("configError" in result) throw new Error(result.configError);

    await source.emit!(fileSaved("fs-1", "a.ts"));
    await source.emit!(fileSaved("fs-2", "b.ts"));
    await result.session.stop();

    // A rejected turn is a diagnostic, never the end of the loop — and the
    // second event still got its own attempt rather than inheriting the first
    // failure through the serialization chain.
    expect(errors.some((line) => line.includes("agentTurnError"))).toBe(true);
    expect(agentLog.calls.filter((call) => call === "prompt")).toHaveLength(2);
    // Both events still reached history: the agent failing does not stop capture.
    expect(await result.session.runtime.store.all()).toHaveLength(2);
  });

  it("aborts a turn that never settles and keeps the loop alive", async () => {
    const lifecycle: string[] = [];
    const errors: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result, agentLog } = await startSession({
      sources: [source],
      env: { SQUID_AGENT_TURN_TIMEOUT_MS: "50" },
      logError: (line) => errors.push(line),
      agentOptions: { neverIdle: true },
    });
    if ("configError" in result) throw new Error(result.configError);

    await source.emit!(fileSaved("fs-1", "a.ts"));
    // The watchdog fires 50ms in: without it this await never returns, because
    // the serialized chain holds every later turn behind the wedged one.
    await source.emit!(fileSaved("fs-2", "b.ts"));
    await result.session.stop();

    expect(agentLog.calls.filter((call) => call === "abort").length).toBeGreaterThanOrEqual(1);
    expect(errors.some((line) => line.includes("agentTurnError") && line.includes("exceeded 50ms"))).toBe(true);
    // The loop survived the wedge: the second event still reached the agent.
    expect(agentLog.calls.filter((call) => call === "prompt")).toHaveLength(2);
    // And the second prompt was issued after the abort landed, not during the
    // unwind — a prompt against a session still processing is refused outright.
    const promptIndexes = agentLog.calls.flatMap((call, index) => (call === "prompt" ? [index] : []));
    expect(agentLog.calls.indexOf("abort")).toBeLessThan(promptIndexes[1] ?? Number.POSITIVE_INFINITY);
    expect(await result.session.runtime.store.all()).toHaveLength(2);
  });

  it("refuses a malformed SQUID_AGENT_TURN_TIMEOUT_MS before any source starts", async () => {
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result } = await startSession({
      sources: [source],
      env: { SQUID_AGENT_TURN_TIMEOUT_MS: "soon" },
    });
    if (!("configError" in result)) throw new Error("expected a config error");
    expect(result.configError).toContain("SQUID_AGENT_TURN_TIMEOUT_MS");
    expect(source.started).toBe(false);
  });

  it("drains in-flight turns before disposing the agent, then the store", async () => {    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result, agentLog } = await startSession({ sources: [source] });
    if ("configError" in result) throw new Error(result.configError);

    await source.emit!(fileSaved("fs-1", "src/x.test.ts"));
    await result.session.stop();

    // A turn cut off mid-flight loses whatever the agent was doing, and its
    // session history is the only record that it happened — so dispose must come
    // after the last turn call, not before it.
    const disposeAt = agentLog.calls.indexOf("dispose");
    const lastTurnAt = agentLog.calls.lastIndexOf("waitForIdle");
    expect(disposeAt).toBeGreaterThan(lastTurnAt);
    expect(agentLog.disposed).toBe(1);
  });

  it("says nothing to the agent about an event capture excluded", async () => {
    const lifecycle: string[] = [];
    const lines: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result, agentLog } = await startSession({
      sources: [source],
      env: { ...OFFLINE_ENV, SQUID_EXCLUDE: "Vault" },
      log: (line) => lines.push(line),
    });
    if ("configError" in result) throw new Error(result.configError);

    await source.emit!(createActivityEvent({
      kind: "application_activated",
      eventId: "vault-1",
      source: { kind: "host", instanceId: "screen-1" },
      sessionId: "screen-session",
      sequence: 0,
      payload: { applicationId: "9", applicationName: "Vault" },
    }));
    await result.session.stop();

    // The user asked for this application to be invisible. An excluded event
    // reaches neither history nor the agent's senses, and the log line says only
    // that something was excluded.
    expect(await result.session.runtime.store.all()).toHaveLength(0);
    expect(agentLog.observed).toHaveLength(0);
    expect(agentLog.calls).not.toContain("prompt");
    const excluded = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.disposition === "excluded");
    expect(excluded?.kind).toBe("application_activated");
  });
});

/**
 * A real socket client against the panel server the session started.
 *
 * These tests do not read the server's internals — they connect over the real
 * endpoint, read framed lines, and send one back. A fake here would test the
 * wiring against itself.
 *
 * `Bun.connect`, not `node:net`'s `connect`, and the difference is measured
 * rather than stylistic. On the Windows runner a `node:net` client against a
 * named pipe connects and its writes arrive — the pause-press test proves the
 * inbound direction — but nothing is ever delivered to its `data` handler, so
 * every assertion that reads a broadcast times out. Swapped for `Bun.connect`
 * against the identical server and pipe, both directions work; that is the API
 * `tests/panel-server.test.ts` already uses, and its named-pipe round trip
 * passes there. The gap is in Bun's `node:net` read path on Windows pipes, not
 * in the panel transport, so the client moves to the API that carries both
 * directions on both platforms rather than the suites being skipped.
 */
class PanelTestClient {
  readonly lines: string[] = [];
  private carry = "";
  private socket: Socket<undefined> | null = null;
  private readonly opened: Promise<void>;

  public constructor(socketPath: string) {
    this.opened = (async () => {
      this.socket = await Bun.connect<undefined>({
        unix: socketPath,
        socket: {
          data: (_socket, chunk) => {
            this.carry += chunk.toString("utf8");
            const parts = this.carry.split("\n");
            // The tail after the last newline is an incomplete line; it waits.
            this.carry = parts.pop() ?? "";
            for (const part of parts) this.lines.push(part);
          },
          open: () => undefined,
          close: () => undefined,
          error: () => undefined,
        },
      });
    })();
  }

  public async ready(): Promise<void> {
    await this.opened;
  }

  public send(line: string): void {
    this.socket?.write(`${line}\n`);
  }

  public async close(): Promise<void> {
    await this.opened.catch(() => undefined);
    this.socket?.end();
  }
}

function parsePanelLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

/** Polls until the probe finds something, so tests do not sleep on wall-clock guesses. */
async function waitForLine(
  probe: () => Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const found = probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("timed out waiting for a panel line");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A text selection the sensors could really observe: distinctive enough to grep
 * the whole wire for, and deliberately *not* credential-shaped. A selection that
 * tripped `capture-policy`'s credential patterns would reach the panel already
 * replaced by `"[redacted]"`, and the length assertion would then be measuring
 * the redaction placeholder instead of the privacy boundary this test is about.
 */
const PLAIN_SELECTION = "SELECT invoice_total FROM ledger WHERE marker_zqxjkv = 1";

/**
 * A panel endpoint spelled the way this platform's transport requires.
 *
 * What the suites below actually test is the session's wiring: world state
 * reaching a connected client, an agent turn being announced, a pause press
 * reaching the capture-gate command path, a selection arriving as a length and
 * never as text. None of that is transport-specific — but the endpoint
 * *spelling* is. `resolvePanel` refuses a filesystem path on Windows, so a
 * hardcoded `<tmp>/panel.sock` fails the session before a single source starts,
 * and every assertion past that point reports a wiring bug that is really a
 * spelling mismatch.
 *
 * Parameterizing the endpoint rather than skipping the suites keeps this
 * platform-independent logic under test on both platforms. `node:net`'s
 * `connect(path)` opens a named pipe on Windows and a Unix socket elsewhere, so
 * `PanelTestClient` needs no branch of its own.
 */
const panelEndpoint = (dir: string): string =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\squid-panel-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    : join(dir, "panel.sock");

describe("the control panel on a watch session", () => {
  it("delivers world state to a connected panel over the real socket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squid-panel-"));
    const socketPath = panelEndpoint(dir);
    const source = new ScriptedSource("alpha", []);
    const { result } = await startSession({
      sources: [source],
      env: { SQUID_PANEL_SOCKET: socketPath },
    });
    if ("configError" in result) throw new Error(result.configError);
    try {
      expect(result.session.banner.panel).toBe(socketPath);
      const client = new PanelTestClient(socketPath);
      await client.ready();

      await source.emit!(fileSaved("fs-1", "src/x.test.ts"));
      const line = await waitForLine(() =>
        client.lines
          .map(parsePanelLine)
          .find((parsed) => parsed.type === "world_state"),
      );
      expect(line.lastEvent).toBe("file_saved");
      expect(line.episodeEvents).toBe(1);

      await client.close();
    } finally {
      await result.session.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("announces a replied agent turn on the panel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squid-panel-"));
    const socketPath = panelEndpoint(dir);
    const source = new ScriptedSource("alpha", []);
    const { result } = await startSession({
      sources: [source],
      env: { SQUID_PANEL_SOCKET: socketPath },
      agentOptions: { reply: "ran the tests; they pass" },
    });
    if ("configError" in result) throw new Error(result.configError);
    try {
      const client = new PanelTestClient(socketPath);
      await client.ready();

      await source.emit!(fileSaved("fs-1", "src/x.test.ts"));
      const line = await waitForLine(() =>
        client.lines
          .map(parsePanelLine)
          .find((parsed) => parsed.type === "agent"),
      );
      expect(line.status).toBe("replied");
      expect(line.text).toBe("ran the tests; they pass");

      await client.close();
    } finally {
      await result.session.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("announces a failed agent turn on the panel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squid-panel-"));
    const socketPath = panelEndpoint(dir);
    const source = new ScriptedSource("alpha", []);
    const { result } = await startSession({
      sources: [source],
      env: { SQUID_PANEL_SOCKET: socketPath },
      agentOptions: { promptError: new Error("the model refused") },
    });
    if ("configError" in result) throw new Error(result.configError);
    try {
      const client = new PanelTestClient(socketPath);
      await client.ready();

      await source.emit!(fileSaved("fs-1", "src/x.test.ts"));
      const line = await waitForLine(() =>
        client.lines
          .map(parsePanelLine)
          .find((parsed) => parsed.type === "agent"),
      );
      expect(line.status).toBe("failed");
      expect(String(line.text)).toContain("the model refused");

      await client.close();
    } finally {
      await result.session.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never puts the raw selection on the wire, only its length", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squid-panel-"));
    const socketPath = panelEndpoint(dir);
    const source = new ScriptedSource("screen", []);
    const { result } = await startSession({
      sources: [source],
      env: { SQUID_PANEL_SOCKET: socketPath },
    });
    if ("configError" in result) throw new Error(result.configError);
    try {
      const client = new PanelTestClient(socketPath);
      await client.ready();

      await source.emit!(applicationActivated("ev-1", "9"));
      await source.emit!(createActivityEvent({
        kind: "focus_changed",
        eventId: "ev-2",
        source: { kind: "host", instanceId: "screen-1" },
        sessionId: "screen-session",
        sequence: 2,
        payload: { applicationId: "9", windowTitle: "vault.sql", role: "editor", label: null },
      }));
      await source.emit!(createActivityEvent({
        kind: "text_context_changed",
        eventId: "ev-3",
        source: { kind: "host", instanceId: "screen-1" },
        sessionId: "screen-session",
        sequence: 3,
        payload: { prefix: "before", suffix: "after", selection: PLAIN_SELECTION, language: "sql" },
      }));

      const line = await waitForLine(() =>
        client.lines
          .map(parsePanelLine)
          .find((parsed) => parsed.type === "world_state" && parsed.selectionLength !== undefined),
      );
      expect(line.selectionLength).toBe(PLAIN_SELECTION.length);
      for (const raw of client.lines) {
        expect(raw).not.toContain(PLAIN_SELECTION);
        expect(raw).not.toContain("invoice_total");
      }

      await client.close();
    } finally {
      await result.session.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("routes a panel pause press into the capture-gate command path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squid-panel-"));
    const socketPath = panelEndpoint(dir);
    const commandPath = join(dir, "gate.fifo");
    const source = new ScriptedSource("alpha", []);
    const { result } = await startSession({
      sources: [source],
      env: {
        SQUID_PANEL_SOCKET: socketPath,
        SQUID_CONTROL: "fifo",
        SQUID_CONTROL_FIFO: commandPath,
        SQUID_CONTROL_POLL_MS: "10",
      },
    });
    if ("configError" in result) throw new Error(result.configError);
    try {
      const client = new PanelTestClient(socketPath);
      await client.ready();

      client.send(JSON.stringify({ type: "control", op: "pause" }));
      const deadline = Date.now() + 2000;
      let appended = "";
      while (!appended.includes('"op":"pause"')) {
        if (Date.now() > deadline) throw new Error("pause never reached the gate command path");
        appended = await readFile(commandPath, "utf8").catch(() => "");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await client.close();
    } finally {
      await result.session.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ships with the panel off and says so in the banner", async () => {
    const source = new ScriptedSource("alpha", []);
    const { result } = await startSession({ sources: [source] });
    if ("configError" in result) throw new Error(result.configError);
    try {
      expect(result.session.banner.panel).toBe("off");
    } finally {
      await result.session.stop();
    }
  });

  it("refuses a malformed SQUID_PANEL_SOCKET before any source starts", async () => {
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result } = await startSession({
      sources: [source],
      env: { SQUID_PANEL_SOCKET: "relative/panel.sock" },
    });
    // Malformed on either platform, for a different stated reason: a relative
    // path is not absolute, and it is not a named pipe either. The invariant is
    // the refusal and its timing — before any source starts — so the message is
    // matched per platform rather than pinning one platform's wording as though
    // it were the contract.
    const expected = process.platform === "win32" ? "named pipe" : "absolute";
    expect("configError" in result && result.configError.includes(expected)).toBe(true);
    expect(lifecycle).toEqual([]);
  });

  /**
   * The two below are about the socket *file*, so they stay off Windows. A named
   * pipe has no directory entry to create or unlink, which is the whole subject
   * here — and its disappearance after close is a handle lifetime rather than an
   * unlink, with no ordering this test could rely on. The pipe's bind-and-close
   * behaviour is asserted directly in `tests/panel-server.test.ts`.
   */
  it.skipIf(process.platform === "win32")("removes the socket file on stop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squid-panel-"));
    const socketPath = panelEndpoint(dir);
    const source = new ScriptedSource("alpha", []);
    const { result } = await startSession({
      sources: [source],
      env: { SQUID_PANEL_SOCKET: socketPath },
    });
    if ("configError" in result) throw new Error(result.configError);
    try {
      expect(existsSync(socketPath)).toBe(true);
      await result.session.stop();
      expect(existsSync(socketPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("closes the panel even when a source fails to start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squid-panel-"));
    const socketPath = panelEndpoint(dir);
    const broken = new ScriptedSource("broken", [], new Error("no display"));
    const { result } = await startSession({
      sources: [broken],
      env: { SQUID_PANEL_SOCKET: socketPath },
    });
    expect("configError" in result).toBe(true);
    expect(existsSync(socketPath)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("the control panel and the capture policy's redaction", () => {
  /**
   * The panel reports the selection's length, and the capture policy replaces a
   * credential-shaped selection with `"[redacted]"` before it is ever stored.
   * Those two facts meet here: the length the panel shows must be the redacted
   * placeholder's, not the original's. Reporting the original length would leak
   * the size of a secret the policy just decided nobody may see — a smaller leak
   * than the text, but a leak the projection is not supposed to be capable of.
   */
  it("reports the redacted placeholder's length, not the secret's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squid-panel-"));
    const socketPath = panelEndpoint(dir);
    const source = new ScriptedSource("screen", []);
    const secret = "password = hunter2_marker_zqxjkv_and_a_long_tail_to_be_sure";
    const { result } = await startSession({
      sources: [source],
      env: { SQUID_PANEL_SOCKET: socketPath },
    });
    if ("configError" in result) throw new Error(result.configError);
    try {
      const client = new PanelTestClient(socketPath);
      await client.ready();

      await source.emit!(createActivityEvent({
        kind: "text_context_changed",
        eventId: "ev-1",
        source: { kind: "host", instanceId: "screen-1" },
        sessionId: "screen-session",
        sequence: 1,
        payload: { prefix: "before", suffix: "after", selection: secret, language: null },
      }));

      const line = await waitForLine(() =>
        client.lines
          .map(parsePanelLine)
          .find((parsed) => parsed.type === "world_state" && parsed.selectionLength !== undefined),
      );
      // "[redacted]" is ten characters. The secret is not.
      expect(line.selectionLength).toBe("[redacted]".length);
      expect(line.selectionLength).not.toBe(secret.length);
      for (const raw of client.lines) {
        expect(raw).not.toContain("hunter2");
        expect(raw).not.toContain("marker_zqxjkv");
      }

      await client.close();
    } finally {
      await result.session.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
