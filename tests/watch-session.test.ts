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
import { buildLedgerReport } from "../src/ledger-report.js";
import { isShadowProvider } from "../src/shadow-ledger.js";

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

/** A failed test run: the world both the heuristic and `debug_failure` fire on. */
function terminalCommandFailed(eventId: string): ActivityEvent {
  return createActivityEvent({
    kind: "terminal_command_completed",
    eventId,
    source: { kind: "host", instanceId: "term-1" },
    sessionId: "term-session",
    sequence: 0,
    payload: { commandClass: "test", succeeded: false, exitCode: 1 },
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
  readonly env?: Record<string, string | undefined>;
  readonly log?: (line: string) => void;
  readonly logError?: (line: string) => void;
}) {
  const seenContexts: WatchSourceContext[] = [];
  const result = await startWatchSession({
    workingDirectory: "/tmp",
    env: options.env ?? OFFLINE_ENV,
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

  it("reports a config error rather than starting when shadow mode is malformed", async () => {
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const result = await startWatchSession({
      workingDirectory: "/tmp",
      env: { SQUID_SHADOW_COGNITION: "yes" },
      log: () => {},
      logError: () => {},
      createSources: async () => [source],
      describeEvent: () => ({}),
    });

    expect("configError" in result).toBe(true);
    if ("configError" in result) {
      expect(result.configError).toContain("SQUID_SHADOW_COGNITION");
    }
    // A typo that quietly disabled shadow mode would leave an operator reading a
    // ledger with no shadow attempts and concluding the cognition path agrees with
    // the heuristic everywhere, when in fact it never ran.
    expect(source.started).toBe(false);
  });

  it("says shadow mode is off by default, changing nothing about the ledger", async () => {
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result } = await startSession({ sources: [source] });
    if ("configError" in result) throw new Error(result.configError);

    expect(result.session.banner.shadow).toBe("off");

    await source.emit!(terminalCommandFailed("term-1"));
    await result.session.runtime.runtime.awaitIdle();
    await result.session.stop();

    const attempts = (await result.session.runtime.ledger.all())
      .filter((record) => record.recordType === "attempt");
    expect(attempts).toHaveLength(1);
    expect(attempts.every((attempt) => !isShadowProvider(attempt.provider))).toBe(true);
  });

  /**
   * The fourth done-when of issue #4, end to end: both paths run, both are
   * ledgered, `bun run ledger:report` distinguishes them, and neither shadow
   * record can be dispatched.
   */
  it("runs both paths, ledgers both, and dispatches neither", async () => {
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result } = await startSession({
      sources: [source],
      env: { ...OFFLINE_ENV, SQUID_SHADOW_COGNITION: "on" },
    });
    if ("configError" in result) throw new Error(result.configError);
    const { session } = result;

    expect(session.banner.shadow).toBe("cognition");

    await source.emit!(terminalCommandFailed("term-1"));
    await session.runtime.runtime.awaitIdle();
    // Drains the shadow runs and their ledger appends, then closes the sinks.
    await session.stop();

    const report = buildLedgerReport(await session.runtime.ledger.all());
    // One ingest, two opinions about it, told apart by provider name.
    expect(report.paths.live.attempts).toBe(1);
    expect(report.paths.shadow.attempts).toBe(1);
    expect(report.paths.live.byProvider).toEqual({ heuristic: 1 });
    expect(report.paths.shadow.byProvider).toEqual({ "shadow:belief-rerank": 1 });
    // The top level is still the live path alone, so a report predating shadow
    // mode is comparing the same quantity.
    expect(report.attempts).toBe(1);

    const records = await session.runtime.ledger.all();
    const shadow = records.find(
      (record) => record.recordType === "attempt" && isShadowProvider(record.provider),
    );
    const live = records.find(
      (record) => record.recordType === "attempt" && !isShadowProvider(record.provider),
    );
    if (shadow?.recordType !== "attempt" || live?.recordType !== "attempt") {
      throw new Error("expected one live and one shadow attempt");
    }

    // Both describe the same ingest, so retention deletion removes them together
    // rather than orphaning one.
    expect(shadow.triggerEventId).toBe(live.triggerEventId);
    expect(shadow.stateDigest).toBe(live.stateDigest);
    // And the shadow record is unreachable by a claim: its request id is outside
    // the namespace `claimDispatch` looks in, and its trust level is what
    // `action-admission.ts` refuses on.
    expect(shadow.requestId).toBe(`${live.requestId}:shadow`);
    expect(shadow.actionTrust).toBe("suggestion_only");
    // The belief layer really ran — the failed command is a world the
    // `debug_failure` rule fires on.
    expect(shadow.fallbackReason).toBe("beliefs=succeeded");
    expect(shadow.candidates.map((candidate) => candidate.kind)).toEqual(["inspect_error"]);
  });

  /**
   * A cognition run must be distinguishable from one whose belief layer is
   * refusing every batch. Both predict; they differ only in the ranking, and a
   * wrong ranking reads as a bad model rather than a starved one — so the belief
   * status has to be observable, or the fidelity of the gate is unverifiable in
   * production.
   */
  it("reports belief outcomes in a cognition run", async () => {
    const errors: string[] = [];
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result } = await startSession({
      sources: [source],
      // `probe` keeps the run at suggestion_only, which is enough to observe the
      // belief layer without also admitting dispatch.
      env: { ...OFFLINE_ENV, SQUID_PROVIDER: "cognition", SQUID_PROVIDER_GATE: "probe" },
      logError: (line) => errors.push(line),
    });
    if ("configError" in result) throw new Error(result.configError);

    expect(result.session.banner.provider).toBe("belief-rerank");

    await source.emit!(terminalCommandFailed("term-1"));
    await result.session.runtime.runtime.awaitIdle();
    await result.session.stop();

    const outcomes = errors
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.diagnostic === "belief_outcome");
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes[0]!.provider).toBe("heuristic-belief");
    // A failed command is a world the `debug_failure` rule fires on, so this run
    // genuinely had beliefs rather than merely reporting a status.
    expect(outcomes[0]!.status).toBe("succeeded");
    // Status and reason codes only — never the batch, whose beliefs stay inside
    // the prediction path.
    expect(outcomes[0]).not.toHaveProperty("batch");
    expect(outcomes[0]).not.toHaveProperty("beliefs");
  });

  /**
   * Issue #12's first half, end to end: a belief is inferred, used to rank one
   * prediction, and now *kept*. Before this the batch was discarded the moment the
   * request settled, so a session accumulated nothing — the ledger held attempts
   * and no record of what the belief layer had asserted.
   *
   * Asserted through a real session rather than by calling the ledger directly,
   * because what was missing was the wiring: the provider is resolved before any
   * sink exists, so nothing had a ledger to write to at the point beliefs were
   * produced. A unit test of `appendBeliefBatch` would have passed throughout.
   */
  it("persists the belief batch a cognition run inferred", async () => {
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result } = await startSession({
      sources: [source],
      env: { ...OFFLINE_ENV, SQUID_PROVIDER: "cognition", SQUID_PROVIDER_GATE: "probe" },
    });
    if ("configError" in result) throw new Error(result.configError);
    const { session } = result;

    await source.emit!(terminalCommandFailed("term-1"));
    await session.runtime.runtime.awaitIdle();
    // Belief writes start inside the prediction, so the drain in `stop` is what
    // makes them observable — closing the ledger under one would lose the record.
    await session.stop();

    const records = await session.runtime.ledger.all();
    const batches = records.filter((record) => record.recordType === "belief_batch");
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    if (batch.recordType !== "belief_batch") throw new Error("expected a belief batch");

    // The failed command is a world the `debug_failure` rule fires on, so this
    // asserts a real inference was stored rather than an empty shell.
    expect(batch.provider).toBe("heuristic-belief");
    expect(batch.batch.beliefs.map((belief) => belief.value)).toEqual(["debug_failure"]);

    // Stored against the projection it actually described. The digest is what makes
    // the record auditable — and what makes reusing it as evidence impossible,
    // since the next ingest moves it.
    const live = records.find(
      (record) => record.recordType === "attempt" && !isShadowProvider(record.provider),
    );
    if (live?.recordType !== "attempt") throw new Error("expected a live attempt");
    expect(batch.batch.stateDigest).toBe(live.stateDigest);
    expect(batch.batch.projectionGeneration).toBe(live.projectionGeneration);
    expect(batch.requestId).toBe(live.requestId);

    // And the beliefs cite the event that produced them, which is what retention
    // deletion follows.
    expect(batch.batch.beliefs.flatMap((belief) => belief.evidenceEventIds))
      .toContain(live.triggerEventId);

    // Legible to an operator through the same report the rest of the run is.
    expect(buildLedgerReport(records).beliefs).toEqual({
      batches: 1,
      byProvider: { "heuristic-belief": 1 },
      byValue: { debug_failure: 1 },
    });
  });

  it("writes no belief record on the default heuristic path", async () => {
    // The default provider has no belief layer, so a batch appearing here would
    // mean something was fabricating one. Kept as a test because the seam is
    // wired unconditionally — only the cognition branch installs an observer.
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result } = await startSession({ sources: [source] });
    if ("configError" in result) throw new Error(result.configError);

    await source.emit!(terminalCommandFailed("term-1"));
    await result.session.runtime.runtime.awaitIdle();
    await result.session.stop();

    const records = await result.session.runtime.ledger.all();
    expect(records.filter((record) => record.recordType === "belief_batch")).toEqual([]);
  });

  /**
   * The drop this covers is invisible by construction, which is why it needs a
   * test rather than an inspection: a shadow run only starts inside the
   * continuation chained onto a resolved prediction, and the runtime drains the
   * prediction but knows nothing about that chain. Stop without awaiting it and
   * `observe` hits its disposed guard — no run, no record, and no diagnostic
   * either, so the ledger simply has one fewer shadow attempt than ingests.
   *
   * Stopping without `awaitIdle` first is exactly the shutdown a signal handler
   * performs, so this is the real ordering rather than a contrived one.
   */
  it("records a shadow run for a prediction still in flight at stop", async () => {
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result } = await startSession({
      sources: [source],
      env: { ...OFFLINE_ENV, SQUID_SHADOW_COGNITION: "on" },
    });
    if ("configError" in result) throw new Error(result.configError);

    await source.emit!(terminalCommandFailed("term-1"));
    // Deliberately no `awaitIdle()`: stop() has to settle the shadow path itself.
    await result.session.stop();

    const report = buildLedgerReport(await result.session.runtime.ledger.all());
    expect(report.paths.live.attempts).toBe(1);
    expect(report.paths.shadow.attempts).toBe(1);
  });

  it("logs the shadow run in counts and kinds, never in content", async () => {
    const lines: string[] = [];
    const lifecycle: string[] = [];
    const source = new ScriptedSource("alpha", lifecycle);
    const { result } = await startSession({
      sources: [source],
      env: { ...OFFLINE_ENV, SQUID_SHADOW_COGNITION: "on" },
      log: (line) => lines.push(line),
    });
    if ("configError" in result) throw new Error(result.configError);

    await source.emit!(terminalCommandFailed("term-1"));
    await result.session.runtime.runtime.awaitIdle();
    await result.session.stop();

    const shadowLine = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.shadowProvider !== undefined);
    expect(shadowLine).toBeDefined();
    expect(shadowLine!.shadowProvider).toBe("belief-rerank");
    expect(shadowLine!.beliefStatus).toBe("succeeded");
    // Closed vocabularies only: belief values are an enum and candidate kinds are
    // an enum, so nothing here can echo a selection or a path.
    expect(shadowLine!.beliefValues).toEqual(["debug_failure"]);
    expect(shadowLine!.shadowPredictions).toEqual(["inspect_error"]);
    expect(shadowLine!.top1Agrees).toBe(true);
  });
});
