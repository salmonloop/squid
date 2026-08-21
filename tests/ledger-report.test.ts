import { describe, expect, it } from "bun:test";
import { buildLedgerReport } from "../src/ledger-report.js";
import {
  candidateEnvelopes,
  createAttemptRecord,
  type PredictionLedgerRecord,
} from "../src/prediction-ledger.js";
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
    outcome,
    candidates: candidateEnvelopes(input.requestId, outcome.candidates),
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
