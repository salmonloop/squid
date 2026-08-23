import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createActivityEvent } from "../src/protocol.js";
import {
  candidateEnvelopes,
  createActionPlanRecord,
  createAttemptRecord,
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
        rationale: "saved",
        confidence: 0.9,
        expiresAt: NEW_AT,
        sourceEventIds: [triggerEventId],
        parameters: {},
      }],
    },
    candidates: candidateEnvelopes(requestId, [{
      kind: "run_tests",
      rationale: "saved",
      confidence: 0.9,
      expiresAt: NEW_AT,
      sourceEventIds: [triggerEventId],
      parameters: {},
    }]),
  });
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
  });
}
