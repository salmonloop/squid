import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createActivityEvent } from "../src/protocol.js";
import {
  BELIEF_SCHEMA_VERSION,
  BELIEF_TYPE,
  type BeliefStateBatch,
} from "../src/belief-state.js";
import {
  candidateEnvelopes,
  createActionPlanRecord,
  createAttemptRecord,
  createBeliefBatchRecord,
  createFeedbackRecord,
  createPlanDecisionRecord,
} from "../src/prediction-ledger.js";
import { runRetentionPrune } from "../src/retention-prune.js";
import {
  InMemoryEventStore,
  JsonlEventStore,
  type EventStore,
} from "../src/event-store.js";
import {
  InMemoryPredictionLedger,
  type PredictionLedger,
} from "../src/prediction-ledger.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { SqlitePredictionLedger } from "../src/sqlite-prediction-ledger.js";

/**
 * End-to-end retention: the Done-when for issue #6 stated as an assertion.
 *
 * "Deletion leaves no ledger record referencing a removed event" is a
 * cross-backend property — it holds because the closure resolver is shared
 * contract, so the same scenario must hold on every store/ledger pairing the
 * system can actually produce. A durable run pairs SqliteEventStore with
 * SqlitePredictionLedger; the in-memory pair covers tests and demos; JSONL
 * exists to exercise the crash-tail failure model. All three are asserted
 * here rather than assumed from their conformance suites, because this test
 * pins the *composition* (store delete feeding ledger resolve), which no
 * single-backend suite sees.
 */

interface Harness {
  readonly store: EventStore;
  readonly ledger: PredictionLedger;
  dispose(): Promise<void>;
}

const tempDirs: string[] = [];

async function sqliteHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "squid-retention-"));
  tempDirs.push(dir);
  const store = new SqliteEventStore(join(dir, "events.db"));
  const ledger = new SqlitePredictionLedger(join(dir, "events.db.ledger.db"));
  return {
    store,
    ledger,
    dispose: async () => {
      store.close();
      ledger.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function jsonlHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "squid-retention-"));
  tempDirs.push(dir);
  return {
    store: new JsonlEventStore(join(dir, "events.jsonl")),
    ledger: new InMemoryPredictionLedger(),
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

async function memoryHarness(): Promise<Harness> {
  return Promise.resolve({
    store: new InMemoryEventStore(),
    ledger: new InMemoryPredictionLedger(),
    dispose: () => Promise.resolve(),
  });
}

/** An old event inside the retention range, and a fresh one outside it. */
const OLD_AT = "2026-08-01T00:00:00.000Z";
const NEW_AT = "2026-08-21T12:00:00.000Z";
const CUTOFF_MS = Date.parse("2026-08-20T00:00:00.000Z");

function eventAt(eventId: string, occurredAt: string): ReturnType<typeof createActivityEvent> {
  return createActivityEvent({
    kind: "file_saved",
    eventId,
    occurredAt,
    payload: { path: `${eventId}.ts`, applicationId: null },
  });
}

function attemptFor(
  requestId: string,
  triggerEventId: string,
  /** Defaults to the trigger alone; tests citing extra evidence pass more. */
  sourceEventIds: readonly string[] = [triggerEventId],
): ReturnType<typeof createAttemptRecord> {
  return createAttemptRecord({
    triggerEventId,
    episodeId: `ep-${requestId}`,
    triggeredAt: NEW_AT,
    completedAt: NEW_AT,
    runtimeSessionId: "retention-test",
    stateDigest: `sha256:${"a".repeat(64)}`,
    projectionGeneration: 1,
    triggerDisposition: "accepted",
    contextPolicyId: "passthrough",
    actionTrust: "trusted",
    egressPolicyId: "search-egress-deny-v1",
    outcome: {
      requestId,
      provider: "fake",
      status: "succeeded",
      latencyMs: 5,
      candidates: [{
        kind: "run_tests",
        toolId: "run_tests",
        rationale: "saved",
        confidence: 0.9,
        expiresAt: NEW_AT,
        sourceEventIds,
        parameters: {},
      }],
    },
    candidates: candidateEnvelopes(requestId, [{
      kind: "run_tests",
      toolId: "run_tests",
      rationale: "saved",
      confidence: 0.9,
      expiresAt: NEW_AT,
      sourceEventIds,
      parameters: {},
    }]),
  });
}

/**
 * A batch shaped as validation would have accepted it, citing exactly the given
 * events. Timestamps sit at `NEW_AT` regardless of the evidence's age: a belief's
 * own lifetime has nothing to do with retention, which is the point — deletion
 * follows the evidence, not the TTL a producer claimed.
 */
function batchCiting(
  beliefBatchId: string,
  evidenceEventIds: readonly string[],
): BeliefStateBatch {
  return {
    schemaVersion: BELIEF_SCHEMA_VERSION,
    beliefBatchId,
    projectionGeneration: 1,
    episodeId: "ep-retention",
    stateDigest: `sha256:${"a".repeat(64)}`,
    generatedAt: NEW_AT,
    provider: "heuristic-belief",
    modelVersion: "v1",
    promptVersion: "v1",
    contextPolicyId: "passthrough",
    beliefs: [{
      id: `${beliefBatchId}:belief:0`,
      type: BELIEF_TYPE,
      value: "validate_change",
      confidence: 0.8,
      evidenceEventIds: [...evidenceEventIds],
      inferredAt: NEW_AT,
      expiresAt: new Date(Date.parse(NEW_AT) + 120_000).toISOString(),
    }],
  };
}

/**
 * Seeds one doomed chain (old trigger) and one surviving chain (fresh
 * trigger), each: attempt → feedback → plan → decision. The doomed side has
 * four records; deleting its trigger event must remove all four and touch
 * nothing else.
 */
async function seedChains(harness: Harness): Promise<void> {
  await harness.store.append(eventAt("evt-old", OLD_AT));
  await harness.store.append(eventAt("evt-new", NEW_AT));

  await harness.ledger.appendAttempt(attemptFor("doomed-req", "evt-old"));
  await harness.ledger.appendFeedback(createFeedbackRecord({
    feedbackId: "fb-doomed",
    requestId: "doomed-req",
    candidateId: "doomed-req:candidate:0",
    feedback: "accepted",
  }));
  const doomedDigest = `sha256:${"b".repeat(64)}`;
  await harness.ledger.recordPlan(createActionPlanRecord({
    attemptId: "doomed-req",
    requestId: "doomed-req",
    candidateId: "doomed-req:candidate:0",
    planDigest: doomedDigest,
    candidateParametersDigest: `sha256:${"c".repeat(64)}`,
    confirmation: "required",
    egressPolicyId: "search-egress-deny-v1",
  }));
  await harness.ledger.recordDecision(createPlanDecisionRecord({
    planDigest: doomedDigest,
    decision: "rejected",
    detailsDigest: `sha256:${"d".repeat(64)}`,
  }));

  await harness.ledger.appendAttempt(attemptFor("kept-req", "evt-new"));
}

for (const [name, create] of [
  ["sqlite", sqliteHarness],
  ["jsonl+memory", jsonlHarness],
  ["in-memory", memoryHarness],
] as const) {
  describe(`retention prune end-to-end (${name})`, () => {
    it("removes old events and the full dependent ledger closure, keeping the rest", async () => {
      const harness = await create();
      try {
        await seedChains(harness);

        const result = await runRetentionPrune(harness.store, harness.ledger, {
          cutoffMs: CUTOFF_MS,
        });

        expect(result.removedEvents).toBe(1);
        expect(result.removedRecords).toBe(4);

        const events = await harness.store.all();
        expect(events.map((e) => e.eventId)).toEqual(["evt-new"]);

        // Nothing dangles: every surviving reference resolves inside what
        // survived. This is the Done-when, restated as an invariant.
        const records = await harness.ledger.all();
        const survivors = new Set(records.map((r) => r.recordId));
        const candidates = new Set(
          records.flatMap((r) =>
            r.recordType === "attempt" ? r.candidates.map((c) => c.candidateId) : []),
        );
        for (const record of records) {
          if (record.recordType === "feedback") {
            expect(candidates.has(record.candidateId)).toBe(true);
            expect(survivors.has(`attempt:${"doomed"}`)).toBe(false);
          }
          if (record.recordType === "attempt") {
            expect(events.some((e) => e.eventId === record.triggerEventId)).toBe(true);
          }
          if (record.recordType === "plan") {
            expect(candidates.has(record.candidateId)).toBe(true);
          }
        }
        expect(survivors.size).toBe(1); // only kept-req's attempt remains
      } finally {
        await harness.dispose();
      }
    });

    it("is a no-op when everything is younger than the cutoff", async () => {
      const harness = await create();
      try {
        await seedChains(harness);

        const result = await runRetentionPrune(harness.store, harness.ledger, {
          cutoffMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });

        expect(result).toEqual({ removedEvents: 0, removedRecords: 0 });
        expect(await harness.store.all()).toHaveLength(2);
        expect(await harness.ledger.all()).toHaveLength(5);
      } finally {
        await harness.dispose();
      }
    });

    it("removes a persisted belief batch when its evidence ages out", async () => {
      // Issue #12's Done-when, end to end rather than at the ledger boundary: a
      // real store deletes real events and the belief history goes with them. The
      // ledger's own suite proves the closure walks correctly given a removed-event
      // set; this proves the *composition* derives that set from a belief's
      // citations at all. A batch citing only aged-out events names no removed event
      // that `resolveRemovedEventIds` could see unless `recordEventReferences`
      // reports belief evidence, and a batch outliving its evidence is the orphan
      // the closure forbids.
      const harness = await create();
      try {
        await harness.store.append(eventAt("evt-old", OLD_AT));
        await harness.store.append(eventAt("evt-new", NEW_AT));
        await harness.ledger.appendBeliefBatch(createBeliefBatchRecord({
          requestId: "belief-req",
          batch: batchCiting("doomed-batch", ["evt-old"]),
        }));
        await harness.ledger.appendBeliefBatch(createBeliefBatchRecord({
          requestId: "belief-req-2",
          batch: batchCiting("kept-batch", ["evt-new"]),
        }));

        const result = await runRetentionPrune(harness.store, harness.ledger, {
          cutoffMs: CUTOFF_MS,
        });

        expect(result.removedEvents).toBe(1);
        expect(result.removedRecords).toBe(1);

        // What survives is self-contained: the remaining batch cites only events the
        // store still holds. That is the invariant; the count above is its shadow.
        const survivors = new Set((await harness.store.all()).map((e) => e.eventId));
        const records = await harness.ledger.all();
        expect(records).toHaveLength(1);
        for (const record of records) {
          if (record.recordType !== "belief_batch") continue;
          for (const belief of record.batch.beliefs) {
            for (const eventId of belief.evidenceEventIds) {
              expect(survivors.has(eventId)).toBe(true);
            }
          }
        }

        // And a repeat pass finds nothing: the closure is stable over belief records
        // the same way it is over attempts.
        expect(await runRetentionPrune(harness.store, harness.ledger, {
          cutoffMs: CUTOFF_MS,
        })).toEqual({ removedEvents: 0, removedRecords: 0 });
      } finally {
        await harness.dispose();
      }
    });

    it("removes an attempt whose trigger survives but whose cited evidence does not", async () => {
      // The hole the closure existed for and did not cover: `sourceEventIds`
      // are events a prediction *read*, not the one that fired it. A trigger
      // inside the retention window can cite evidence outside it — or evidence
      // deleted by an earlier partial pass — so "the trigger survived" is not
      // proof the attempt's references all resolve. Before
      // `recordEventReferences`, both halves of deletion matched on
      // `triggerEventId` alone and this scenario left the attempt in place,
      // pointing at an event that no longer existed.
      const harness = await create();
      try {
        await harness.store.append(eventAt("evt-trigger", NEW_AT));
        await harness.store.append(eventAt("evt-evidence", OLD_AT));

        await harness.ledger.appendAttempt(
          attemptFor("evidence-req", "evt-trigger", ["evt-trigger", "evt-evidence"]),
        );

        const result = await runRetentionPrune(harness.store, harness.ledger, {
          cutoffMs: CUTOFF_MS,
        });

        // The trigger survived, so event deletion removed one event but the
        // attempt must go with its evidence anyway.
        expect(result.removedEvents).toBe(1);
        expect(result.removedRecords).toBe(1);

        const records = await harness.ledger.all();
        expect(records).toHaveLength(0);

        // And a repeat pass finds nothing left over: the closure is stable.
        const second = await runRetentionPrune(harness.store, harness.ledger, {
          cutoffMs: CUTOFF_MS,
        });
        expect(second).toEqual({ removedEvents: 0, removedRecords: 0 });
      } finally {
        await harness.dispose();
      }
    });
  });
}
