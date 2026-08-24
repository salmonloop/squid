import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  createPlanInvalidationRecord,
  parsePredictionLedgerRecord,
  PlanDispatchStateMachine,
  PredictionLedgerConflictError,
  PredictionLedgerReferenceError,
  recordIdentity,
  resolveRecordsRemovedWithEvents,
  type ActionPlanRecord,
  type BeliefBatchRecord,
  type ClaimDispatchInputs,
  type CompleteDispatchResult,
  type DispatchClaimResult,
  type PlanDecisionRecord,
  type PlanDispatchRecord,
  type PredictionAttemptRecord,
  type PredictionFeedbackRecord,
  type PredictionLedger,
  type PredictionLedgerRecord,
} from "./prediction-ledger.js";

/**
 * Durable prediction ledger on SQLite.
 *
 * `record_json` is authoritative — every read rehydrates through
 * `parsePredictionLedgerRecord`, so optional fields and candidate envelopes
 * survive a round trip unchanged. The scalar columns exist for integrity and
 * filtering only.
 *
 * The invariants the in-memory index checks procedurally are declared here as
 * schema constraints instead: one attempt per request, globally unique candidate
 * IDs, and feedback that must reference a candidate row. That is the reason to
 * prefer this over JSONL at scale — a corrupt ledger becomes unrepresentable
 * rather than merely unwritten.
 */
export class SqlitePredictionLedger implements PredictionLedger {
  private readonly database: Database;
  private closed = false;

  public constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.database = new Database(filePath, { create: true });
    try {
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA synchronous = NORMAL");
      // Required: feedback→candidate referential integrity is enforced by the
      // engine, and SQLite ignores foreign keys unless this is on per connection.
      this.database.exec("PRAGMA foreign_keys = ON");
      // A second watch-files process pointing at the same ledger would contend;
      // single-process access is the norm but the timeout is a cheap safety net.
      this.database.exec("PRAGMA busy_timeout = 5000");
      this.database.exec(SCHEMA);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  public async deleteRecordsRemovedWithEvents(
    removedEventIds: ReadonlySet<string>,
  ): Promise<number> {
    this.assertOpen();
    // One transaction: the closure is computed and applied atomically, so no
    // concurrent append can interleave between resolving what must go and
    // removing it — a feedback record appended mid-delete would otherwise
    // reference a candidate deleted microseconds later.
    const transaction = this.database.transaction((): number => {
      const recordIds = resolveRecordsRemovedWithEvents(this.allSync(), removedEventIds);
      if (recordIds.size === 0) return 0;
      const placeholders = [...recordIds].map(() => "?").join(", ");
      this.database
        .query(`DELETE FROM ledger_records WHERE record_id IN (${placeholders})`)
        .run(...recordIds);

      // Candidate rows go after records: `ledger_records.candidate_id`
      // references this table, so deleting a candidate first could fire the FK
      // against a record row that the same transaction is about to remove.
      const orphaned = this.database
        .query(
          `SELECT c.candidate_id FROM ledger_candidates c
           LEFT JOIN ledger_records r ON r.record_type = 'attempt' AND r.request_id = c.request_id
           GROUP BY c.candidate_id
           HAVING COUNT(r.record_id) = 0`,
        )
        .all() as readonly { candidate_id: string }[];
      if (orphaned.length > 0) {
        const orphanPlaceholders = orphaned.map(() => "?").join(", ");
        this.database
          .query(
            `DELETE FROM ledger_candidates WHERE candidate_id IN (${orphanPlaceholders})`,
          )
          .run(...orphaned.map((row) => row.candidate_id));
      }
      return recordIds.size;
    });
    return transaction();
  }

  public async appendAttempt(record: PredictionAttemptRecord): Promise<void> {
    this.assertOpen();
    const validated = parsePredictionLedgerRecord(record) as PredictionAttemptRecord;
    if (this.hasEquivalent(validated)) return;

    // One transaction: an attempt and its candidate rows are a single fact, so a
    // failure on any candidate must not leave the attempt visible without them.
    const insert = this.database.transaction(() => {
      this.insertRecord(validated, validated.requestId, null);
      const insertCandidate = this.database.query(
        `INSERT INTO ledger_candidates (candidate_id, request_id, ordinal) VALUES (?, ?, ?)`,
      );
      for (const envelope of validated.candidates) {
        insertCandidate.run(envelope.candidateId, validated.requestId, envelope.ordinal);
      }
    });

    try {
      insert();
    } catch (error) {
      throw this.translate(error, validated);
    }
  }

  public async appendFeedback(record: PredictionFeedbackRecord): Promise<void> {
    this.assertOpen();
    const validated = parsePredictionLedgerRecord(record) as PredictionFeedbackRecord;
    if (this.hasEquivalent(validated)) return;

    // Checked before insert rather than relying on the foreign key alone: the
    // key proves the candidate exists, not that it belongs to this request, and
    // the two produce different error types.
    const owner = this.database
      .query(`SELECT request_id FROM ledger_candidates WHERE candidate_id = ?`)
      .get(validated.candidateId) as { request_id: string } | null;
    if (owner === null) {
      throw new PredictionLedgerReferenceError(
        `Feedback references unknown candidate ${validated.candidateId}.`,
      );
    }
    if (owner.request_id !== validated.requestId) {
      throw new PredictionLedgerReferenceError(
        `Feedback candidate ${validated.candidateId} does not belong to request ${validated.requestId}.`,
      );
    }

    try {
      this.insertRecord(validated, validated.requestId, validated.candidateId);
    } catch (error) {
      throw this.translate(error, validated);
    }
  }

  public async appendBeliefBatch(record: BeliefBatchRecord): Promise<void> {
    this.assertOpen();
    const validated = parsePredictionLedgerRecord(record) as BeliefBatchRecord;
    if (this.hasEquivalent(validated)) return;
    // `candidate_id` is null: a batch informed a whole prediction rather than one
    // candidate, and there is no attempt row to point at either — a batch is written
    // even when the prediction it served never produced an attempt. The request id
    // is still stored so an operator can join a batch to its prediction by eye, but
    // it is not a foreign key, and the one-attempt-per-request partial index does not
    // apply because that index is scoped to `record_type = 'attempt'`.
    try {
      this.insertRecord(validated, validated.requestId, null);
    } catch (error) {
      throw this.translate(error, validated);
    }
  }

  public async recordPlan(record: ActionPlanRecord): Promise<void> {
    this.assertOpen();
    const validated = parsePredictionLedgerRecord(record) as ActionPlanRecord;
    if (this.hasEquivalent(validated)) return;
    try {
      this.insertRecord(validated, validated.requestId, validated.candidateId);
    } catch (error) {
      throw this.translate(error, validated);
    }
  }

  public async recordDecision(record: PlanDecisionRecord): Promise<void> {
    this.assertOpen();
    const validated = parsePredictionLedgerRecord(record) as PlanDecisionRecord;
    if (this.hasEquivalent(validated)) return;
    try {
      this.insertRecord(validated, "", null);
    } catch (error) {
      throw this.translate(error, validated);
    }
  }

  public async recordStateRejection(
    inputs: ClaimDispatchInputs,
    reasonCode: "state_changed",
  ): Promise<void> {
    this.assertOpen();
    const record = createPlanInvalidationRecord({
      planDigest: inputs.planDigest,
      reasonCode,
    });
    if (this.hasEquivalent(record)) return;
    try {
      this.insertRecord(record, "", null);
    } catch (error) {
      throw this.translate(error, record);
    }
  }

  public async claimDispatch(
    inputs: ClaimDispatchInputs,
    now: string,
    generateClaimToken: () => string,
  ): Promise<DispatchClaimResult> {
    this.assertOpen();
    const claimToken = generateClaimToken();
    // Validation + insert inside one SQLite transaction: concurrent claims on
    // the same candidate serialize at the database, so only one can observe an
    // absent dispatch and win the insert; the loser hits the unique index.
    const transaction = this.database.transaction((): DispatchClaimResult => {
      const records = this.allSync();
      const prepared = PlanDispatchStateMachine.prepareClaim(
        records, inputs, now, claimToken,
      );
      if (!("append" in prepared)) return prepared;
      try {
        this.insertRecord(prepared.append, "", null);
      } catch (error) {
        // The unique record_id index means a racing identical claim landed
        // first — report it as already_claimed rather than a conflict.
        if (isConstraintViolation(error)) return { status: "already_claimed" };
        throw error;
      }
      return { status: "claimed", claimToken };
    });
    return transaction();
  }

  public async completeDispatch(
    inputs: { readonly planDigest: string; readonly claimToken: string },
    outcome: "succeeded" | "failed",
    detailsDigest: string,
    now: string,
  ): Promise<CompleteDispatchResult> {
    this.assertOpen();
    const transaction = this.database.transaction((): CompleteDispatchResult => {
      const records = this.allSync();
      const prepared = PlanDispatchStateMachine.prepareComplete(
        records, inputs, outcome, detailsDigest, now,
      );
      if (!("patch" in prepared)) return prepared;
      const dispatch = records.find((record): record is PlanDispatchRecord =>
        record.recordType === "plan_dispatch" && record.planDigest === inputs.planDigest &&
        record.completedOutcome === undefined);
      if (dispatch === undefined) {
        return { status: "conflict", reasonCode: "no_dispatched_record" };
      }
      this.database
        .query(
          `UPDATE ledger_records SET record_json = ? WHERE record_id = ?`,
        )
        .run(JSON.stringify({ ...dispatch, ...prepared.patch }), dispatch.recordId);
      return { status: "completed" };
    });
    return transaction();
  }

  private allSync(): readonly PredictionLedgerRecord[] {
    const rows = this.database
      .query(`SELECT record_json FROM ledger_records ORDER BY seq`)
      .all() as readonly { record_json: string }[];
    return rows.map((row) => parsePredictionLedgerRecord(JSON.parse(row.record_json)));
  }

  /**
   * Every record in insertion order. `seq` is the ordering key rather than a
   * timestamp: two records can share a timestamp, and append order is the one
   * thing an append-only log can always report faithfully.
   */
  public async all(): Promise<readonly PredictionLedgerRecord[]> {
    this.assertOpen();
    const rows = this.database
      .query(`SELECT record_json FROM ledger_records ORDER BY seq`)
      .all() as readonly { record_json: string }[];
    return rows.map((row) => parsePredictionLedgerRecord(JSON.parse(row.record_json)));
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private insertRecord(
    record: PredictionLedgerRecord,
    requestId: string,
    candidateId: string | null,
  ): void {
    this.database
      .query(
        `INSERT INTO ledger_records (record_id, record_type, request_id, candidate_id, record_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.recordId, record.recordType, requestId, candidateId, JSON.stringify(record));
  }

  /**
   * True when this exact record was already appended. Makes a replayed write
   * idempotent while leaving a same-ID-different-content write a conflict,
   * matching the in-memory and JSONL ledgers.
   */
  private hasEquivalent(record: PredictionLedgerRecord): boolean {
    const row = this.database
      .query(`SELECT record_json FROM ledger_records WHERE record_id = ?`)
      .get(record.recordId) as { record_json: string } | null;
    if (row === null) return false;
    return recordIdentity(parsePredictionLedgerRecord(JSON.parse(row.record_json))) === recordIdentity(record);
  }

  private translate(error: unknown, record: PredictionLedgerRecord): unknown {
    if (!isConstraintViolation(error)) return error;
    // A constraint here can fire on the record_id unique index, the partial
    // one-attempt-per-request index, or the candidate primary key — and SQLite's
    // error code does not distinguish them, so the message matches the in-memory
    // index's record-id branch rather than guessing which invariant was hit.
    return new PredictionLedgerConflictError(
      `Ledger record ${record.recordId} conflicts with an existing record.`,
    );
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("SqlitePredictionLedger is closed.");
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_candidates (
  candidate_id TEXT    NOT NULL PRIMARY KEY,
  request_id   TEXT    NOT NULL,
  ordinal      INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS ledger_records (
  seq          INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  record_id    TEXT    NOT NULL UNIQUE,
  record_type  TEXT    NOT NULL,
  request_id   TEXT    NOT NULL,
  candidate_id TEXT        NULL REFERENCES ledger_candidates (candidate_id),
  record_json  TEXT    NOT NULL
) STRICT;

-- One attempt per request. This is the invariant the in-memory index checks
-- via byRequestId; without it, a second attempt carrying a different recordId
-- would be accepted, diverging from the other two implementations.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_records_one_attempt_per_request
  ON ledger_records (request_id) WHERE record_type = 'attempt';
`;

// Foreign-key violations are not included: feedback ownership is checked before
// insert, so a constraint from `candidate_id REFERENCES` is unreachable. If that
// check were ever bypassed, the FK firing would surface as a ConflictError here
// where a ReferenceError is correct — better to let the raw error escape than to
// silently misclassify it.
const CONSTRAINT_CODES = new Set([
  "SQLITE_CONSTRAINT_PRIMARYKEY",
  "SQLITE_CONSTRAINT_UNIQUE",
]);

function isConstraintViolation(error: unknown): boolean {
  // Branch on `.code`, not `.message`: constraint messages overlap between
  // primary-key and unique-index violations.
  return error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    && CONSTRAINT_CODES.has(error.code);
}

