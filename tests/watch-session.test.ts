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
import { SqlitePredictionLedger } from "../src/sqlite-prediction-ledger.js";

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

/** Env with actions and any model off: the default posture both watches ship. */
const OFFLINE_ENV: Record<string, string | undefined> = {};

async function startSession(options: {
  readonly sources: readonly ActivitySource[];
  readonly log?: (line: string) => void;
  readonly logError?: (line: string) => void;
}) {
  const seenContexts: WatchSourceContext[] = [];
  const result = await startWatchSession({
    workingDirectory: "/tmp",
    env: OFFLINE_ENV,
    log: options.log ?? (() => {}),
    logError: options.logError ?? (() => {}),
    createSources: async (context) => {
      seenContexts.push(context);
      return options.sources;
    },
    describeEvent: (event, ingested) => ({
      kind: event.kind,
      disposition: ingested.ingest.disposition,
    }),
  });
  return { result, seenContexts };
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
    // Reverse order matters: a later source must never emit into a runtime a
    // earlier one has already begun tearing down.
    expect(lifecycle).toEqual(["start:alpha", "start:beta", "stop:beta", "stop:alpha"]);
  });

  /**
   * The reason this module exists. `admitRunTests` compares the owner of the
   * newest save against the foreground application, and no single source can
   * produce both facts: the filesystem source reports a path with
   * `applicationId: null`, and only a screen source knows what is in front.
   * A session must therefore project both streams into one state.
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
    // in the foreground is the guess the projection refuses to make, and
    // admission still rejects on it — see the filesystem-save-run-tests fixture.
    expect(save?.applicationId).toBeNull();

    await result.session.stop();
  });

  it("shares one store, ledger, and runtime across sources", async () => {
    const lifecycle: string[] = [];
    const first = new ScriptedSource("alpha", lifecycle);
    const second = new ScriptedSource("beta", lifecycle);
    const { result } = await startSession({ sources: [first, second] });
    if ("configError" in result) throw new Error(result.configError);

    await first.emit!(fileSaved("fs-1", "a.ts"));
    await second.emit!(fileSaved("fs-2", "b.ts"));
    await result.session.runtime.runtime.awaitIdle();

    const stored = await result.session.runtime.store.all();
    expect(stored).toHaveLength(2);
    await result.session.stop();
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
    // In-memory run: no sink paths, which is what keeps a filesystem source from
    // computing exclusions it does not need.
    expect(context.databasePath).toBeUndefined();
    expect(context.ledgerPath).toBeUndefined();

    const diagnostic: ActivitySourceDiagnostic = {
      kind: "watcher_error",
      message: "a watcher failed",
      occurredAt: new Date().toISOString(),
    };
    context.onDiagnostic(diagnostic);
    expect(logged.some((line) => line.includes("a watcher failed"))).toBe(true);

    await result.session.stop();
  });

  it("refuses a session with no sources instead of running a blind core", async () => {
    const { result } = await startSession({ sources: [] });
    expect("configError" in result && result.configError).toContain("at least one activity source");
  });

  it("stops already-started sources when a later one fails to start", async () => {
    const lifecycle: string[] = [];
    const healthy = new ScriptedSource("alpha", lifecycle);
    const broken = new ScriptedSource("beta", lifecycle, new Error("reader unavailable"));

    const { result } = await startSession({ sources: [healthy, broken] });

    // A half-started session is worse than none: the caller has no handle to
    // stop the source that did start, so the session must unwind itself.
    expect("configError" in result).toBe(true);
    if ("configError" in result) {
      expect(result.configError).toContain("reader unavailable");
    }
    expect(healthy.stopped).toBe(true);
  });

  it("reports a config error rather than starting when egress is malformed", async () => {
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const result = await startWatchSession({
      workingDirectory: "/tmp",
      env: { SQUID_SEARCH_EGRESS: "Allow" },
      log: () => {},
      logError: () => {},
      createSources: async () => [source],
      describeEvent: () => ({}),
    });

    expect("configError" in result).toBe(true);
    // Refused before the source was ever constructed.
    expect(lifecycle).toEqual([]);
    expect(source.started).toBe(false);
  });

  it("names every source in the startup banner", async () => {
    const lifecycle: string[] = [];
    const { result } = await startSession({
      sources: [new ScriptedSource("filesystem", lifecycle), new ScriptedSource("screen", lifecycle)],
    });
    if ("configError" in result) throw new Error(result.configError);

    expect(result.session.banner.sources).toBe("filesystem,screen");
    expect(result.session.banner.store).toBe("memory");
    expect(result.session.banner.ledger).toBe("memory");
    await result.session.stop();
  });

  it("is idempotent on stop so a second signal cannot double-dispose", async () => {
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result } = await startSession({ sources: [source] });
    if ("configError" in result) throw new Error(result.configError);

    await result.session.stop();
    await result.session.stop();
    expect(lifecycle.filter((entry) => entry === "stop:alpha")).toHaveLength(1);
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
    await result.session.stop();
  });

  it("reports a config error rather than starting when retention is malformed", async () => {
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const result = await startWatchSession({
      workingDirectory: "/tmp",
      env: { SQUID_RETENTION_HOURS: "soon" },
      log: () => {},
      logError: () => {},
      createSources: async () => [source],
      describeEvent: () => ({}),
    });

    expect("configError" in result).toBe(true);
    if ("configError" in result) {
      expect(result.configError).toContain("SQUID_RETENTION_HOURS");
    }
    // Same refusal posture as egress: nothing starts on a policy that cannot
    // be honored, and the error names the variable the user must fix.
    expect(lifecycle).toEqual([]);
    expect(source.started).toBe(false);
  });

  /**
   * Retention prunes before restore, and both halves are observable without a
   * test hook: the prune through the durable database it empties (the seeded
   * ancient event is gone), the ordering through the dedupe index — an event
   * restored from history replays as "duplicate", while one deleted before
   * restore is accepted as new. The session needs a real SQLite pairing here
   * because the in-memory stores have nothing to persist between seeding and
   * startup.
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
