import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { candidate } from "../src/fake-prediction-provider.js";
import type { PredictionOutcome } from "../src/prediction-provider.js";
import {
  candidateEnvelopes,
  createAttemptRecord,
  createFeedbackRecord,
  InMemoryPredictionLedger,
  JsonlPredictionLedger,
  PredictionLedgerConflictError,
  PredictionLedgerReferenceError,
  type PredictionLedger,
} from "../src/prediction-ledger.js";
import { describePredictionLedgerConformance } from "./prediction-ledger-conformance.js";

describePredictionLedgerConformance("InMemoryPredictionLedger", async () => ({
  ledger: new InMemoryPredictionLedger(),
  dispose: async () => {},
}));

describePredictionLedgerConformance("JsonlPredictionLedger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "squid-jsonl-ledger-"));
  return {
    ledger: new JsonlPredictionLedger(join(directory, "ledger.jsonl")),
    dispose: async () => rm(directory, { recursive: true, force: true }),
  };
});

const outcome: PredictionOutcome = {
  requestId: "request-1",
  provider: "heuristic",
  status: "succeeded",
  candidates: [candidate("run_tests", 0.8)],
  latencyMs: 3,
};

function attempt() {
  const candidates = candidateEnvelopes(outcome.requestId, outcome.candidates);
  return createAttemptRecord({
    triggerEventId: "event-1",
    episodeId: "episode-1",
    triggeredAt: "2026-08-19T10:00:00.000Z",
    completedAt: "2026-08-19T10:00:00.003Z",
    outcome,
    candidates,
  });
}

async function assertLedgerContract(create: () => Promise<PredictionLedger>) {
  const ledger = await create();
  const record = attempt();
  await ledger.appendAttempt(record);
  const feedback = createFeedbackRecord({
    feedbackId: "feedback-1",
    requestId: record.requestId,
    candidateId: record.candidates[0]!.candidateId,
    feedback: "accepted",
    occurredAt: "2026-08-19T10:00:01.000Z",
    details: { surface: "test" },
  });
  await ledger.appendFeedback(feedback);

  expect(await ledger.all()).toEqual([record, feedback]);
  await ledger.appendAttempt(record);
  await ledger.appendFeedback(feedback);
  expect(await ledger.all()).toHaveLength(2);
}

describe("prediction candidate identity", () => {
  it("assigns deterministic IDs without changing provider candidates", () => {
    const candidates = [candidate("run_tests"), candidate("inspect_error")];
    const envelopes = candidateEnvelopes("request-x", candidates);

    expect(envelopes.map((item) => item.candidateId)).toEqual([
      "request-x:candidate:0",
      "request-x:candidate:1",
    ]);
    expect(envelopes.map((item) => item.candidate)).toEqual(candidates);
  });
});

describe("prediction ledger", () => {
  it("satisfies the in-memory append-only contract", async () => {
    await assertLedgerContract(async () => new InMemoryPredictionLedger());
  });

  it("persists attempts and feedback across JSONL reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "squid-ledger-"));
    const path = join(directory, "predictions.jsonl");
    await assertLedgerContract(async () => new JsonlPredictionLedger(path));

    const reopened = new JsonlPredictionLedger(path);
    expect(await reopened.all()).toHaveLength(2);
    expect((await readFile(path, "utf8")).split("\n")).toHaveLength(3);
  });

  it("rejects unknown feedback references and conflicting attempts", async () => {
    const ledger = new InMemoryPredictionLedger();
    const record = attempt();
    await expect(ledger.appendFeedback(createFeedbackRecord({
      feedbackId: "unknown",
      requestId: record.requestId,
      candidateId: "missing:candidate:0",
      feedback: "rejected",
    }))).rejects.toBeInstanceOf(PredictionLedgerReferenceError);

    await ledger.appendAttempt(record);
    const conflicting = { ...record, completedAt: "2026-08-19T10:00:02.000Z" };
    await expect(ledger.appendAttempt(conflicting)).rejects.toBeInstanceOf(PredictionLedgerConflictError);
  });

  it("rejects feedback that pairs a candidate with another request", async () => {
    const ledger = new InMemoryPredictionLedger();
    const record = attempt();
    await ledger.appendAttempt(record);

    await expect(ledger.appendFeedback(createFeedbackRecord({
      feedbackId: "wrong-request",
      requestId: "request-2",
      candidateId: record.candidates[0]!.candidateId,
      feedback: "rejected",
    }))).rejects.toBeInstanceOf(PredictionLedgerReferenceError);
  });

  it("recovers a truncated final JSONL record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "squid-ledger-tail-"));
    const path = join(directory, "predictions.jsonl");
    const record = attempt();
    await writeFile(path, `${JSON.stringify(record)}\n{"recordType":"attempt"`, "utf8");

    const ledger = new JsonlPredictionLedger(path);
    expect(await ledger.all()).toEqual([record]);
    expect(ledger.diagnostics).toEqual([{ kind: "truncated_final_record", line: 2 }]);
  });

  it("repairs a truncated tail before append so a later reopen succeeds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "squid-ledger-repair-"));
    const path = join(directory, "predictions.jsonl");
    const record = attempt();
    await writeFile(path, `${JSON.stringify(record)}\n{"recordType":"attempt"`, "utf8");

    const ledger = new JsonlPredictionLedger(path);
    await ledger.all();
    const feedback = createFeedbackRecord({
      feedbackId: "after-repair",
      requestId: record.requestId,
      candidateId: record.candidates[0]!.candidateId,
      feedback: "accepted",
    });
    await ledger.appendFeedback(feedback);

    const reopened = new JsonlPredictionLedger(path);
    expect(await reopened.all()).toEqual([record, feedback]);
  });

  it("reopens crash-retry duplicate records idempotently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "squid-ledger-duplicate-"));
    const path = join(directory, "predictions.jsonl");
    const record = attempt();
    await writeFile(path, `${JSON.stringify(record)}\n${JSON.stringify(record)}\n`, "utf8");

    const ledger = new JsonlPredictionLedger(path);
    expect(await ledger.all()).toEqual([record]);
  });

  it("serializes concurrent JSONL appends without interleaving", async () => {
    const directory = await mkdtemp(join(tmpdir(), "squid-ledger-concurrent-"));
    const path = join(directory, "predictions.jsonl");
    const ledger = new JsonlPredictionLedger(path);
    const base = attempt();

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const requestId = `req-${i}`;
        const candidates = candidateEnvelopes(requestId, outcome.candidates).map(
          (envelope, ordinal) => ({
            ...envelope,
            candidateId: `${requestId}:candidate:${ordinal}`,
          }),
        );
        return ledger.appendAttempt({
          ...base,
          recordId: `attempt:${requestId}`,
          requestId,
          candidates,
        });
      }),
    );

    expect(await ledger.all()).toHaveLength(20);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(20);
    expect(
      lines.every((line) => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      }),
    ).toBe(true);
  });
});
