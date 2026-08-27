import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  options: { readonly promptError?: Error; readonly reply?: string } = {},
): ResidentSessionFactory {
  return async (): Promise<ResidentSession> => ({
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
    },
    async abort(): Promise<void> {},
    getLastAssistantText(): string | undefined {
      return options.reply;
    },
    dispose(): void {
      log.calls.push("dispose");
      log.disposed += 1;
    },
  });
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
  readonly agentOptions?: { readonly promptError?: Error; readonly reply?: string };
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

  it("drains in-flight turns before disposing the agent, then the store", async () => {
    const lifecycle: string[] = [];
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
