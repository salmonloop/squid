import { describe, expect, it } from "bun:test";
import { HeuristicPredictor } from "../src/baseline-predictor.js";
import { evidenceTimeline } from "../src/belief-evidence.js";
import { BeliefRerankCognition } from "../src/belief-rerank-cognition.js";
import { NoBeliefsError, type BeliefProvider } from "../src/belief-provider.js";
import { PassthroughContextPolicy } from "../src/context-policy.js";
import { InMemoryEventStore } from "../src/event-store.js";
import { HeuristicBeliefProvider } from "../src/heuristic-belief-provider.js";
import { buildLedgerReport } from "../src/ledger-report.js";
import {
  InMemoryPredictionLedger,
  candidateEnvelopes,
  createAttemptRecord,
} from "../src/prediction-ledger.js";
import type { PredictionOutcome } from "../src/prediction-provider.js";
import { createActivityEvent, type ActivityEvent, type WorldState } from "../src/protocol.js";
import { resolveShadowCognition } from "../src/resolve-shadow-cognition.js";
import {
  ShadowCognitionRunner,
  buildShadowReport,
  type ShadowObservation,
  type ShadowProjectionContext,
} from "../src/shadow-cognition.js";
import {
  createShadowAttemptRecord,
  isShadowProvider,
  shadowProviderName,
  shadowRequestId,
} from "../src/shadow-ledger.js";
import { SquidCore } from "../src/squid-core.js";

/**
 * Shadow mode's whole claim is that it can be measured without being able to
 * cause anything. These tests hold it to both halves: the observation and the
 * record it becomes really do describe the cognition path, and the record really
 * is unreachable by the dispatch machinery.
 */

const session = "shadow-session";
const source = { kind: "synthetic" as const, instanceId: "shadow" };

function event<TPayload>(input: {
  eventId: string;
  sequence: number;
  occurredAt: string;
  kind: Parameters<typeof createActivityEvent<TPayload>>[0]["kind"];
  payload: TPayload;
}): ActivityEvent<TPayload> {
  return createActivityEvent({ ...input, source, sessionId: session });
}

/** A failed test run: the world the `debug_failure` rule fires on. */
const failedCommandEvents: readonly ActivityEvent[] = [
  event({
    eventId: "term-app",
    sequence: 0,
    occurredAt: "2026-08-20T10:00:00.000Z",
    kind: "application_activated",
    payload: { applicationId: "com.terminal", applicationName: "Terminal" },
  }),
  event({
    eventId: "term-failure",
    sequence: 1,
    occurredAt: "2026-08-20T10:00:01.000Z",
    kind: "terminal_command_completed",
    payload: { commandClass: "test", succeeded: false, exitCode: 1 },
  }),
];

async function project(events: readonly ActivityEvent[]): Promise<{
  readonly state: WorldState;
  readonly context: ShadowProjectionContext;
}> {
  const core = new SquidCore(new InMemoryEventStore());
  let last = await core.ingest(events[0]!);
  for (const next of events.slice(1)) last = await core.ingest(next);
  return {
    state: last.state,
    context: {
      triggerEventId: events.at(-1)!.eventId,
      triggeredAt: last.state.updatedAt!,
      triggerDisposition: "accepted",
      stateDigest: last.stateDigest,
      projectionGeneration: last.projectionGeneration,
      contextPolicyId: new PassthroughContextPolicy().id,
    },
  };
}

function liveOutcome(state: WorldState, requestId = "live-1"): PredictionOutcome {
  return {
    requestId,
    provider: "heuristic",
    status: "succeeded",
    candidates: new HeuristicPredictor().predict(state, new Date(state.updatedAt!)),
    latencyMs: 3,
  };
}

/** Runs the shadow path once and returns the single observation it emitted. */
async function observeOnce(options: {
  readonly beliefProvider?: BeliefProvider;
  readonly events?: readonly ActivityEvent[];
} = {}): Promise<ShadowObservation> {
  const { state, context } = await project(options.events ?? failedCommandEvents);
  const observations: ShadowObservation[] = [];
  const runner = new ShadowCognitionRunner({
    beliefProvider: options.beliefProvider ?? new HeuristicBeliefProvider(),
    cognition: new BeliefRerankCognition(),
    onObservation: (observation) => observations.push(observation),
  });

  runner.observe({
    outcome: liveOutcome(state),
    worldState: state,
    context,
    eventOccurredAt: evidenceTimeline(state),
  });
  await runner.dispose();
  return observations[0]!;
}

describe("resolveShadowCognition", () => {
  it("is off when unset, on for the exact value, and a config error otherwise", () => {
    expect(resolveShadowCognition({ env: {} })).toEqual({ enabled: false });
    expect(resolveShadowCognition({ env: { SQUID_SHADOW_COGNITION: "on" } }))
      .toEqual({ enabled: true });

    // Strictness matters more here than it looks: a typo that quietly disabled
    // shadow mode would leave an operator reading a ledger with no shadow attempts
    // and concluding the cognition path agrees everywhere, when it never ran.
    for (const raw of ["", "ON", "1", "true", "cognition", "off"]) {
      const resolution = resolveShadowCognition({ env: { SQUID_SHADOW_COGNITION: raw } });
      expect("configError" in resolution).toBe(true);
    }
  });
});

describe("ShadowCognitionRunner", () => {
  it("reports what the cognition path would have done, and its belief status", async () => {
    const observation = await observeOnce();

    expect(observation.shadowProvider).toBe("belief-rerank");
    expect(observation.shadowStatus).toBe("succeeded");
    expect(observation.beliefStatus).toBe("succeeded");
    expect(observation.beliefValues).toEqual(["debug_failure"]);
    expect(observation.shadowCandidates.map((candidate) => candidate.kind))
      .toEqual(["inspect_error"]);
    expect(observation.top1Agrees).toBe(true);
  });

  it("echoes the projection it answered about, so the run is auditable alone", async () => {
    const { state, context } = await project(failedCommandEvents);
    const observation = await observeOnce();
    // Without this the caller would need a side-channel map from request id to
    // context, populated at observe time and cleaned up in the right order — a
    // bookkeeping step that leaks the first time a run never settles.
    expect(observation.context).toEqual(context);
    expect(observation.episodeId).toBe(state.episode!.id);
  });

  it("separates nothing-to-assert from a broken belief layer", async () => {
    const silent: BeliefProvider = {
      name: "silent-belief",
      infer: async (request) => { throw new NoBeliefsError(request.id); },
    };
    const broken: BeliefProvider = {
      name: "broken-belief",
      infer: async () => { throw new Error("belief service unreachable"); },
    };

    const quiet = await observeOnce({ beliefProvider: silent });
    expect(quiet.beliefStatus).toBe("none");
    expect(quiet.reasonCode).toBeUndefined();
    // Cognition still ran, from state alone. A belief outage must not silence the
    // shadow path, or an outage would read as agreement with the live path.
    expect(quiet.shadowStatus).toBe("succeeded");

    const outage = await observeOnce({ beliefProvider: broken });
    expect(outage.beliefStatus).toBe("failed");
    expect(outage.reasonCode).toContain("belief service unreachable");
    expect(outage.shadowStatus).toBe("succeeded");
  });

  it("refuses a batch that does not survive validation, without failing the run", async () => {
    const misreporting: BeliefProvider = {
      name: "misreporting-belief",
      infer: async (request, signal) => ({
        ...await new HeuristicBeliefProvider().infer(request, signal),
        stateDigest: `sha256:${"c".repeat(64)}`,
      }),
    };
    const observation = await observeOnce({ beliefProvider: misreporting });

    // `rejected` is not `failed`: a provider that returns stale or malformed
    // beliefs is a different problem from one that is unreachable, and a gate has
    // to be able to tell them apart.
    expect(observation.beliefStatus).toBe("rejected");
    expect(observation.shadowStatus).toBe("succeeded");
  });

  it("does nothing for a state with no episode, since a belief needs one", async () => {
    const observations: ShadowObservation[] = [];
    const runner = new ShadowCognitionRunner({
      beliefProvider: new HeuristicBeliefProvider(),
      cognition: new BeliefRerankCognition(),
      onObservation: (observation) => observations.push(observation),
    });
    const { context } = await project(failedCommandEvents);

    runner.observe({
      outcome: liveOutcome({ ...(await project(failedCommandEvents)).state, episode: null }),
      worldState: { ...(await project(failedCommandEvents)).state, episode: null },
      context,
      eventOccurredAt: new Map(),
    });
    await runner.dispose();
    expect(observations).toEqual([]);
  });

  it("aggregates observations into counts an operator can read", async () => {
    const report = buildShadowReport([await observeOnce(), await observeOnce()]);
    expect(report.observations).toBe(2);
    expect(report.shadowSucceeded).toBe(2);
    expect(report.beliefByStatus).toEqual({ succeeded: 2 });
    expect(report.beliefByValue).toEqual({ debug_failure: 2 });
    expect(report.top1Agreement).toBe(1);
    expect(report.shadowTop1ByKind).toEqual({ inspect_error: 2 });
  });
});

describe("createShadowAttemptRecord", () => {
  const identity = {
    completedAt: "2026-08-20T10:00:02.000Z",
    runtimeSessionId: "watch-session-1",
    egressPolicyId: "search-egress-deny-v1",
  };

  /** The live record for the same ingest, as the runtime would have written it. */
  function liveRecord(observation: ShadowObservation, state: WorldState) {
    const outcome = liveOutcome(state, observation.requestId);
    return createAttemptRecord({
      triggerEventId: observation.context.triggerEventId,
      episodeId: observation.episodeId,
      triggeredAt: observation.context.triggeredAt,
      completedAt: identity.completedAt,
      outcome,
      candidates: candidateEnvelopes(outcome.requestId, outcome.candidates),
      runtimeSessionId: identity.runtimeSessionId,
      stateDigest: observation.context.stateDigest,
      projectionGeneration: observation.context.projectionGeneration,
      triggerDisposition: observation.context.triggerDisposition,
      contextPolicyId: observation.context.contextPolicyId,
      actionTrust: "trusted",
      egressPolicyId: identity.egressPolicyId,
    });
  }

  it("names the shadow path in every identifier a claim could reach for", async () => {
    const observation = await observeOnce();
    const record = createShadowAttemptRecord({ observation, ...identity });

    // `claimDispatch` finds an attempt by `record.requestId === plan.attemptId`,
    // and a plan's attemptId is a live request id. This suffix is the structural
    // reason shadow mode cannot dispatch — not a flag someone remembered to
    // check, but an id no claim will ever ask for.
    expect(record.requestId).toBe(shadowRequestId(observation.requestId));
    expect(record.recordId).toBe(`attempt:${shadowRequestId(observation.requestId)}`);
    expect(record.provider).toBe(shadowProviderName("belief-rerank"));
    expect(isShadowProvider(record.provider)).toBe(true);
    for (const candidate of record.candidates) {
      expect(candidate.candidateId.startsWith(`${shadowRequestId(observation.requestId)}:`)).toBe(true);
    }
  });

  it("records itself as unable to act, whatever the live run was trusted with", async () => {
    const observation = await observeOnce();
    const record = createShadowAttemptRecord({ observation, ...identity });

    // The second, independent guard: `action-admission.ts` refuses a claim unless
    // both the attempt and the runtime are trusted, so even a record reached by
    // some future code path cannot authorize a dispatch.
    expect(record.actionTrust).toBe("suggestion_only");
  });

  it("keeps the belief status, which the attempt schema has nowhere else to put", async () => {
    const observation = await observeOnce();
    const record = createShadowAttemptRecord({ observation, ...identity });
    // "Ran with beliefs" and "ran without them" are different providers in effect;
    // a report that conflated them would average over two populations.
    expect(record.fallbackReason).toBe("beliefs=succeeded");
  });

  it("coexists with the live record for the same ingest", async () => {
    const { state } = await project(failedCommandEvents);
    const observation = await observeOnce();
    const ledger = new InMemoryPredictionLedger();

    await ledger.appendAttempt(liveRecord(observation, state));
    // The ledger index refuses a colliding request id or candidate id, so this
    // append passing *is* the proof that the namespaces are disjoint.
    await ledger.appendAttempt(createShadowAttemptRecord({ observation, ...identity }));
    expect(await ledger.all()).toHaveLength(2);
  });

  it("is removed with the event it describes, like the live record beside it", async () => {
    const { state } = await project(failedCommandEvents);
    const observation = await observeOnce();
    const ledger = new InMemoryPredictionLedger();
    await ledger.appendAttempt(liveRecord(observation, state));
    await ledger.appendAttempt(createShadowAttemptRecord({ observation, ...identity }));

    // `triggerEventId` is deliberately *not* shifted into a shadow namespace.
    // Renaming it would leave shadow records behind after retention deleted the
    // event they describe — an attempt pointing at history that no longer exists.
    const removed = await ledger.deleteRecordsRemovedWithEvents(
      new Set([observation.context.triggerEventId]),
    );
    expect(removed).toBe(2);
    expect(await ledger.all()).toEqual([]);
  });
});

describe("buildLedgerReport with both paths present", () => {
  it("keeps the live figures at the top level and breaks both paths out", async () => {
    const { state } = await project(failedCommandEvents);
    const observation = await observeOnce();
    const identity = {
      completedAt: "2026-08-20T10:00:02.000Z",
      runtimeSessionId: "watch-session-1",
      egressPolicyId: "search-egress-deny-v1",
    };
    const outcome = liveOutcome(state, observation.requestId);
    const live = createAttemptRecord({
      triggerEventId: observation.context.triggerEventId,
      episodeId: observation.episodeId,
      triggeredAt: observation.context.triggeredAt,
      completedAt: identity.completedAt,
      outcome,
      candidates: candidateEnvelopes(outcome.requestId, outcome.candidates),
      runtimeSessionId: identity.runtimeSessionId,
      stateDigest: observation.context.stateDigest,
      projectionGeneration: observation.context.projectionGeneration,
      triggerDisposition: observation.context.triggerDisposition,
      contextPolicyId: observation.context.contextPolicyId,
      actionTrust: "trusted",
      egressPolicyId: identity.egressPolicyId,
    });

    const report = buildLedgerReport([
      live,
      createShadowAttemptRecord({ observation, ...identity }),
    ]);

    // This is issue #4's fourth done-when: the report distinguishes the paths.
    expect(report.paths.live.attempts).toBe(1);
    expect(report.paths.shadow.attempts).toBe(1);
    expect(report.paths.live.byProvider).toEqual({ heuristic: 1 });
    expect(report.paths.shadow.byProvider).toEqual({ "shadow:belief-rerank": 1 });
    // And the top level still answers "what did this run actually do", so a
    // report from before shadow mode existed is comparing the same quantity.
    expect(report.attempts).toBe(1);
    expect(report.byProvider).toEqual({ heuristic: 1 });
  });
});
