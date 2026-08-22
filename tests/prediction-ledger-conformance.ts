import { describe, expect, it } from "bun:test";
import {
  candidateEnvelopes,
  createAttemptRecord,
  createFeedbackRecord,
  parsePredictionLedgerRecord,
  PredictionLedgerConflictError,
  PredictionLedgerReferenceError,
  type PredictionAttemptRecord,
  type PredictionLedger,
} from "../src/prediction-ledger.js";
import type { PredictionOutcome } from "../src/prediction-provider.js";
import type { PredictionCandidate } from "../src/protocol.js";

export interface LedgerHarness {
  readonly ledger: PredictionLedger;
  dispose(): Promise<void>;
}

export function candidate(overrides: Partial<PredictionCandidate> = {}): PredictionCandidate {
  return {
    kind: "run_tests",
    rationale: "a file was saved",
    confidence: 0.8,
    expiresAt: "2026-08-19T10:01:00.000Z",
    sourceEventIds: ["e-1"],
    parameters: { target: "src/main.ts" },
    ...overrides,
  };
}

export function outcome(overrides: Partial<PredictionOutcome> = {}): PredictionOutcome {
  return {
    requestId: "req-1",
    provider: "fake",
    status: "succeeded",
    candidates: [candidate()],
    latencyMs: 12,
    ...overrides,
  };
}

export function attempt(
  requestId = "req-1",
  candidates: readonly PredictionCandidate[] = [candidate()],
  overrides: Partial<PredictionOutcome> = {},
): PredictionAttemptRecord {
  const resolved = outcome({ requestId, candidates, ...overrides });
  return createAttemptRecord({
    triggerEventId: "evt-1",
    episodeId: "ep-1",
    triggeredAt: "2026-08-19T10:00:00.000Z",
    completedAt: "2026-08-19T10:00:00.500Z",
    runtimeSessionId: "test-runtime",
    stateDigest: `sha256:${"a".repeat(64)}`,
    projectionGeneration: 1,
    triggerDisposition: "accepted",
    contextPolicyId: "passthrough",
    actionTrust: "trusted",
    egressPolicyId: "search-egress-deny-v1",
    outcome: resolved,
    candidates: candidateEnvelopes(requestId, resolved.candidates),
  });
}

/**
 * One contract, three implementations. Every behavior asserted here is part of
 * the `PredictionLedger` contract rather than an artifact of one backend, so a
 * new implementation is correct exactly when it passes this suite.
 */
export function describePredictionLedgerConformance(
  name: string,
  createLedger: () => Promise<LedgerHarness>,
): void {
  describe(`${name} conformance`, () => {
    it("returns an empty ledger before any append", async () => {
      const harness = await createLedger();
      try {
        expect(await harness.ledger.all()).toEqual([]);
      } finally {
        await harness.dispose();
      }
    });

    it("round-trips an attempt record without loss", async () => {
      const harness = await createLedger();
      try {
        const record = attempt();
        await harness.ledger.appendAttempt(record);

        const records = await harness.ledger.all();
        expect(records).toHaveLength(1);
        expect(records[0]).toEqual(record);
      } finally {
        await harness.dispose();
      }
    });

    it("preserves an optional fallback reason", async () => {
      const harness = await createLedger();
      try {
        const record = attempt("req-1", [], { status: "timeout", fallbackReason: "timeout" });
        await harness.ledger.appendAttempt(record);

        const stored = (await harness.ledger.all())[0] as PredictionAttemptRecord;
        expect(stored.fallbackReason).toBe("timeout");
        expect(stored.status).toBe("timeout");
      } finally {
        await harness.dispose();
      }
    });

    it("omits a fallback reason that was never set", async () => {
      const harness = await createLedger();
      try {
        await harness.ledger.appendAttempt(attempt());

        const stored = (await harness.ledger.all())[0] as PredictionAttemptRecord;
        expect("fallbackReason" in stored).toBe(false);
      } finally {
        await harness.dispose();
      }
    });

    it("returns records in append order", async () => {
      const harness = await createLedger();
      try {
        await harness.ledger.appendAttempt(attempt("req-1"));
        await harness.ledger.appendAttempt(attempt("req-2"));
        await harness.ledger.appendFeedback(
          createFeedbackRecord({
            feedbackId: "fb-1",
            requestId: "req-1",
            candidateId: "req-1:candidate:0",
            feedback: "accepted",
          }),
        );

        const records = await harness.ledger.all();
        expect(records.map((r) => r.recordId)).toEqual([
          "attempt:req-1",
          "attempt:req-2",
          "feedback:fb-1",
        ]);
      } finally {
        await harness.dispose();
      }
    });

    it("links feedback to a candidate by stable ID", async () => {
      const harness = await createLedger();
      try {
        await harness.ledger.appendAttempt(attempt());
        const feedback = createFeedbackRecord({
          feedbackId: "fb-1",
          requestId: "req-1",
          candidateId: "req-1:candidate:0",
          feedback: "accepted",
          details: { source: "terminal_confirmation" },
        });
        await harness.ledger.appendFeedback(feedback);

        const records = await harness.ledger.all();
        expect(records[1]).toEqual(feedback);
      } finally {
        await harness.dispose();
      }
    });

    it("accepts multiple feedback records for one candidate", async () => {
      const harness = await createLedger();
      try {
        await harness.ledger.appendAttempt(attempt());
        // Two distinct facts about how one prediction was received; the
        // dispatch lifecycle is not expressible through this API.
        for (const [id, kind] of [["fb-1", "accepted"], ["fb-2", "expired"]] as const) {
          await harness.ledger.appendFeedback(
            createFeedbackRecord({
              feedbackId: id,
              requestId: "req-1",
              candidateId: "req-1:candidate:0",
              feedback: kind,
            }),
          );
        }

        const feedback = (await harness.ledger.all()).filter((r) => r.recordType === "feedback");
        expect(feedback.map((r) => r.feedback)).toEqual(["accepted", "expired"]);
      } finally {
        await harness.dispose();
      }
    });

    it("treats a byte-identical re-append as a no-op", async () => {
      const harness = await createLedger();
      try {
        const record = attempt();
        await harness.ledger.appendAttempt(record);
        await harness.ledger.appendAttempt(record);

        expect(await harness.ledger.all()).toHaveLength(1);
      } finally {
        await harness.dispose();
      }
    });

    it("rejects a second attempt for the same request", async () => {
      const harness = await createLedger();
      try {
        await harness.ledger.appendAttempt(attempt("req-1"));

        await expect(
          harness.ledger.appendAttempt(attempt("req-1", [candidate({ kind: "inspect_error" })])),
        ).rejects.toBeInstanceOf(PredictionLedgerConflictError);
        expect(await harness.ledger.all()).toHaveLength(1);
      } finally {
        await harness.dispose();
      }
    });

    it("rejects a second attempt with a distinct recordId for the same request", async () => {
      // createAttemptRecord derives recordId from requestId, so the previous
      // test's conflict is on record_id, not on the one-per-request invariant.
      // This case uses a different recordId so only a per-request constraint
      // can catch it — the exact gap the SQLite partial unique index closes.
      const harness = await createLedger();
      try {
        await harness.ledger.appendAttempt(attempt("req-1"));
        const divergent = {
          ...attempt("req-1", [candidate({ kind: "inspect_error" })]),
          recordId: "attempt:req-1:retry",
        } as PredictionAttemptRecord;

        await expect(harness.ledger.appendAttempt(divergent)).rejects.toBeInstanceOf(
          PredictionLedgerConflictError,
        );
        expect(await harness.ledger.all()).toHaveLength(1);
      } finally {
        await harness.dispose();
      }
    });

    it("re-parses every stored record without loss", async () => {
      // The authoritative form of a record is its JSON. SQLite stores `record_json`
      // and rehydrates through parsePredictionLedgerRecord on every read; this pins
      // that contract for the in-memory and JSONL backends too, so a record one
      // backend accepts is recoverable from its serialized form in all of them.
      const harness = await createLedger();
      try {
        await harness.ledger.appendAttempt(attempt("req-1"));
        await harness.ledger.appendFeedback(
          createFeedbackRecord({
            feedbackId: "fb-1",
            requestId: "req-1",
            candidateId: "req-1:candidate:0",
            feedback: "accepted",
          }),
        );

        const records = await harness.ledger.all();
        expect(records).toHaveLength(2);
        for (const record of records) {
          const rehydrated = parsePredictionLedgerRecord(JSON.parse(JSON.stringify(record)));
          expect(rehydrated).toEqual(record);
        }
      } finally {
        await harness.dispose();
      }
    });

    it("rejects feedback for an unknown candidate", async () => {
      const harness = await createLedger();
      try {
        await harness.ledger.appendAttempt(attempt());

        await expect(
          harness.ledger.appendFeedback(
            createFeedbackRecord({
              feedbackId: "fb-1",
              requestId: "req-1",
              candidateId: "req-1:candidate:9",
              feedback: "accepted",
            }),
          ),
        ).rejects.toBeInstanceOf(PredictionLedgerReferenceError);
      } finally {
        await harness.dispose();
      }
    });

    it("rejects feedback that pairs a candidate with another request", async () => {
      const harness = await createLedger();
      try {
        await harness.ledger.appendAttempt(attempt("req-1"));
        await harness.ledger.appendAttempt(attempt("req-2"));

        await expect(
          harness.ledger.appendFeedback(
            createFeedbackRecord({
              feedbackId: "fb-1",
              requestId: "req-2",
              candidateId: "req-1:candidate:0",
              feedback: "accepted",
            }),
          ),
        ).rejects.toBeInstanceOf(PredictionLedgerReferenceError);
      } finally {
        await harness.dispose();
      }
    });

    it("records an attempt that produced no candidates", async () => {
      const harness = await createLedger();
      try {
        await harness.ledger.appendAttempt(attempt("req-1", [], { status: "stale" }));

        const stored = (await harness.ledger.all())[0] as PredictionAttemptRecord;
        expect(stored.candidates).toEqual([]);
        expect(stored.status).toBe("stale");
      } finally {
        await harness.dispose();
      }
    });

    it("keeps every candidate of a multi-candidate attempt addressable", async () => {
      const harness = await createLedger();
      try {
        await harness.ledger.appendAttempt(
          attempt("req-1", [candidate(), candidate({ kind: "inspect_error" })]),
        );

        const stored = (await harness.ledger.all())[0] as PredictionAttemptRecord;
        expect(stored.candidates.map((c) => c.candidateId)).toEqual([
          "req-1:candidate:0",
          "req-1:candidate:1",
        ]);
        for (const envelope of stored.candidates) {
          await harness.ledger.appendFeedback(
            createFeedbackRecord({
              feedbackId: `fb-${envelope.ordinal}`,
              requestId: "req-1",
              candidateId: envelope.candidateId,
              feedback: "rejected",
            }),
          );
        }
        expect((await harness.ledger.all()).filter((r) => r.recordType === "feedback")).toHaveLength(2);
      } finally {
        await harness.dispose();
      }
    });

    it("isolates returned records from later mutation", async () => {
      const harness = await createLedger();
      try {
        await harness.ledger.appendAttempt(attempt());
        const first = (await harness.ledger.all())[0] as PredictionAttemptRecord;
        const original = first.candidates[0]!.parametersDigest;
        (first.candidates[0] as { parametersDigest: string }).parametersDigest = "mutated";

        const second = (await harness.ledger.all())[0] as PredictionAttemptRecord;
        expect(second.candidates[0]!.parametersDigest).toBe(original);
      } finally {
        await harness.dispose();
      }
    });

    // Strength varies by backend: JSONL genuinely interleaves await points and
    // this pins its write serialization, while `bun:sqlite` is synchronous so
    // each append runs to completion. Kept in the shared suite because the
    // contract — no lost or duplicated record under concurrent callers — is the
    // same, and a future async backend must satisfy it.
    it("serializes concurrent appends without losing a record", async () => {
      const harness = await createLedger();
      try {
        await Promise.all(
          Array.from({ length: 20 }, (_unused, index) =>
            harness.ledger.appendAttempt(attempt(`req-${index}`)),
          ),
        );

        const records = await harness.ledger.all();
        expect(records).toHaveLength(20);
        expect(new Set(records.map((r) => r.recordId)).size).toBe(20);
      } finally {
        await harness.dispose();
      }
    });
  });
}
