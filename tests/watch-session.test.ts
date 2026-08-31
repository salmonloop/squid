import { existsSync, readFileSync } from "node:fs";
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
    /**
     * A factory that cannot open a session at all — the shape an unconfigured
     * model produces. A session that starts anyway proves creation was skipped,
     * not that this factory is special.
     */
    readonly factoryError?: Error;
  } = {},
): ResidentSessionFactory {
  return async (): Promise<ResidentSession> => {
    if (options.factoryError !== undefined) throw options.factoryError;
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
    readonly factoryError?: Error;
  };
  /** Overrides the model-configuration probe, for the headless-needs-config tests. */
  readonly agentConfigured?: boolean;
  /**
   * Overrides the default fake factory, for tests that must count or vary the
   * builds themselves — the needs_config recovery, say, where the interesting
   * fact is how many times the factory was ever called.
   */
  readonly createAgentSession?: ResidentSessionFactory;
  /**
   * Settings-store wiring for the panel's config tests. Every suite that mounts
   * the panel forwards all of them: without an injected `agentDir` the config
   * service falls back to Pi's own defaults and the test would read — or, on a
   * model set, *write* — the developer machine's Pi files.
   */
  readonly configPath?: string;
  readonly agentDir?: string;
  readonly modelProvider?: string;
  readonly defaultModelId?: string;
  readonly defaultBaseUrl?: string;
  /** The restart handoff; tests inject a spy instead of ending the process. */
  readonly restartExit?: () => void;
}) {
  const seenContexts: WatchSourceContext[] = [];
  const agentLog = options.agentLog ?? emptyAgentLog();
  const result = await startWatchSession({
    workingDirectory: "/tmp",
    env: options.env ?? OFFLINE_ENV,
    log: options.log ?? (() => {}),
    logError: options.logError ?? (() => {}),
    createAgentSession: options.createAgentSession ?? fakeAgentFactory(agentLog, options.agentOptions ?? {}),
    ...(options.agentConfigured === undefined ? {} : { agentConfigured: options.agentConfigured }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
    ...(options.modelProvider === undefined ? {} : { modelProvider: options.modelProvider }),
    ...(options.defaultModelId === undefined ? {} : { defaultModelId: options.defaultModelId }),
    ...(options.defaultBaseUrl === undefined ? {} : { defaultBaseUrl: options.defaultBaseUrl }),
    ...(options.restartExit === undefined ? {} : { restartExit: options.restartExit }),
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
 * `Bun.connect`, not `node:net`'s `connect`: both open a named pipe on Windows
 * from the same endpoint spelling. Round three of this suite measured that
 * swapping one for the other changed nothing, which retires the earlier claim
 * written here — that the gap was Bun's `node:net` read path on Windows pipes.
 * It was not.
 *
 * The real gap is a registration race. The server registers a client in its
 * `open` handler, and `broadcast` is a one-shot pass over whoever is registered
 * *at that moment* — nothing is re-delivered. On Unix the registration has
 * landed by the time `Bun.connect` resolves, so "connected" already means
 * "registered". On Windows it does not: a broadcast issued straight after a
 * connect is received by nobody. `tests/panel-server.test.ts` bridges this by
 * waiting for `clientCount === 1`, but the session owns its panel server and
 * deliberately does not expose it — and it should not have to, for a test to
 * work.
 *
 * So the handshake lives in the client. `ready()` sends one deliberately
 * malformed probe line after connecting; the server refuses it with a
 * diagnostic that can only be produced once the client is registered, because
 * the `data` handler ignores unregistered sockets. The probe is side-effect
 * free — it fails JSON parsing before any control op is even considered.
 * Waiting for that diagnostic makes "ready" mean what the tests below need:
 * from here on, every broadcast reaches this client.
 */
class PanelTestClient {
  readonly lines: string[] = [];
  private carry = "";
  private socket: Socket<undefined> | null = null;
  private readonly opened: Promise<void>;
  private readonly diagnostics: readonly string[];

  public constructor(socketPath: string, diagnostics: readonly string[]) {
    this.diagnostics = diagnostics;
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
    // One probe, then wait for its refusal. The diagnostic names no client, but
    // the session's logError channel carries only this panel's diagnostics, and
    // the only lines a freshly connected client can provoke are its own
    // refusals — so a hit here is this client's handshake, not someone else's.
    this.socket?.write("probe\n");
    const deadline = Date.now() + 2000;
    for (;;) {
      if (this.diagnostics.some((line) => line.includes("Panel line refused"))) return;
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for the panel server to register this client");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
 * platform-independent logic under test on both platforms. `Bun.connect` takes
 * the same endpoint spelling and opens a named pipe on Windows, a Unix socket
 * elsewhere, so `PanelTestClient` needs no branch of its own.
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
    const diagnostics: string[] = [];
    const { result } = await startSession({
      sources: [source],
      env: { SQUID_PANEL_SOCKET: socketPath },
      logError: (line) => diagnostics.push(line),
    });
    if ("configError" in result) throw new Error(result.configError);
    try {
      expect(result.session.banner.panel).toBe(socketPath);
      const client = new PanelTestClient(socketPath, diagnostics);
      await client.ready();

      // Every attach opens with the service state — a normal session says
      // `ready`, so a panel never has to infer readiness from silence.
      const service = await waitForLine(() =>
        client.lines
          .map(parsePanelLine)
          .find((parsed) => parsed.type === "service"),
      );
      expect(service.agentState).toBe("ready");

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
    const diagnostics: string[] = [];
    const source = new ScriptedSource("alpha", []);
    const { result } = await startSession({
      sources: [source],
      env: { SQUID_PANEL_SOCKET: socketPath },
      agentOptions: { reply: "ran the tests; they pass" },
      logError: (line) => diagnostics.push(line),
    });
    if ("configError" in result) throw new Error(result.configError);
    try {
      const client = new PanelTestClient(socketPath, diagnostics);
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
    const diagnostics: string[] = [];
    const source = new ScriptedSource("alpha", []);
    const { result } = await startSession({
      sources: [source],
      env: { SQUID_PANEL_SOCKET: socketPath },
      agentOptions: { promptError: new Error("the model refused") },
      logError: (line) => diagnostics.push(line),
    });
    if ("configError" in result) throw new Error(result.configError);
    try {
      const client = new PanelTestClient(socketPath, diagnostics);
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
    const diagnostics: string[] = [];
    const source = new ScriptedSource("screen", []);
    const { result } = await startSession({
      sources: [source],
      env: { SQUID_PANEL_SOCKET: socketPath },
      logError: (line) => diagnostics.push(line),
    });
    if ("configError" in result) throw new Error(result.configError);
    try {
      const client = new PanelTestClient(socketPath, diagnostics);
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
    const diagnostics: string[] = [];
    const source = new ScriptedSource("alpha", []);
    const { result } = await startSession({
      sources: [source],
      env: {
        SQUID_PANEL_SOCKET: socketPath,
        SQUID_CONTROL: "fifo",
        SQUID_CONTROL_FIFO: commandPath,
        SQUID_CONTROL_POLL_MS: "10",
      },
      logError: (line) => diagnostics.push(line),
    });
    if ("configError" in result) throw new Error(result.configError);
    try {
      const client = new PanelTestClient(socketPath, diagnostics);
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

  /**
   * The headless state: model unconfigured, panel mounted. The session starts
   * anyway and says so on the wire — capture and the panel run, no turn ever
   * does. This is what the panel-first flow sits on: the settings form has to
   * be reachable to repair the configuration, so startup cannot die first.
   */
  it("starts agentless with a panel when the model is unconfigured, and says so on the wire", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squid-panel-"));
    const socketPath = panelEndpoint(dir);
    const diagnostics: string[] = [];
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result, agentLog } = await startSession({
      sources: [source],
      env: { SQUID_PANEL_SOCKET: socketPath },
      // A factory that would fail if anyone tried: the session starting at all
      // proves creation was skipped, not that this factory is special.
      agentOptions: { factoryError: new Error("No resident-agent model is configured") },
      agentConfigured: false,
      logError: (line) => diagnostics.push(line),
    });
    if ("configError" in result) throw new Error(result.configError);
    try {
      expect(result.session.banner.agent).toBe("needs_config");
      expect(result.session.agent).toBeUndefined();
      // Sources run exactly as always; the agent was never created.
      expect(lifecycle).toEqual(["start:alpha"]);
      expect(agentLog.disposed).toBe(0);

      const client = new PanelTestClient(socketPath, diagnostics);
      await client.ready();

      // The client attached after the announcement, so hearing the service
      // line here is the replay doing its job, not a startup broadcast.
      const service = await waitForLine(() =>
        client.lines.map(parsePanelLine).find((parsed) => parsed.type === "service"),
      );
      expect(service.agentState).toBe("needs_config");

      // The session is otherwise ordinary: events still land on the wire...
      await source.emit!(fileSaved("fs-1", "src/x.test.ts"));
      const world = await waitForLine(() =>
        client.lines.map(parsePanelLine).find((parsed) => parsed.type === "world_state"),
      );
      expect(world.lastEvent).toBe("file_saved");
      // ...and no agent line can exist, because no turn was ever started.
      expect(agentLog.calls).toEqual([]);

      await client.close();
    } finally {
      await result.session.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The no-panel branch is unchanged on purpose: without a window there is no
   * repair path, so an unconfigured model stays a startup failure with the
   * everything-built-above disposed.
   */
  it("still fails startup when the model is unconfigured and no panel can be told", async () => {
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result, agentLog } = await startSession({
      sources: [source],
      agentConfigured: false,
      agentOptions: { factoryError: new Error("No resident-agent model is configured") },
    });
    expect("configError" in result).toBe(true);
    if ("configError" in result) {
      expect(result.configError).toContain("The resident agent could not start");
      expect(result.configError).toContain("No resident-agent model is configured");
    }
    // The agent is created before any source starts, so a failed creation must
    // leave the sources unstarted rather than half-started.
    expect(lifecycle).toEqual([]);
    expect(agentLog.disposed).toBe(0);
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

  /**
   * The panel-first settings story, end to end on one socket: the panel asks
   * for the form's contents, sets a value, and the answer names the store it
   * actually wrote. Both stores live in a temp dir — the Squid config file and
   * Pi's models.json/auth.json — because only the files on disk prove which
   * store a set landed in; asserting on return values alone would let a
   * credential written to the wrong store pass unnoticed.
   */
  describe("the panel and the settings stores", () => {
    const API_KEY = "sk-test-1234567890";

    interface SettingsHarness {
      readonly dir: string;
      readonly configPath: string;
      readonly agentDir: string;
      readonly diagnostics: string[];
      readonly restartCalls: number[];
      readonly session: { stop(): Promise<void> };
      readonly client: PanelTestClient;
      readonly close: () => Promise<void>;
    }

    /**
     * One session, one panel client, both stores under one temp dir.
     * `supervised` decides the restart contract; the factory is healthy so a
     * model set can actually start an agent through it.
     */
    const startSettingsSession = async (supervised: boolean): Promise<SettingsHarness> => {
      const dir = await mkdtemp(join(tmpdir(), "squid-settings-"));
      const socketPath = panelEndpoint(dir);
      const diagnostics: string[] = [];
      const restartCalls: number[] = [];
      const source = new ScriptedSource("alpha", []);
      const { result } = await startSession({
        sources: [source],
        env: {
          SQUID_PANEL_SOCKET: socketPath,
          ...(supervised ? { SQUID_SUPERVISED: "1" } : {}),
        },
        configPath: join(dir, "config.json"),
        agentDir: join(dir, "agent"),
        modelProvider: "bifrost",
        defaultModelId: "deepseek-v4-flash",
        defaultBaseUrl: "https://default.example/v1",
        restartExit: () => {
          restartCalls.push(1);
        },
        logError: (line) => diagnostics.push(line),
      });
      if ("configError" in result) throw new Error(result.configError);
      const client = new PanelTestClient(socketPath, diagnostics);
      await client.ready();
      return {
        dir,
        configPath: join(dir, "config.json"),
        agentDir: join(dir, "agent"),
        diagnostics,
        restartCalls,
        session: result.session,
        client,
        close: async () => {
          await client.close();
          await result.session.stop();
          await rm(dir, { recursive: true, force: true });
        },
      };
    };

    /** Waits for the dump to finish and returns the config rows in wire order. */
    const awaitConfigEnd = async (client: PanelTestClient): Promise<Record<string, unknown>[]> => {
      const deadline = Date.now() + 2000;
      for (;;) {
        const parsed = client.lines.map(parsePanelLine);
        if (parsed.some((p) => p.type === "config_end")) {
          return parsed.filter((p) => p.type === "config");
        }
        if (Date.now() > deadline) throw new Error("config_get never completed");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    /** Waits for one config_result naming a given id. */
    const awaitConfigResult = async (
      client: PanelTestClient,
      id: string,
    ): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 2000;
      for (;;) {
        const found = client.lines
          .map(parsePanelLine)
          .find((p) => p.type === "config_result" && p.id === id);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`no config_result for ${id}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    it("answers config_get with the whole form, model rows first, and counts it", async () => {
      const h = await startSettingsSession(false);
      try {
        h.client.send(JSON.stringify({ type: "config_get" }));
        const configs = await awaitConfigEnd(h.client);
        // Three model rows lead, then every file-backed row in schema order —
        // the form IS the dump, so the panel never hardcodes a key name.
        expect(configs).toHaveLength(18);
        const baseUrlRow = configs[0];
        if (baseUrlRow === undefined) throw new Error("the dump is missing the modelBaseUrl row");
        const apiKeyRow = configs[2];
        if (apiKeyRow === undefined) throw new Error("the dump is missing the apiKey row");
        const lastRow = configs[17];
        if (lastRow === undefined) throw new Error("the dump is missing the 18th row");
        expect(baseUrlRow.id).toBe("modelBaseUrl");
        expect(baseUrlRow.kind).toBe("text");
        // The dump shows what the FILE holds — empty on a fresh agentDir. The
        // default base URL is a write-time fallback, never a display value.
        expect(baseUrlRow.value).toBe("");
        expect(apiKeyRow.id).toBe("apiKey");
        expect(apiKeyRow.kind).toBe("secret");
        // The stored value is nothing the panel may hold; the dump strips it.
        expect(apiKeyRow.value).toBe("");
        expect(lastRow.id).toBe("excludeApplications");
        const end = h.client.lines.map(parsePanelLine).find((p) => p.type === "config_end");
        expect(end?.count).toBe(18);
      } finally {
        await h.close();
      }
    });

    it("writes a file-backed set to the Squid config file and says restart", async () => {
      const h = await startSettingsSession(false);
      try {
        h.client.send(JSON.stringify({ type: "config_set", id: "retentionHours", value: "72" }));
        const result = await awaitConfigResult(h.client, "retentionHours");
        expect(result.ok).toBe(1);
        // File-backed settings are read once at startup; only a restart lands
        // them, and the result says which.
        expect(result.applies).toBe("restart");
        const onDisk = JSON.parse(readFileSync(h.configPath, "utf8")) as Record<string, string>;
        expect(onDisk.retentionHours).toBe("72");
      } finally {
        await h.close();
      }
    });

    it("refuses an invalid file-backed set with the schema's message", async () => {
      const h = await startSettingsSession(false);
      try {
        h.client.send(JSON.stringify({ type: "config_set", id: "retentionHours", value: "1e3" }));
        const result = await awaitConfigResult(h.client, "retentionHours");
        expect(result.ok).toBe(0);
        expect(String(result.error)).toContain("Retention (hours)");
        expect(existsSync(h.configPath)).toBe(false);
      } finally {
        await h.close();
      }
    });

    it("starts the agent in-session when a model set unblocks needs_config", async () => {
      // The factory counts its builds: needs_config startup must NOT call it
      // (building the agent is exactly what needs_config skips), and the
      // recovery must call it exactly once — proving the agent started
      // in-session rather than the process having quietly restarted.
      const dir = await mkdtemp(join(tmpdir(), "squid-settings-"));
      const socketPath = panelEndpoint(dir);
      const diagnostics: string[] = [];
      let builds = 0;
      // The recovered agent delegates to the ordinary fake so it behaves
      // exactly like a started-from-scratch one.
      const working = fakeAgentFactory(emptyAgentLog(), {});
      const factory: ResidentSessionFactory = async (spec) => {
        builds += 1;
        return working(spec);
      };
      const source = new ScriptedSource("alpha", []);
      const { result } = await startSession({
        sources: [source],
        env: { SQUID_PANEL_SOCKET: socketPath },
        agentConfigured: false,
        createAgentSession: factory,
        configPath: join(dir, "config.json"),
        agentDir: join(dir, "agent"),
        modelProvider: "bifrost",
        defaultModelId: "deepseek-v4-flash",
        defaultBaseUrl: "https://default.example/v1",
        logError: (line) => diagnostics.push(line),
      });
      if ("configError" in result) throw new Error(result.configError);
      const client = new PanelTestClient(socketPath, diagnostics);
      try {
        expect(result.session.banner.agent).toBe("needs_config");
        await client.ready();
        const serviceBefore = await waitForLine(() =>
          client.lines.map(parsePanelLine).find((p) => p.type === "service"),
        );
        expect(serviceBefore.agentState).toBe("needs_config");

        client.send(JSON.stringify({ type: "config_set", id: "apiKey", value: API_KEY }));
        const setResult = await awaitConfigResult(client, "apiKey");
        expect(setResult.ok).toBe(1);
        const serviceAfter = await waitForLine(() => {
          const services = client.lines.map(parsePanelLine).filter((p) => p.type === "service");
          return services.length > 1 ? services[1] : undefined;
        });
        expect(serviceAfter.agentState).toBe("ready");
        // Exactly one build, and it happened during recovery, not startup: the
        // process never restarted, the agent just came up in-session.
        expect(builds).toBe(1);
        expect(result.session.banner.agent).toBe("needs_config");
      } finally {
        await client.close();
        await result.session.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("refuses a restart from an unsupervised run and keeps the session alive", async () => {
      const h = await startSettingsSession(false);
      try {
        h.client.send(JSON.stringify({ type: "control", op: "restart" }));
        const deadline = Date.now() + 2000;
        for (;;) {
          if (h.diagnostics.some((line) => line.includes("SQUID_SUPERVISED"))) break;
          if (Date.now() > deadline) throw new Error("restart was not refused");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        // Refusal, not shutdown: the run keeps serving its panel. The proof is
        // a follow-up round-trip, not the temp dir merely existing.
        expect(h.restartCalls).toEqual([]);
        h.client.send(JSON.stringify({ type: "config_get" }));
        await awaitConfigEnd(h.client);
      } finally {
        await h.close();
      }
    });

    it("hands the process to the supervisor with a supervised restart", async () => {
      const h = await startSettingsSession(true);
      try {
        h.client.send(JSON.stringify({ type: "control", op: "restart" }));
        const deadline = Date.now() + 2000;
        for (;;) {
          if (h.restartCalls.length > 0) break;
          if (Date.now() > deadline) throw new Error("restart never reached the exit hook");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        // The stop runs in the ordinary order BEFORE the handoff: the sources'
        // teardown is observable in the same lifecycle the start tests use.
        expect(h.restartCalls).toEqual([1]);
      } finally {
        // stop() is idempotent (the session guards with `stopped`), so an
        // already-restarted session settles quietly here.
        await h.close();
      }
    });

    it("never puts the API key on the wire, even after setting it", async () => {
      const h = await startSettingsSession(false);
      try {
        h.client.send(JSON.stringify({ type: "config_set", id: "apiKey", value: API_KEY }));
        const setResult = await awaitConfigResult(h.client, "apiKey");
        expect(setResult.ok).toBe(1);
        // The credential landed in Pi's own store...
        const auth = JSON.parse(readFileSync(join(h.agentDir, "auth.json"), "utf8")) as {
          bifrost: { key: string };
        };
        expect(auth.bifrost.key).toBe(API_KEY);
        // ...and a fresh dump afterwards carries no trace of it: the secret's
        // value is structurally absent from every line the session can send.
        h.client.send(JSON.stringify({ type: "config_get" }));
        await awaitConfigEnd(h.client);
        for (const raw of h.client.lines) {
          expect(raw).not.toContain(API_KEY);
        }
      } finally {
        await h.close();
      }
    });
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
    const diagnostics: string[] = [];
    const { result } = await startSession({
      sources: [source],
      env: { SQUID_PANEL_SOCKET: socketPath },
      logError: (line) => diagnostics.push(line),
    });
    if ("configError" in result) throw new Error(result.configError);
    try {
      const client = new PanelTestClient(socketPath, diagnostics);
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
