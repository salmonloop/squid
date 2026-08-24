import { describe, expect, it } from "bun:test";
import { buildLedgerReport } from "../src/ledger-report.js";
import {
  candidateEnvelopes,
  createAttemptRecord,
  createBeliefBatchRecord,
  type PredictionLedgerRecord,
} from "../src/prediction-ledger.js";
import {
  BELIEF_SCHEMA_VERSION,
  BELIEF_TYPE,
  type BeliefValue,
} from "../src/belief-state.js";
import type { PredictionCandidate } from "../src/protocol.js";
import type { PredictionOutcome } from "../src/prediction-provider.js";

const now = new Date("2026-08-21T12:00:00.000Z");

function attempt(input: {
  requestId: string;
  provider: string;
  status: PredictionOutcome["status"];
  latencyMs: number;
  fallbackReason?: string;
  candidates?: readonly PredictionCandidate[];
}): PredictionLedgerRecord {
  const outcome: PredictionOutcome = {
    requestId: input.requestId,
    status: input.status,
    provider: input.provider,
    latencyMs: input.latencyMs,
    ...(input.fallbackReason !== undefined ? { fallbackReason: input.fallbackReason } : {}),
    candidates: input.candidates ?? [],
  };
  return createAttemptRecord({
    triggerEventId: `${input.requestId}-trigger`,
    episodeId: null,
    triggeredAt: now.toISOString(),
    completedAt: new Date(now.getTime() + input.latencyMs).toISOString(),
    runtimeSessionId: "test-runtime",
    stateDigest: `sha256:${"a".repeat(64)}`,
    projectionGeneration: 1,
    triggerDisposition: "accepted",
    contextPolicyId: "passthrough",
    actionTrust: "trusted",
    egressPolicyId: "search-egress-deny-v1",
    outcome,
    candidates: candidateEnvelopes(input.requestId, outcome.candidates),
  });
}

function beliefRecord(
  requestId: string,
  beliefBatchId: string,
  values: readonly BeliefValue[],
): PredictionLedgerRecord {
  return createBeliefBatchRecord({
    requestId,
    observedAt: now.toISOString(),
    batch: {
      schemaVersion: BELIEF_SCHEMA_VERSION,
      beliefBatchId,
      projectionGeneration: 1,
      episodeId: "ep-1",
      stateDigest: `sha256:${"a".repeat(64)}`,
      generatedAt: now.toISOString(),
      provider: "heuristic-belief",
      modelVersion: "v1",
      promptVersion: "v1",
      contextPolicyId: "passthrough",
      beliefs: values.map((value, index) => ({
        id: `${beliefBatchId}:belief:${index}`,
        type: BELIEF_TYPE,
        value,
        confidence: 0.8,
        evidenceEventIds: [`${requestId}-trigger`],
        inferredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 120_000).toISOString(),
      })),
    },
  });
}

function candidate(kind: PredictionCandidate["kind"]): PredictionCandidate {
  return {
    kind,
    rationale: `rationale for ${kind}`,
    confidence: 0.5,
    expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    sourceEventIds: [],
    parameters: {},
  };
}

describe("buildLedgerReport", () => {
  it("reports an empty ledger as zeros with null latencies", () => {
    const report = buildLedgerReport([]);
    expect(report.attempts).toBe(0);
    expect(report.byProvider).toEqual({});
    expect(report.latencyMs.p50).toBeNull();
    expect(report.latencyMs.max).toBeNull();
  });

  it("aggregates providers, statuses, and candidate kinds across attempts", () => {
    const report = buildLedgerReport([
      attempt({ requestId: "r1", provider: "heuristic", status: "succeeded", latencyMs: 10 }),
      attempt({
        requestId: "r2",
        provider: "pi",
        status: "timeout",
        latencyMs: 7000,
        fallbackReason: "provider timed out",
        candidates: [candidate("run_tests")],
      }),
      attempt({
        requestId: "r3",
        provider: "pi",
        status: "succeeded",
        latencyMs: 3000,
        candidates: [candidate("none"), candidate("run_tests")],
      }),
    ]);

    expect(report.attempts).toBe(3);
    expect(report.byProvider).toEqual({ heuristic: 1, pi: 2 });
    expect(report.byStatus).toEqual({ succeeded: 2, timeout: 1 });
    expect(report.fallbacks).toBe(1);
    expect(report.fallbackReasons).toEqual({ "provider timed out": 1 });
    // Every emitted candidate counts, including a multi-candidate attempt.
    expect(report.byCandidateKind).toEqual({ run_tests: 2, none: 1 });
  });

  it("reports what the belief layer asserted over the run", () => {
    // This is where "nothing accumulates across a session" is answered. Beliefs
    // never re-enter a ranking, so what accumulates is the record — and a record an
    // operator cannot read back is indistinguishable from one never written.
    const report = buildLedgerReport([
      attempt({ requestId: "r1", provider: "belief-rerank", status: "succeeded", latencyMs: 10 }),
      beliefRecord("r1", "batch-1", ["validate_change", "draft_text"]),
      beliefRecord("r2", "batch-2", ["validate_change"]),
    ]);

    expect(report.beliefs.batches).toBe(2);
    expect(report.beliefs.byProvider).toEqual({ "heuristic-belief": 2 });
    // Counts every belief in every batch, not just batches: two batches asserting
    // the same intent is a different fact from one batch asserting it twice.
    expect(report.beliefs.byValue).toEqual({ validate_change: 2, draft_text: 1 });
    // And belief records are not attempts. Counting them in would double the run's
    // apparent prediction volume and drag the latency percentiles toward zero.
    expect(report.attempts).toBe(1);
  });

  it("reports no beliefs for a run that produced none", () => {
    const report = buildLedgerReport([
      attempt({ requestId: "r1", provider: "heuristic", status: "succeeded", latencyMs: 10 }),
    ]);
    // The default provider has no belief layer at all, so this is the shape most
    // reports have. Zero rather than absent: an operator comparing two runs should
    // not have to tell "no beliefs" apart from "this report predates beliefs".
    expect(report.beliefs).toEqual({ batches: 0, byProvider: {}, byValue: {} });
  });

  it("computes latency percentiles over sorted attempts", () => {
    const report = buildLedgerReport(
      [100, 200, 300, 400].map((latencyMs, index) =>
        attempt({ requestId: `r${index}`, provider: "pi", status: "succeeded", latencyMs })
      ),
    );
    expect(report.latencyMs.p50).toBe(200);
    expect(report.latencyMs.p95).toBe(400);
    expect(report.latencyMs.max).toBe(400);
  });
});
