import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  createFeedbackRecord,
  PredictionLedgerConflictError,
  type PredictionAttemptRecord,
} from "../src/prediction-ledger.js";
import { SqlitePredictionLedger } from "../src/sqlite-prediction-ledger.js";
import { attempt, candidate, describePredictionLedgerConformance } from "./prediction-ledger-conformance.js";

async function tempDatabase(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "squid-ledger-"));
  return {
    path: join(directory, "ledger.db"),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

describePredictionLedgerConformance("SqlitePredictionLedger", async () => {
  const database = await tempDatabase();
  const ledger = new SqlitePredictionLedger(database.path);
  return {
    ledger,
    dispose: async () => {
      ledger.close();
      await database.cleanup();
    },
  };
});

describe("SqlitePredictionLedger", () => {
  it("survives a reopen on a new connection", async () => {
    const database = await tempDatabase();
    try {
      const first = new SqlitePredictionLedger(database.path);
      await first.appendAttempt(attempt());
      await first.appendFeedback(
        createFeedbackRecord({
          feedbackId: "fb-1",
          requestId: "req-1",
          candidateId: "req-1:candidate:0",
          feedback: "accepted",
        }),
      );
      first.close();

      const second = new SqlitePredictionLedger(database.path);
      const records = await second.all();
      expect(records.map((r) => r.recordId)).toEqual(["attempt:req-1", "feedback:fb-1"]);
      second.close();
    } finally {
      await database.cleanup();
    }
  });

  it("still rejects a conflicting attempt after a reopen", async () => {
    // The uniqueness invariant must live in the schema, not in a process-local
    // index that a restart would forget.
    const database = await tempDatabase();
    try {
      const first = new SqlitePredictionLedger(database.path);
      await first.appendAttempt(attempt("req-1"));
      first.close();

      const second = new SqlitePredictionLedger(database.path);
      await expect(
        second.appendAttempt(attempt("req-1", [candidate({ kind: "none" })])),
      ).rejects.toBeInstanceOf(PredictionLedgerConflictError);
      second.close();
    } finally {
      await database.cleanup();
    }
  });

  it("leaves no attempt or candidate behind when a later candidate insert fails", async () => {
    // Attempt and candidates are one fact. A partially-written attempt would
    // make candidates unaddressable while the attempt looked complete.
    //
    // The collision has to be on a NON-FIRST candidate, so the transaction has
    // already inserted rows before it fails. A forged record cannot be used:
    // `parsePredictionLedgerRecord` rejects a candidate ID that disagrees with
    // its request and ordinal before any SQL runs, so the rollback would never
    // be exercised.
    const database = await tempDatabase();
    try {
      const ledger = new SqlitePredictionLedger(database.path);
      await ledger.appendAttempt(attempt("req-1"));

      // Claim req-2's ordinal-1 candidate ID out from under it via a second
      // connection, so req-2's ordinal 0 inserts and ordinal 1 collides.
      const squatter = new Database(database.path);
      squatter
        .query(`INSERT INTO ledger_candidates (candidate_id, request_id, ordinal) VALUES (?, ?, ?)`)
        .run("req-2:candidate:1", "unrelated-request", 1);
      squatter.close();

      await expect(
        ledger.appendAttempt(attempt("req-2", [candidate(), candidate({ kind: "inspect_error" })])),
      ).rejects.toBeInstanceOf(PredictionLedgerConflictError);

      expect((await ledger.all()).map((r) => r.recordId)).toEqual(["attempt:req-1"]);
      // The ordinal-0 row inserted inside the failed transaction must be gone.
      const inspect = new Database(database.path);
      const orphans = inspect
        .query(`SELECT candidate_id FROM ledger_candidates WHERE request_id = ?`)
        .all("req-2");
      inspect.close();
      expect(orphans).toEqual([]);
      ledger.close();
    } finally {
      await database.cleanup();
    }
  });

  it("rejects use after close", async () => {
    const database = await tempDatabase();
    try {
      const ledger = new SqlitePredictionLedger(database.path);
      ledger.close();

      await expect(ledger.appendAttempt(attempt())).rejects.toThrow(
        "SqlitePredictionLedger is closed.",
      );
      await expect(ledger.all()).rejects.toThrow("SqlitePredictionLedger is closed.");
    } finally {
      await database.cleanup();
    }
  });

  it("is idempotent on close", async () => {
    const database = await tempDatabase();
    try {
      const ledger = new SqlitePredictionLedger(database.path);
      ledger.close();
      expect(() => ledger.close()).not.toThrow();
    } finally {
      await database.cleanup();
    }
  });

  it("creates a missing parent directory", async () => {
    const database = await tempDatabase();
    try {
      const nested = join(database.path, "..", "nested", "deeper", "ledger.db");
      const ledger = new SqlitePredictionLedger(nested);
      await ledger.appendAttempt(attempt());
      expect(await ledger.all()).toHaveLength(1);
      ledger.close();
    } finally {
      await database.cleanup();
    }
  });

  it("preserves sub-millisecond timestamp spellings", async () => {
    const database = await tempDatabase();
    try {
      const ledger = new SqlitePredictionLedger(database.path);
      const record = {
        ...attempt(),
        triggeredAt: "2026-08-19T10:00:00.123456Z",
      } as PredictionAttemptRecord;
      await ledger.appendAttempt(record);

      const stored = (await ledger.all())[0] as PredictionAttemptRecord;
      expect(stored.triggeredAt).toBe("2026-08-19T10:00:00.123456Z");
      ledger.close();
    } finally {
      await database.cleanup();
    }
  });
});
