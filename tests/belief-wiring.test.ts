import { describe, expect, it } from "bun:test";
import { HeuristicPredictor } from "../src/baseline-predictor.js";
import { evidenceTimeline } from "../src/belief-evidence.js";
import { BeliefRerankCognition } from "../src/belief-rerank-cognition.js";
import { createBeliefResolver } from "../src/belief-resolver.js";
import type { BeliefOutcome, BeliefProvider } from "../src/belief-provider.js";
import {
  BELIEF_SCHEMA_VERSION,
  BELIEF_TYPE,
  type BeliefStateBatch,
} from "../src/belief-state.js";
import { BeliefBackedPredictionProvider } from "../src/cognition-provider.js";
import {
  PassthroughContextPolicy,
  RedactingContextPolicy,
  type ContextPolicy,
} from "../src/context-policy.js";
import type { PredictionProviderFactory } from "../src/evaluation.js";
import { heuristicEvaluationScenarios } from "../src/evaluation-fixtures.js";
import { HeuristicBeliefProvider } from "../src/heuristic-belief-provider.js";
import { InMemoryEventStore } from "../src/event-store.js";
import { PredictionCoordinator } from "../src/prediction-coordinator.js";
import type { PredictionRequest } from "../src/prediction-provider.js";
import { createActivityEvent, type ActivityEvent, type WorldState } from "../src/protocol.js";
import { runSemanticGate } from "../src/semantic-gate.js";
import { SquidCore } from "../src/squid-core.js";

/**
 * These tests exercise the *wiring* between the belief contract and a live
 * prediction, which the contract's own tests cannot reach: a batch is only
 * meaningful if it validates against a projection some real core actually
 * produced, and the digest and generation that make that check possible are not
 * things a hand-written fixture can honestly supply.
 *
 * So the states here are built by ingesting events, and the projection identity
 * comes from `SquidCore`. A test that fabricated a digest would pass while the
 * live path was rejecting every batch.
 */

const session = "belief-wiring-session";
const source = { kind: "synthetic" as const, instanceId: "belief-wiring" };

function event<TPayload>(input: {
  eventId: string;
  sequence: number;
  occurredAt: string;
  kind: Parameters<typeof createActivityEvent<TPayload>>[0]["kind"];
  payload: TPayload;
}): ActivityEvent<TPayload> {
  return createActivityEvent({ ...input, source, sessionId: session });
}

/** A save in a code editor with text under the cursor: two belief rules fire. */
const editorSaveEvents: readonly ActivityEvent[] = [
  event({
    eventId: "code-app",
    sequence: 0,
    occurredAt: "2026-08-20T09:00:00.000Z",
    kind: "application_activated",
    payload: { applicationId: "com.editor.code", applicationName: "VS Code" },
  }),
  event({
    eventId: "code-window",
    sequence: 1,
    occurredAt: "2026-08-20T09:00:01.000Z",
    kind: "window_changed",
    payload: { applicationId: "com.editor.code", title: "main.ts", bounds: null },
  }),
  event({
    eventId: "code-focus",
    sequence: 2,
    occurredAt: "2026-08-20T09:00:02.000Z",
    kind: "focus_changed",
    payload: {
      applicationId: "com.editor.code",
      windowTitle: "main.ts",
      role: "editor",
      label: "editor",
    },
  }),
  event({
    eventId: "code-text",
    sequence: 3,
    occurredAt: "2026-08-20T09:00:03.000Z",
    kind: "text_context_changed",
    payload: { prefix: "export function run(", suffix: ") {}", selection: "", language: "ts" },
  }),
  event({
    eventId: "code-save",
    sequence: 4,
    occurredAt: "2026-08-20T09:00:04.000Z",
    kind: "file_saved",
    payload: { path: "/repo/src/main.ts", applicationId: "com.editor.code" },
  }),
];

/** Projects a timeline through a real core and returns what the runtime would see. */
async function project(events: readonly ActivityEvent[]): Promise<{
  readonly state: WorldState;
  readonly stateDigest: string;
  readonly projectionGeneration: number;
}> {
  const core = new SquidCore(new InMemoryEventStore());
  let last = await core.ingest(events[0]!);
  for (const next of events.slice(1)) last = await core.ingest(next);
  return {
    state: last.state,
    stateDigest: last.stateDigest,
    projectionGeneration: last.projectionGeneration,
  };
}

function predictionRequest(
  projection: Awaited<ReturnType<typeof project>>,
  overrides: Partial<PredictionRequest> = {},
): PredictionRequest {
  return {
    id: "req-1",
    worldState: projection.state,
    episodeId: projection.state.episode?.id ?? null,
    triggeredAt: projection.state.updatedAt!,
    projection: {
      stateDigest: projection.stateDigest,
      projectionGeneration: projection.projectionGeneration,
    },
    ...overrides,
  };
}

/** A provider that answers honestly, then misreports one thing about its batch. */
function misreportingProvider(
  mutate: (batch: BeliefStateBatch) => BeliefStateBatch,
): BeliefProvider {
  const honest = new HeuristicBeliefProvider();
  return {
    name: "misreporting-belief",
    infer: async (request, signal) => mutate(await honest.infer(request, signal)),
  };
}

describe("evidenceTimeline", () => {
  it("names every event the projection still remembers, with when it happened", async () => {
    const { state } = await project(editorSaveEvents);
    const timeline = evidenceTimeline(state);

    // The save is in `recentActions`, the prefix is in `textContext`. Both are
    // things a belief rule cites, so both have to be citable.
    expect(timeline.get("code-save")).toBe("2026-08-20T09:00:04.000Z");
    expect(timeline.get("code-text")).toBe("2026-08-20T09:00:03.000Z");
  });

  it("omits events the projection no longer holds, so a belief cannot cite them", async () => {
    const { state } = await project(editorSaveEvents);
    const timeline = evidenceTimeline(state);
    // Window and focus events shape the projection but leave no eventId behind:
    // nothing in world state points at them, so no belief may claim them as
    // evidence. Including them here would let an unauditable belief validate.
    expect(timeline.has("code-window")).toBe(false);
    expect(timeline.has("code-focus")).toBe(false);
  });

  it("survives redaction, because a policy narrows content and not provenance", async () => {
    const { state } = await project(editorSaveEvents);
    const redacted = new RedactingContextPolicy().project(state);
    // The belief validator checks evidence against the projection the provider
    // saw. If redaction dropped event ids, every belief inferred from redacted
    // state would be refused as unevidenced — the belief layer would be dead in
    // exactly the configuration the model path runs under.
    expect([...evidenceTimeline(redacted).keys()].sort())
      .toEqual([...evidenceTimeline(state).keys()].sort());
  });
});

describe("createBeliefResolver", () => {
  const policyId = new PassthroughContextPolicy().id;

  function resolver(overrides: { contextPolicyId?: string } = {}) {
    const outcomes: BeliefOutcome[] = [];
    const resolve = createBeliefResolver({
      beliefProvider: new HeuristicBeliefProvider(),
      contextPolicyId: overrides.contextPolicyId ?? policyId,
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    return { resolve, outcomes };
  }

  it("produces a batch the contract accepts, from a projection a core built", async () => {
    const projection = await project(editorSaveEvents);
    const { resolve, outcomes } = resolver();

    const batch = await resolve(predictionRequest(projection), new AbortController().signal);

    // This is issue #4's first done-when, and the part a fixture cannot fake: the
    // digest and generation came from `SquidCore`, and the evidence ids came from
    // the same projection, so acceptance means the whole chain agrees.
    expect(batch).not.toBeNull();
    expect(batch!.stateDigest).toBe(projection.stateDigest);
    expect(batch!.projectionGeneration).toBe(projection.projectionGeneration);
    expect(batch!.beliefs.map((belief) => belief.value)).toEqual([
      "validate_change",
      "draft_text",
    ]);
    expect(batch!.beliefs.every((belief) => belief.type === BELIEF_TYPE)).toBe(true);
    expect(batch!.schemaVersion).toBe(BELIEF_SCHEMA_VERSION);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["succeeded"]);
  });

  it("cites only events the projection can vouch for", async () => {
    const projection = await project(editorSaveEvents);
    const { resolve } = resolver();
    const batch = await resolve(predictionRequest(projection), new AbortController().signal);

    const timeline = evidenceTimeline(projection.state);
    for (const belief of batch!.beliefs) {
      for (const eventId of belief.evidenceEventIds) {
        expect(timeline.has(eventId)).toBe(true);
      }
    }
  });

  it("declines rather than inventing a projection identity", async () => {
    const projection = await project(editorSaveEvents);
    const { resolve, outcomes } = resolver();

    // A request with no projection cannot be validated against anything. The
    // resolver must refuse, not synthesize a digest: a fabricated one would make
    // a batch about a world that never existed look auditable.
    const batch = await resolve(
      { ...predictionRequest(projection), projection: undefined },
      new AbortController().signal,
    );
    expect(batch).toBeNull();
    expect(outcomes[0]?.status).toBe("none");
    expect(outcomes[0]?.reasonCode).toBe("no_projection_identity");
  });

  it("stamps the policy the state was projected through onto the request", async () => {
    const projection = await project(editorSaveEvents);
    const { resolve } = resolver({ contextPolicyId: "redacting" });
    const batch = await resolve(predictionRequest(projection), new AbortController().signal);

    // The provider echoes the request's policy, so this asserts the resolver told
    // it the truth about which projection it was given. Getting this wrong is how
    // a gate ends up measuring a cognition layer that never saw a belief: the
    // batches all fail `context_policy_mismatch` and nothing says so out loud.
    expect(batch?.contextPolicyId).toBe("redacting");
  });

  it("refuses a provider whose batch answers about a different world", async () => {
    const projection = await project(editorSaveEvents);
    const request = predictionRequest(projection);

    // A cooperative provider echoes the request, so a mismatch can only come from
    // a provider that answered about something else — a stale cached batch, or a
    // model that made its metadata up. The resolver has to catch each one, because
    // a consumer cannot tell a stale belief from a fresh one by looking at it.
    for (const [field, value, reason] of [
      ["stateDigest", `sha256:${"b".repeat(64)}`, "state_digest_mismatch"],
      ["projectionGeneration", projection.projectionGeneration + 1, "projection_generation_mismatch"],
      ["contextPolicyId", "some-other-policy", "context_policy_mismatch"],
      ["episodeId", "episode-elsewhere", "episode_mismatch"],
    ] as const) {
      const outcomes: BeliefOutcome[] = [];
      const resolve = createBeliefResolver({
        beliefProvider: misreportingProvider((batch) => ({ ...batch, [field]: value })),
        contextPolicyId: policyId,
        onOutcome: (outcome) => outcomes.push(outcome),
      });

      expect(await resolve(request, new AbortController().signal)).toBeNull();
      expect(outcomes[0]?.status).toBe("rejected");
      // Some divergences trip the shared validator first, since it compares
      // against the same current values; either code is correct, and what matters
      // is that none of them is accepted.
      expect([reason, "batch_invalid"]).toContain(outcomes[0]?.reasonCode);
    }
  });

  it("refuses a belief citing an event the projection cannot vouch for", async () => {
    const projection = await project(editorSaveEvents);
    const outcomes: BeliefOutcome[] = [];
    const resolve = createBeliefResolver({
      beliefProvider: misreportingProvider((batch) => ({
        ...batch,
        beliefs: batch.beliefs.map((belief) => ({
          ...belief,
          evidenceEventIds: ["event-that-never-happened"],
        })),
      })),
      contextPolicyId: policyId,
      onOutcome: (outcome) => outcomes.push(outcome),
    });

    expect(await resolve(predictionRequest(projection), new AbortController().signal)).toBeNull();
    expect(outcomes[0]?.status).toBe("rejected");
  });

  it("reports an empty world as nothing to assert, not as a failure", async () => {
    const projection = await project(editorSaveEvents.slice(0, 2));
    const { resolve, outcomes } = resolver();

    const batch = await resolve(predictionRequest(projection), new AbortController().signal);
    expect(batch).toBeNull();
    // A quiet desktop must not read as a broken belief layer; the gate's health
    // measure would otherwise report every idle moment as an outage.
    expect(outcomes[0]?.status).toBe("none");
    expect(outcomes[0]?.reasonCode).toBeUndefined();
  });
});

describe("BeliefRerankCognition", () => {
  const signal = new AbortController().signal;

  async function candidatesFor(beliefs: BeliefStateBatch | null): Promise<
    readonly { kind: string; confidence: number }[]
  > {
    const projection = await project(editorSaveEvents);
    const candidates = await new BeliefRerankCognition().predict(
      { ...predictionRequest(projection), beliefs },
      signal,
    );
    return candidates.map((candidate) => ({
      kind: candidate.kind,
      confidence: candidate.confidence,
    }));
  }

  async function heuristicBatch(): Promise<BeliefStateBatch> {
    const projection = await project(editorSaveEvents);
    const batch = await createBeliefResolver({
      beliefProvider: new HeuristicBeliefProvider(),
      contextPolicyId: new PassthroughContextPolicy().id,
    })(predictionRequest(projection), signal);
    return batch!;
  }

  it("predicts from state alone when the belief layer produced nothing", async () => {
    const projection = await project(editorSaveEvents);
    const withoutBeliefs = await candidatesFor(null);
    const baseline = new HeuristicPredictor()
      .predict(projection.state, new Date(projection.state.updatedAt!))
      .map((candidate) => ({ kind: candidate.kind, confidence: candidate.confidence }));

    // The belief layer is allowed to be unavailable, and this is what that costs:
    // exactly the heuristic, unchanged. Not a degraded answer — the answer the
    // projection alone supports.
    expect(withoutBeliefs).toEqual(baseline);
  });

  it("raises the confidence of an action the beliefs support", async () => {
    const batch = await heuristicBatch();
    const withBeliefs = await candidatesFor(batch);
    const withoutBeliefs = await candidatesFor(null);

    const before = new Map(withoutBeliefs.map((c) => [c.kind, c.confidence]));
    for (const candidate of withBeliefs) {
      expect(candidate.confidence).toBeGreaterThan(before.get(candidate.kind)!);
      expect(candidate.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("proposes nothing the projection did not already support", async () => {
    const batch = await heuristicBatch();
    const withBeliefs = await candidatesFor(batch);
    const withoutBeliefs = await candidatesFor(null);

    // A belief carries no command, no tool name, and no parameters, so it has
    // nothing to build an action out of. Re-ranking is the whole of the authority
    // this layer has — every candidate it emits was already admissible.
    expect(withBeliefs.map((c) => c.kind).sort())
      .toEqual(withoutBeliefs.map((c) => c.kind).sort());
  });

  it("answers identically on identical input, which is what the gate measures", async () => {
    const batch = await heuristicBatch();
    const runs = await Promise.all([candidatesFor(batch), candidatesFor(batch), candidatesFor(batch)]);
    expect(runs[1]).toEqual(runs[0]!);
    expect(runs[2]).toEqual(runs[0]!);
  });

  it("ignores a belief value that supports no action", async () => {
    const batch = await heuristicBatch();
    const unknownOnly: BeliefStateBatch = {
      ...batch,
      beliefs: batch.beliefs.map((belief) => ({ ...belief, value: "unknown" as const })),
    };
    // `unknown` is what a producer says when it cannot tell what is going on. An
    // intent that says nothing must not move a ranking.
    expect(await candidatesFor(unknownOnly)).toEqual(await candidatesFor(null));
  });

  it("lets a confident belief promote the action the heuristic ranked second", async () => {
    const batch = await heuristicBatch();
    const baseline = await candidatesFor(null);
    expect(baseline.map((candidate) => candidate.kind)).toEqual([
      "draft_completion",
      "run_tests",
    ]);

    // The heuristic's own confidences say drafting matters more here. A belief
    // layer certain the user is validating a change should be able to overturn
    // that — otherwise the beliefs are decoration and the gate is measuring the
    // heuristic wearing a different name.
    const decisive: BeliefStateBatch = {
      ...batch,
      beliefs: batch.beliefs.map((belief) => ({
        ...belief,
        confidence: belief.value === "validate_change" ? 1 : 0,
      })),
    };
    expect((await candidatesFor(decisive)).map((candidate) => candidate.kind)).toEqual([
      "run_tests",
      "draft_completion",
    ]);
  });
});

describe("the live path from coordinator to belief", () => {
  it("delivers a validated batch to cognition through the coordinator", async () => {
    const projection = await project(editorSaveEvents);
    const seen: (BeliefStateBatch | null)[] = [];
    const policy = new PassthroughContextPolicy();

    const coordinator = new PredictionCoordinator({
      contextPolicy: policy,
      provider: new BeliefBackedPredictionProvider(
        {
          name: "spy-cognition",
          predict: async (request) => {
            seen.push(request.beliefs);
            return new HeuristicPredictor().predict(request.worldState);
          },
        },
        createBeliefResolver({
          beliefProvider: new HeuristicBeliefProvider(),
          contextPolicyId: policy.id,
        }),
      ),
    });

    try {
      // The projection identity is what the runtime passes at this call site. This
      // is the whole chain issue #4 asks for: a real projection in, a validated
      // batch reaching a consumer, and candidates out.
      const outcome = await coordinator.request(projection.state, {
        stateDigest: projection.stateDigest,
        projectionGeneration: projection.projectionGeneration,
      });
      expect(outcome.status).toBe("succeeded");
      expect(seen[0]).not.toBeNull();
      expect(seen[0]!.beliefs.map((belief) => belief.value)).toEqual([
        "validate_change",
        "draft_text",
      ]);
    } finally {
      coordinator.dispose();
    }
  });

  it("still predicts when the coordinator was given no projection identity", async () => {
    const projection = await project(editorSaveEvents);
    const seen: (BeliefStateBatch | null)[] = [];
    const coordinator = new PredictionCoordinator({
      provider: new BeliefBackedPredictionProvider(
        {
          name: "spy-cognition",
          predict: async (request) => {
            seen.push(request.beliefs);
            return new HeuristicPredictor().predict(request.worldState);
          },
        },
        createBeliefResolver({
          beliefProvider: new HeuristicBeliefProvider(),
          contextPolicyId: new PassthroughContextPolicy().id,
        }),
      ),
    });

    try {
      const outcome = await coordinator.request(projection.state);
      // No digest means no belief — and still a prediction. The belief layer is an
      // improvement to a prediction, never a precondition for one.
      expect(seen[0]).toBeNull();
      expect(outcome.status).toBe("succeeded");
      expect(outcome.candidates.length).toBeGreaterThan(0);
    } finally {
      coordinator.dispose();
    }
  });
});

/**
 * The gate is what stands between a cognition provider and a real dispatch, so
 * these tests check both of the things it claims to measure — and check that each
 * one can refuse on its own. A gate that only ever failed on ranking would let the
 * nondeterminism that already sinks `PiRuntime` through unremarked.
 */
describe("runSemanticGate over the belief-backed cognition path", () => {
  /** Built exactly as `resolveCognitionProvider` builds it: one shared policy. */
  function cognitionProviderUnder(policy: ContextPolicy): PredictionProviderFactory {
    return () => new BeliefBackedPredictionProvider(
      new BeliefRerankCognition(),
      createBeliefResolver({
        beliefProvider: new HeuristicBeliefProvider(),
        contextPolicyId: policy.id,
      }),
    );
  }

  const cognitionProvider = cognitionProviderUnder(new PassthroughContextPolicy());

  /**
   * The gate exists to decide whether a provider may reach a real dispatch, so it
   * has to score the provider *as the live run configures it*. The live cognition
   * path applies `RedactingContextPolicy`; if the gate applies passthrough, a
   * belief producer is measured on window titles, full paths, and URL query
   * strings it can never have in production — and then earns `trusted` on that
   * evidence.
   *
   * The `contextPolicyId` agreement check cannot catch this: a cooperative
   * producer echoes the request's id back, so request and batch agree whatever
   * the resolver was told. Only observing the state the provider actually receives
   * settles it, which is what this asserts.
   */
  it("hands the belief provider the state the live run would project", async () => {
    const policy = new RedactingContextPolicy();
    const seen: WorldState[] = [];
    const spy: BeliefProvider = {
      name: "state-spy",
      infer: async (request, signal) => {
        seen.push(request.worldState);
        return new HeuristicBeliefProvider().infer(request, signal);
      },
    };

    const result = await runSemanticGate({
      scenarios: heuristicEvaluationScenarios,
      contextPolicy: policy,
      createProvider: () => new BeliefBackedPredictionProvider(
        new BeliefRerankCognition(),
        createBeliefResolver({ beliefProvider: spy, contextPolicyId: policy.id }),
      ),
    });

    expect(result.status).toBe("passed");
    expect(seen.length).toBeGreaterThan(0);

    // Redaction is observable in the projection, so these assert the policy really
    // ran rather than that the id was merely claimed.
    const titles = seen.map((state) => state.focus?.windowTitle).filter((t) => t !== undefined);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((title) => title === "[redacted]")).toBe(true);

    const targets = seen.flatMap((state) => state.recentActions.map((action) => action.target));
    const paths = targets.filter((target): target is string => target !== null && target.includes("."));
    expect(paths.length).toBeGreaterThan(0);
    // Basenamed, so no directory structure reaches a provider under this policy.
    expect(paths.every((path) => !path.includes("/"))).toBe(true);
  });

  it("admits the belief-backed path on both quality and determinism", async () => {
    const result = await runSemanticGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: cognitionProvider,
    });

    expect(result.status).toBe("passed");
    expect(result.failures).toEqual([]);
    // Determinism is measured, not assumed: the same corpus, replayed, comparing
    // the top candidate per cut point.
    expect(result.stability?.top1Stability).toBe(1);
    expect(result.stability?.runs).toBe(3);
    expect(result.stability?.cutPointCount).toBeGreaterThan(0);
    // And it answered for itself rather than riding the coordinator's fallback,
    // which ranking alone cannot distinguish from a good prediction.
    expect(result.ranking?.health?.fallbackRate).toBe(0);
    expect(result.ranking?.candidate?.top1.rate)
      .toBeGreaterThanOrEqual(result.ranking!.baseline!.top1.rate);
  });

  it("refuses a provider that answers differently on the same state", async () => {
    // Alternates between proposing and staying silent. That is the malfunction
    // this dimension exists to catch: a suggestion a user sees on one screen and
    // not on the same screen a moment later reads as a broken assistant, however
    // good the average looks. The corpus has an odd number of cut points, so a
    // given cut point lands on the opposite parity in the next replay —
    // instability by construction rather than by chance.
    let flip = false;
    const unstable = () => ({
      name: "unstable-cognition",
      predict: async (request: PredictionRequest) => {
        flip = !flip;
        return flip
          ? new HeuristicPredictor().predict(request.worldState, new Date(request.triggeredAt))
          : [];
      },
    });

    const result = await runSemanticGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: unstable,
      // Every ranking floor is relaxed away, so the only verdict left to reach is
      // the stability one. Without this the provider would also fail on top-1 and
      // the test would not show which dimension caught it.
      thresholds: { top1Slack: 1, noneCorrectnessSlack: 1, maxFallbackRate: 1 },
    });

    expect(result.status).toBe("failed");
    expect(result.failures.join(" ")).toContain("top1_stability");
    expect(result.stability!.top1Stability).toBeLessThan(1);
  });

  it("propagates an unreachable provider as skipped, which is not a pass", async () => {
    const result = await runSemanticGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: cognitionProvider,
      probeAvailability: async () => "belief service unreachable",
    });

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toContain("belief service unreachable");
    // Nothing was measured, so there is nothing to report — and `readGateVerdict`
    // turns this into a decline rather than an admission.
    expect(result.stability).toBeNull();
    expect(result.failures).toEqual([]);
  });
});
