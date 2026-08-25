import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
  candidateEnvelopes,
  createActionPlanRecord,
  createAttemptRecord,
  createBeliefBatchRecord,
  createFeedbackRecord,
  createPlanDecisionRecord,
  parsePredictionLedgerRecord,
  PredictionLedgerConflictError,
  PredictionLedgerReferenceError,
  type ActionPlanRecord,
  type BeliefBatchRecord,
  type PlanDecisionRecord,
  type PredictionAttemptRecord,
  type PredictionLedger,
} from "../src/prediction-ledger.js";
import {
  BELIEF_SCHEMA_VERSION,
  BELIEF_TYPE,
  type BeliefStateBatch,
} from "../src/belief-state.js";
import type { PredictionOutcome } from "../src/prediction-provider.js";
import type { PredictionCandidate } from "../src/protocol.js";

export interface LedgerHarness {
  readonly ledger: PredictionLedger;
  dispose(): Promise<void>;
}

export function candidate(overrides: Partial<PredictionCandidate> = {}): PredictionCandidate {
  return {
    kind: "run_tests",
    toolId: "run_tests",
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
 * A batch shaped exactly as `validateBatchAgainstRequest` would have accepted it.
 *
 * Hand-built rather than produced by `HeuristicBeliefProvider`, because what this
 * suite pins is the *ledger's* handling of a batch — persistence, identity, and
 * closure over cited evidence. Deriving it from a real provider would couple every
 * assertion here to which rules that provider happens to fire, and a rule change
 * would then read as a ledger regression.
 */
export function beliefBatch(overrides: Partial<BeliefStateBatch> = {}): BeliefStateBatch {
  return {
    schemaVersion: BELIEF_SCHEMA_VERSION,
    beliefBatchId: "batch-1",
    projectionGeneration: 1,
    episodeId: "ep-1",
    stateDigest: `sha256:${"a".repeat(64)}`,
    generatedAt: "2026-08-19T10:00:00.000Z",
    provider: "heuristic-belief",
    modelVersion: "v1",
    promptVersion: "v1",
    contextPolicyId: "passthrough",
    beliefs: [{
      id: "belief-0",
      type: BELIEF_TYPE,
      value: "validate_change",
      confidence: 0.8,
      // `evt-1` is the same event `attempt()` names as its trigger, so a deletion
      // that takes the attempt also takes this batch — which is the closure case.
      evidenceEventIds: ["evt-1"],
      inferredAt: "2026-08-19T10:00:00.000Z",
      expiresAt: "2026-08-19T10:02:00.000Z",
    }],
    ...overrides,
  };
}

export function beliefRecord(
  requestId = "req-1",
  overrides: Partial<BeliefStateBatch> = {},
): BeliefBatchRecord {
  return createBeliefBatchRecord({
    requestId,
    batch: beliefBatch(overrides),
    observedAt: "2026-08-19T10:00:00.750Z",
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
          harness.ledger.appendAttempt(attempt("req-1", [candidate({ kind: "inspect_error", toolId: "run_check" })])),
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
          ...attempt("req-1", [candidate({ kind: "inspect_error", toolId: "run_check" })]),
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
          attempt("req-1", [candidate(), candidate({ kind: "inspect_error", toolId: "run_check" })]),
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

    /**
     * Beliefs persist as *history*: auditable, never re-validated as current, and
     * never read back as ranking input. These pin the storage half of that — that a
     * batch survives a round trip intact, that it does not need an attempt to exist,
     * and that a replay is idempotent. The closure half is below.
     */
    describe("appendBeliefBatch", () => {
      it("round-trips a validated batch without loss", async () => {
        const harness = await createLedger();
        try {
          const record = beliefRecord();
          await harness.ledger.appendBeliefBatch(record);

          const records = await harness.ledger.all();
          expect(records).toHaveLength(1);
          expect(records[0]).toEqual(record);
          // The whole batch survives, not a summary of it. A report that could only
          // see counts would not be able to answer what was believed.
          const stored = records[0] as BeliefBatchRecord;
          expect(stored.batch.beliefs[0]?.value).toBe("validate_change");
          expect(stored.batch.stateDigest).toBe(beliefBatch().stateDigest);
        } finally {
          await harness.dispose();
        }
      });

      it("accepts a batch with no attempt record for its request", async () => {
        // A batch is produced before the prediction it informs has an outcome, and
        // that prediction may fail or be cancelled. Requiring an attempt first would
        // discard exactly the batches a failed run most needs explained.
        const harness = await createLedger();
        try {
          await expect(
            harness.ledger.appendBeliefBatch(beliefRecord("req-never-completed")),
          ).resolves.toBeUndefined();
          expect(await harness.ledger.all()).toHaveLength(1);
        } finally {
          await harness.dispose();
        }
      });

      it("treats a byte-identical re-append as a no-op", async () => {
        const harness = await createLedger();
        try {
          const record = beliefRecord();
          await harness.ledger.appendBeliefBatch(record);
          await harness.ledger.appendBeliefBatch(record);

          expect(await harness.ledger.all()).toHaveLength(1);
        } finally {
          await harness.dispose();
        }
      });

      it("rejects a different batch under the same batch ID", async () => {
        // Identity comes from `beliefBatchId`, so two different inferences claiming
        // one id is a producer bug. Accepting the second silently would leave the
        // audit trail asserting whichever landed last.
        const harness = await createLedger();
        try {
          await harness.ledger.appendBeliefBatch(beliefRecord());

          await expect(
            harness.ledger.appendBeliefBatch(
              beliefRecord("req-1", { projectionGeneration: 2 }),
            ),
          ).rejects.toBeInstanceOf(PredictionLedgerConflictError);
          expect(await harness.ledger.all()).toHaveLength(1);
        } finally {
          await harness.dispose();
        }
      });

      it("keeps a batch beside the attempt for the same request", async () => {
        // Two records about one prediction, and neither constrains the other: the
        // belief record is not a foreign key onto the attempt.
        const harness = await createLedger();
        try {
          await harness.ledger.appendAttempt(attempt("req-1"));
          await harness.ledger.appendBeliefBatch(beliefRecord("req-1"));

          expect((await harness.ledger.all()).map((r) => r.recordType))
            .toEqual(["attempt", "belief_batch"]);
        } finally {
          await harness.dispose();
        }
      });

      it("re-parses a stored batch without loss", async () => {
        const harness = await createLedger();
        try {
          await harness.ledger.appendBeliefBatch(beliefRecord());

          const record = (await harness.ledger.all())[0]!;
          expect(parsePredictionLedgerRecord(JSON.parse(JSON.stringify(record))))
            .toEqual(record);
        } finally {
          await harness.dispose();
        }
      });
    });

    // Retention deletion is the one operation that removes from the ledger,
    // and its whole point is the Done-when of issue #6: after deleting events,
    // no surviving ledger record may reference what was removed. The closure —
    // attempt → candidates → feedback/plan → decision/dispatch — is contract,
    // so every backend must walk it identically.
    describe("deleteRecordsRemovedWithEvents", () => {
      // Distinct valid digests for the doomed and surviving chains.
      const DOOMED_DIGEST = `sha256:${"b".repeat(64)}`;
      const KEPT_DIGEST = `sha256:${"c".repeat(64)}`;

      async function seedFullChain(harness: { readonly ledger: PredictionLedger }): Promise<void> {
        // `attempt()` hardcodes `triggerEventId: "evt-1"` — that is the doomed
        // chain's trigger. The surviving attempt gets its own event id.
        const survivor = attemptWithTrigger("kept-req", "evt-survives");
        await harness.ledger.appendAttempt(attempt("doomed-req"));
        await harness.ledger.appendAttempt(survivor);

        await harness.ledger.appendFeedback(createFeedbackRecord({
          feedbackId: "fb-doomed",
          requestId: "doomed-req",
          candidateId: "doomed-req:candidate:0",
          feedback: "accepted",
        }));
        await harness.ledger.appendFeedback(createFeedbackRecord({
          feedbackId: "fb-kept",
          requestId: "kept-req",
          candidateId: "kept-req:candidate:0",
          feedback: "accepted",
        }));

        const doomedPlan = planFor("doomed-req", "doomed-req:candidate:0", DOOMED_DIGEST);
        const keptPlan = planFor("kept-req", "kept-req:candidate:0", KEPT_DIGEST);
        await harness.ledger.recordPlan(doomedPlan);
        await harness.ledger.recordPlan(keptPlan);
        await harness.ledger.recordDecision(decisionFor(DOOMED_DIGEST, "accepted"));
        await harness.ledger.recordDecision(decisionFor(KEPT_DIGEST, "rejected"));
      }

      function attemptWithTrigger(requestId: string, triggerEventId: string): PredictionAttemptRecord {
        return { ...attempt(requestId), triggerEventId };
      }

      function planFor(
        requestId: string,
        candidateId: string,
        digest: string,
      ): ActionPlanRecord {
        return createActionPlanRecord({
          attemptId: requestId,
          requestId,
          candidateId,
          planDigest: digest,
          candidateParametersDigest: `sha256:${"c".repeat(64)}`,
          confirmation: "required",
          egressPolicyId: "search-egress-deny-v1",
        });
      }

      function decisionFor(digest: string, decision: "accepted" | "rejected"): PlanDecisionRecord {
        return createPlanDecisionRecord({
          planDigest: digest,
          decision,
          detailsDigest: `sha256:${createHash("sha256").update(decision).digest("hex")}`,
        });
      }

      it("removes only the closure of the named trigger events", async () => {
        const harness = await createLedger();
        try {
          await seedFullChain(harness);

          const removed = await harness.ledger.deleteRecordsRemovedWithEvents(new Set(["evt-1"]));

          // The doomed chain: its attempt, its feedback, its plan, its decision.
          expect(removed).toBe(4);
          const remaining = (await harness.ledger.all()).map((r) => r.recordId).sort();
          expect(remaining).toEqual([
            "attempt:kept-req",
            "feedback:fb-kept",
            `plan:kept-req:candidate:0:${KEPT_DIGEST}`,
            `plan_decision:${KEPT_DIGEST}:rejected`,
          ].sort());
        } finally {
          await harness.dispose();
        }
      });

      it("leaves nothing dangling after deletion", async () => {
        // The Done-when stated as an assertion: every surviving reference
        // resolves. Feedback → candidate must exist inside a surviving attempt;
        // a plan's attemptId must be a surviving attempt.
        const harness = await createLedger();
        try {
          await seedFullChain(harness);
          await harness.ledger.deleteRecordsRemovedWithEvents(new Set(["evt-1"]));

          const records = await harness.ledger.all();
          const survivingCandidates = new Set(
            records.flatMap((r) =>
              r.recordType === "attempt" ? r.candidates.map((c) => c.candidateId) : []),
            );
          // Plans reference attempts by requestId, so the surviving set is
          // keyed by requestId, not recordId.
          const survivingAttempts = new Set(
            records.filter((r) => r.recordType === "attempt").map((r) => r.requestId),
          );
          for (const record of records) {
            if (record.recordType === "feedback") {
              expect(survivingCandidates.has(record.candidateId)).toBe(true);
            }
            if (record.recordType === "plan") {
              expect(survivingAttempts.has(record.attemptId)).toBe(true);
              expect(survivingCandidates.has(record.candidateId)).toBe(true);
            }
          }
        } finally {
          await harness.dispose();
        }
      });

      it("keeps unrelated history byte-identical", async () => {
        const harness = await createLedger();
        try {
          await seedFullChain(harness);
          // Snapshot the four known survivors by recordId: a doomed chain
          // decision carries only its digest in its id, so substring matching
          // on "doomed" would wrongly include it.
          const survivingRecordIds = new Set([
            "attempt:kept-req",
            "feedback:fb-kept",
            `plan:kept-req:candidate:0:${KEPT_DIGEST}`,
            `plan_decision:${KEPT_DIGEST}:rejected`,
          ]);
          const before = (await harness.ledger.all())
            .filter((r) => survivingRecordIds.has(r.recordId))
            .map((r) => structuredClone(r));
          expect(before).toHaveLength(4);

          await harness.ledger.deleteRecordsRemovedWithEvents(new Set(["evt-1"]));

          const after = await harness.ledger.all();
          for (const record of before) {
            expect(after).toContainEqual(record);
          }
        } finally {
          await harness.dispose();
        }
      });

      it("returns zero and changes nothing when no record references the events", async () => {
        const harness = await createLedger();
        try {
          await seedFullChain(harness);

          const removed = await harness.ledger.deleteRecordsRemovedWithEvents(
            new Set(["evt-never-triggered"]),
          );
          expect(removed).toBe(0);
          expect(await harness.ledger.all()).toHaveLength(8);
        } finally {
          await harness.dispose();
        }
      });

      it("accepts appends normally after a deletion", async () => {
        // Deletion is mid-life maintenance, not teardown: the ledger stays
        // writable, and uniqueness constraints keep holding against new ids.
        const harness = await createLedger();
        try {
          await seedFullChain(harness);
          await harness.ledger.deleteRecordsRemovedWithEvents(new Set(["evt-1"]));

          await expect(
            harness.ledger.appendAttempt(attempt("post-delete")),
          ).resolves.toBeUndefined();
          expect((await harness.ledger.all()).at(-1)?.recordId).toBe("attempt:post-delete");
        } finally {
          await harness.dispose();
        }
      });

      it("removes a belief batch whose evidence was deleted", async () => {
        // Issue #12's Done-when: whatever is persisted must be covered by retention
        // closure. A belief cites `evidenceEventIds` directly — that citation is the
        // entire basis on which a belief can be audited — so a stored batch outliving
        // its evidence is exactly the orphan this closure forbids.
        const harness = await createLedger();
        try {
          await harness.ledger.appendBeliefBatch(beliefRecord());

          const removed = await harness.ledger.deleteRecordsRemovedWithEvents(
            new Set(["evt-1"]),
          );

          expect(removed).toBe(1);
          expect(await harness.ledger.all()).toEqual([]);
        } finally {
          await harness.dispose();
        }
      });

      it("keeps a belief batch whose evidence survived", async () => {
        // The negative half. A closure that removed every batch on any deletion
        // would also satisfy the assertion above, and would quietly destroy the
        // history this issue exists to accumulate.
        const harness = await createLedger();
        try {
          await harness.ledger.appendBeliefBatch(
            beliefRecord("req-1", {
              beliefBatchId: "batch-survives",
              beliefs: beliefBatch().beliefs.map((belief) => ({
                ...belief,
                evidenceEventIds: ["evt-survives"],
              })),
            }),
          );

          const removed = await harness.ledger.deleteRecordsRemovedWithEvents(
            new Set(["evt-1"]),
          );

          expect(removed).toBe(0);
          expect(await harness.ledger.all()).toHaveLength(1);
        } finally {
          await harness.dispose();
        }
      });

      it("removes a batch citing several events when any one of them goes", async () => {
        // A belief is inferred from its evidence as a set. Losing one member makes
        // the inference unreproducible, so partial evidence is not weaker evidence —
        // it is an unauditable claim, and the whole record goes.
        const harness = await createLedger();
        try {
          await harness.ledger.appendBeliefBatch(
            beliefRecord("req-1", {
              beliefs: beliefBatch().beliefs.map((belief) => ({
                ...belief,
                evidenceEventIds: ["evt-1", "evt-survives"],
              })),
            }),
          );

          expect(await harness.ledger.deleteRecordsRemovedWithEvents(new Set(["evt-1"])))
            .toBe(1);
          expect(await harness.ledger.all()).toEqual([]);
        } finally {
          await harness.dispose();
        }
      });

      it("removes a batch independently of the attempt for its request", async () => {
        // The two are not linked, in either direction: a surviving attempt must not
        // hold a batch whose evidence is gone, and a deleted attempt must not drag
        // down a batch whose own evidence survived.
        const harness = await createLedger();
        try {
          await harness.ledger.appendAttempt(attemptWithTrigger("req-1", "evt-survives"));
          await harness.ledger.appendBeliefBatch(beliefRecord("req-1"));

          expect(await harness.ledger.deleteRecordsRemovedWithEvents(new Set(["evt-1"])))
            .toBe(1);
          const remaining = await harness.ledger.all();
          expect(remaining.map((r) => r.recordType)).toEqual(["attempt"]);
        } finally {
          await harness.dispose();
        }
      });

      it("reuses freed identity without conflict", async () => {
        // After the doomed chain is gone, re-appending an attempt with the same
        // request id must succeed: deletion means deleted, not reserved. This
        // is exactly where a tombstone design would fail — the id would still
        // be held by the tombstone.
        const harness = await createLedger();
        try {
          const doomed = attempt("doomed-req");
          await harness.ledger.appendAttempt(doomed);
          await harness.ledger.deleteRecordsRemovedWithEvents(new Set(["evt-1"]));
          expect(await harness.ledger.all()).toHaveLength(0);

          await expect(
            harness.ledger.appendAttempt(attempt("doomed-req")),
          ).resolves.toBeUndefined();
          expect(await harness.ledger.all()).toHaveLength(1);
        } finally {
          await harness.dispose();
        }
      });
    });
  });
}
