import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, truncate, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Compile } from "typebox/compile";
import { Type } from "typebox";
import { digestCandidateParameters } from "./action-plan.js";
import { beliefStateBatchSchema, type BeliefStateBatch } from "./belief-state.js";
import type { PredictionOutcome } from "./prediction-provider.js";
import type { PredictionCandidate, PredictionKind } from "./protocol.js";

/**
 * What a feedback record may say.
 *
 * Deliberately limited to how a *prediction* was received. The dispatch
 * lifecycle — dispatched, succeeded, failed — is owned by the plan state
 * machine (`recordPlan` → `recordDecision` → `claimDispatch` →
 * `completeDispatch`) and is not expressible here: a terminal state written
 * through the generic append would skip the claim, and an action that was never
 * claimed must never be able to look like one that completed.
 */
export const feedbackKinds = [
  "accepted",
  "rejected",
  "expired",
] as const;

export type PredictionFeedbackKind = (typeof feedbackKinds)[number];

/**
 * The persisted shape of one predicted candidate.
 *
 * Deliberately not the candidate itself. `parameters` holds a selection, an
 * editor prefix, or a path — user text that must not reach disk merely because
 * a prediction observed it — and `rationale` is model prose that can quote the
 * same text back. What survives here is what an audit needs: which candidate,
 * what kind, how confident, when it expires, and a digest proving which
 * parameters were seen. The raw values live only in the in-process candidate and
 * in the immutable plan built from it.
 */
export interface PredictionCandidateEnvelope {
  readonly candidateId: string;
  readonly ordinal: number;
  readonly kind: PredictionKind;
  readonly confidence: number;
  readonly expiresAt: string;
  readonly sourceEventIds: readonly string[];
  /** sha256 over the candidate's parameters. Proves sameness without the text. */
  readonly parametersDigest: string;
}

/**
 * The v1 envelope, kept only so a ledger written before the audit shape existed
 * still parses. New records never use it.
 */
export interface LegacyPredictionCandidateEnvelope {
  readonly candidateId: string;
  readonly ordinal: number;
  readonly candidate: PredictionCandidate;
}

export interface PredictionAttemptRecord {
  readonly schemaVersion: 2;
  readonly recordId: string;
  readonly recordType: "attempt";
  readonly requestId: string;
  readonly episodeId: string | null;
  readonly triggerEventId: string;
  readonly triggeredAt: string;
  readonly completedAt: string;
  readonly provider: string;
  readonly status: PredictionOutcome["status"];
  readonly latencyMs: number;
  readonly fallbackReason?: string;
  readonly runtimeSessionId: string;
  readonly stateDigest: string;
  readonly projectionGeneration: number;
  readonly triggerDisposition: "accepted" | "late";
  readonly contextPolicyId: string;
  readonly actionTrust: "trusted" | "suggestion_only";
  readonly egressPolicyId: string;
  readonly candidates: readonly PredictionCandidateEnvelope[];
}

export interface LegacyPredictionAttemptRecord {
  readonly schemaVersion: 1;
  readonly recordId: string;
  readonly recordType: "attempt";
  readonly requestId: string;
  readonly episodeId: string | null;
  readonly triggerEventId: string;
  readonly triggeredAt: string;
  readonly completedAt: string;
  readonly provider: string;
  readonly status: PredictionOutcome["status"];
  readonly latencyMs: number;
  readonly fallbackReason?: string;
  readonly candidates: readonly LegacyPredictionCandidateEnvelope[];
}

export interface PredictionFeedbackRecord {
  readonly schemaVersion: 1;
  readonly recordId: string;
  readonly recordType: "feedback";
  readonly feedbackId: string;
  readonly requestId: string;
  readonly candidateId: string;
  readonly feedback: PredictionFeedbackKind;
  readonly occurredAt: string;
  readonly details: Record<string, string | number | boolean | null>;
}

/**
 * A planned action, persisted before any confirmation is requested. Raw
 * parameters never appear here — only their digest — so the ledger stays free
 * of selection text and command payloads while still proving which exact plan
 * was confirmed and claimed.
 */
export interface ActionPlanRecord {
  readonly schemaVersion: 2;
  readonly recordId: string;
  readonly recordType: "plan";
  readonly attemptId: string;
  readonly requestId: string;
  readonly candidateId: string;
  /** sha256 over the canonical immutable ActionPlan. */
  readonly planDigest: string;
  /** sha256 over the sanitized candidate parameters. */
  readonly candidateParametersDigest: string;
  readonly confirmation: "none" | "required";
  readonly egressPolicyId: string;
  readonly createdAt: string;
}

/** Lifecycle of a plan record. Terminal states can never be revisited. */
export type ActionPlanStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "expired"
  | "dispatched"
  | "succeeded"
  | "failed";

export type ActionPlanDecision = "accepted" | "rejected" | "expired";

export type DispatchClaimResult =
  | { readonly status: "claimed"; readonly claimToken: string }
  | { readonly status: "already_claimed"; readonly claimToken?: undefined }
  | { readonly status: "rejected"; readonly reasonCode: ClaimRejectionReasonCode }
  | { readonly status: "expired" }
  | { readonly status: "terminal" };

export type CompleteDispatchResult =
  | { readonly status: "completed" }
  | { readonly status: "conflict"; readonly reasonCode: CompleteDispatchConflictReasonCode };

export type ClaimRejectionReasonCode =
  | "unknown_plan"
  | "attempt_mismatch"
  | "metadata_mismatch"
  | "not_accepted"
  | "state_changed";

export type CompleteDispatchConflictReasonCode =
  | "no_dispatched_record"
  | "token_mismatch"
  | "outcome_conflict";

/**
 * The user's confirmation decision. Idempotent when repeated identically; a
 * contradictory decision or different details digest is a conflict.
 */
export interface PlanDecisionRecord {
  readonly schemaVersion: 2;
  readonly recordId: string;
  readonly recordType: "plan_decision";
  readonly planDigest: string;
  readonly decision: ActionPlanDecision;
  /** Digest over sanitized decision details, not the raw text. */
  readonly detailsDigest: string;
  readonly decidedAt: string;
}

/**
 * A dispatch that reached the gateway. Created atomically by `claimDispatch`;
 * only its matching `claimToken` may complete it.
 */
export interface PlanDispatchRecord {
  readonly schemaVersion: 2;
  readonly recordId: string;
  readonly recordType: "plan_dispatch";
  /** Deterministic idempotency key — not a secret. */
  readonly claimId: string;
  readonly planDigest: string;
  /** Opaque random token; stored hashed. */
  readonly claimTokenHash: string;
  readonly egressPolicyId: string;
  readonly claimedAt: string;
  /**
   * Absent until a structured tool outcome is confirmed. An open dispatched
   * record — claimed, never completed — *is* the reconciliation signal: a
   * transport timeout, a disconnect, or a crash all leave exactly this shape,
   * and a crash could never have written a marker anyway. Nothing fabricates a
   * terminal outcome to close it.
   */
  readonly completedOutcome?: "succeeded" | "failed";
  readonly completedDetailsDigest?: string;
  readonly completedAt?: string;
}

/**
 * A system-side invalidation of an already-accepted plan.
 *
 * Kept distinct from `PlanDecisionRecord` on purpose: the user accepted this
 * plan, and the world then changed underneath it. Writing that as a second
 * "user decision" would put words in their mouth and make the audit trail claim
 * a rejection that never happened. This record says what actually occurred — the
 * system withdrew the plan — and it is the only legal way out of `accepted`
 * other than a claim.
 */
export interface PlanInvalidationRecord {
  readonly schemaVersion: 2;
  readonly recordId: string;
  readonly recordType: "plan_invalidation";
  readonly planDigest: string;
  readonly reasonCode: "state_changed";
  readonly invalidatedAt: string;
}

/**
 * One validated belief batch, kept as history.
 *
 * History, not evidence — and that answers the contradiction the belief contract
 * carried. `BELIEF_LIMITS.maxTtlMs` permits a 24-hour shelf life while
 * `validateBatchAgainstRequest` demands exact agreement on the state digest and
 * projection generation, which move on every ingest. Read as one rule the two are
 * irreconcilable. They are two rules about different questions: `expiresAt` is the
 * *producer's* claim about how long its inference should be believed, which exists
 * to bound an untrusted producer, and the digest equality decides whether a batch
 * may inform *this* prediction. Nothing ever reads a stored batch back as ranking
 * input, so the second question is never asked of a persisted record and the TTL
 * ceiling is a bound on a claim rather than a promise about reuse.
 *
 * That restriction is not storage timidity. `runSemanticGate` admits a cognition
 * provider by replaying a corpus and requiring the identical top-1 answer every
 * time, which holds only while a prediction is a pure function of the state it was
 * given. A belief read back from the ledger would make the answer depend on what
 * previous runs happened to write, so the gate would be measuring a provider that
 * cannot exist in production. What accumulates across a session is therefore the
 * record — `bun run ledger:report` and the ledger itself — rather than the ranking.
 *
 * The batch is embedded whole rather than flattened into columns. It is already an
 * audit shape by contract: a closed intent vocabulary, bounded strings, a digest,
 * timestamps, and event ids — no command, no prose, no parameters. Copying fields
 * out would create a second spelling of the belief contract to keep in agreement,
 * which is the drift `recordEventReferences` exists to prevent.
 */
export interface BeliefBatchRecord {
  readonly schemaVersion: 1;
  readonly recordId: string;
  readonly recordType: "belief_batch";
  /**
   * The prediction request the beliefs were produced for. Not a foreign key: a
   * batch is written whether or not the prediction that asked for it ends up with
   * an attempt record, so closure follows the cited events instead.
   */
  readonly requestId: string;
  readonly provider: string;
  readonly observedAt: string;
  /** The batch exactly as validation accepted it. */
  readonly batch: BeliefStateBatch;
}

export type PredictionLedgerRecord =
  | PredictionAttemptRecord
  | LegacyPredictionAttemptRecord
  | PredictionFeedbackRecord
  | BeliefBatchRecord
  | ActionPlanRecord
  | PlanDecisionRecord
  | PlanDispatchRecord
  | PlanInvalidationRecord;

/** Inputs every dispatch-mutating narrow API call must present together. */
export interface ClaimDispatchInputs {
  readonly attemptId: string;
  readonly candidateId: string;
  readonly runtimeSessionId: string;
  readonly projectionGeneration: number;
  readonly stateDigest: string;
  readonly episodeId: string | null;
  readonly triggerDisposition: "accepted";
  readonly contextPolicyId: string;
  readonly actionTrust: "trusted" | "suggestion_only";
  readonly egressPolicyId: string;
  readonly planDigest: string;
}

export interface PredictionLedger {
  appendAttempt(record: PredictionAttemptRecord): Promise<void>;
  appendFeedback(record: PredictionFeedbackRecord): Promise<void>;
  /**
   * Persists one validated belief batch as history.
   *
   * Deliberately independent of `appendAttempt`: a batch is produced before the
   * prediction it informs has an outcome, and the prediction may fail or be
   * cancelled. Requiring an attempt first would mean losing exactly the batches a
   * failed run most needs explained. Nothing reads these back into a prediction —
   * see `BeliefBatchRecord` for why that restriction is load-bearing.
   */
  appendBeliefBatch(record: BeliefBatchRecord): Promise<void>;
  all(): Promise<readonly PredictionLedgerRecord[]>;

  /**
   * Deletes every record whose provenance names a removed trigger event, so
   * retention deletion cannot leave an attempt pointing at history that no
   * longer exists.
   *
   * The input is the set of removed event ids — what the event store just
   * deleted, not record ids the caller would have to resolve. The ledger walks
   * the reference graph itself and removes the whole dependent closure: an
   * attempt triggered by a removed event takes its candidates with it, and any
   * feedback or plan naming one of those candidates goes too. A plan whose only
   * link was through its attempt is likewise removed; dispatches, decisions,
   * and invalidations follow their plan digest.
   *
   * What remains after the call is provably self-contained: no surviving record
   * references anything that no longer exists. Returns the number of records
   * removed.
   */
  deleteRecordsRemovedWithEvents(removedEventIds: ReadonlySet<string>): Promise<number>;

  /**
   * Persists a plan before confirmation. Identical records are idempotent;
   * a different digest for the same candidate conflicts.
   */
  recordPlan(record: ActionPlanRecord): Promise<void>;
  /**
   * Records the user's decision on a plan. Same decision + details digest is
   * idempotent; opposite decisions or differing details conflict. System-side
   * invalidation after acceptance goes through `recordStateRejection`, never
   * this method.
   */
  recordDecision(record: PlanDecisionRecord): Promise<void>;
  /**
   * The single legal accepted → rejected(state_changed) transition. Internal
   * to the runtime serial queue; shares the atomic boundary with
   * `claimDispatch` because both invalidate against the same state snapshot.
   */
  recordStateRejection(inputs: ClaimDispatchInputs, reasonCode: "state_changed"): Promise<void>;
  /**
   * Atomic linearization point: validates every input against the persisted
   * attempt and plan inside one operation, then appends the dispatched
   * record. Only `claimed` authorizes an MCP invocation.
   */
  claimDispatch(
    inputs: ClaimDispatchInputs,
    now: string,
    generateClaimToken: () => string,
  ): Promise<DispatchClaimResult>;
  /**
   * Completes a claimed dispatch with the opaque token returned at claim
   * time. Only structured, confirmed tool failures may complete as `failed`.
   */
  completeDispatch(
    inputs: { readonly planDigest: string; readonly claimToken: string },
    outcome: "succeeded" | "failed",
    detailsDigest: string,
    now: string,
  ): Promise<CompleteDispatchResult>;
}

/**
 * Every event id a record depends on for its meaning.
 *
 * The one place that answers "which events does this record cite". Both halves of
 * retention deletion read it — the resolver that derives which events history lost,
 * and the closure below that decides which records go with them — so a new
 * event-referencing field becomes covered by adding it here once, rather than in
 * two traversals that must be kept in agreement by hand.
 *
 * They were not in agreement. Both halves matched attempts on `triggerEventId`
 * alone, while a candidate envelope also carries `sourceEventIds` — the events the
 * prediction actually read. Deleting one of those while its trigger survived left
 * the attempt in place citing an event that no longer existed, which is exactly the
 * dangling reference this closure exists to make impossible.
 *
 * Only records that name events appear here. A plan, decision, dispatch, or
 * invalidation reaches history through its attempt and candidate, never directly.
 * A belief batch does name events, and directly: it cites `evidenceEventIds`, which
 * is the whole basis on which a belief can be audited, so a stored batch whose
 * evidence was deleted is precisely the dangling reference above.
 */
export function recordEventReferences(record: PredictionLedgerRecord): ReadonlySet<string> {
  if (record.recordType === "belief_batch") {
    const references = new Set<string>();
    for (const belief of record.batch.beliefs) {
      for (const eventId of belief.evidenceEventIds) references.add(eventId);
    }
    return references;
  }
  if (record.recordType !== "attempt") return EMPTY_EVENT_REFERENCES;

  const references = new Set<string>([record.triggerEventId]);
  for (const envelope of record.candidates) {
    // v2 envelopes carry `sourceEventIds` directly; a legacy v1 envelope carries
    // the whole candidate, which holds the same field. Both spellings are covered
    // so pre-audit history deletes by the same rule as current records.
    const sourceEventIds = "candidate" in envelope
      ? envelope.candidate.sourceEventIds
      : envelope.sourceEventIds;
    for (const eventId of sourceEventIds) references.add(eventId);
  }
  return references;
}

const EMPTY_EVENT_REFERENCES: ReadonlySet<string> = new Set<string>();

/** True when any event this record cites is among those removed. */
function citesRemovedEvent(
  record: PredictionLedgerRecord,
  removedEventIds: ReadonlySet<string>,
): boolean {
  for (const eventId of recordEventReferences(record)) {
    if (removedEventIds.has(eventId)) return true;
  }
  return false;
}

/**
 * Resolves the records a retention deletion must take with it.
 *
 * Shared by all three backends on purpose: "which records reference a removed
 * event" is contract, not implementation, and three independent traversals
 * would eventually disagree — the same drift the claim state machine exists to
 * prevent.
 *
 * The walk runs to a fixed point because references chain: removing an attempt
 * orphans its candidate ids, orphaned candidate ids orphan their feedback and
 * plans (a plan names both `attemptId` and `candidateId`), and an orphaned
 * plan orphans its decisions, dispatches, and invalidations by digest. A single
 * pass would leave the tail of that chain dangling.
 *
 * Which events a record cites is answered by `recordEventReferences` rather than
 * spelled out inline, so this traversal and the caller that derives *which events
 * were removed* read one field list. Two independent spellings of "the events a
 * record depends on" is how the `sourceEventIds` half of this closure stayed
 * missing.
 */
export function resolveRecordsRemovedWithEvents(
  records: readonly PredictionLedgerRecord[],
  removedEventIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const removed = new Set<string>();

  let grew = true;
  while (grew) {
    grew = false;

    // Candidate ids that will survive: every attempt not itself being removed
    // still declares its candidates, and feedback/plans may only be deleted
    // when no survivor owns their id.
    const survivingCandidates = new Set<string>();
    for (const record of records) {
      if (
        record.recordType === "attempt" && !removed.has(record.recordId)
        && !citesRemovedEvent(record, removedEventIds)
      ) {
        for (const envelope of record.candidates) survivingCandidates.add(envelope.candidateId);
      }
    }

    for (const record of records) {
      if (removed.has(record.recordId)) continue;
      if (!isRemovedWithEvents(record, records, removedEventIds, removed, survivingCandidates)) continue;
      removed.add(record.recordId);
      grew = true;
    }
  }
  return removed;
}

function isRemovedWithEvents(
  record: PredictionLedgerRecord,
  records: readonly PredictionLedgerRecord[],
  removedEventIds: ReadonlySet<string>,
  removed: ReadonlySet<string>,
  survivingCandidates: ReadonlySet<string>,
): boolean {
  switch (record.recordType) {
    case "attempt":
      return citesRemovedEvent(record, removedEventIds);
    case "belief_batch":
      // Same rule as an attempt, and for the same reason: a batch whose evidence
      // was deleted is a claim about a world nothing can vouch for any more. It
      // does not follow its request's attempt — a batch is written even when no
      // attempt record exists — so its own citations are the whole anchor.
      return citesRemovedEvent(record, removedEventIds);
    case "feedback":
      // The candidate's owner attempt was removed; the feedback has nothing
      // left to describe and stays only as a dangling id.
      return !survivingCandidates.has(record.candidateId);
    case "plan":
      return removed.has(record.attemptId) || !survivingCandidates.has(record.candidateId);
    case "plan_decision":
    case "plan_dispatch":
    case "plan_invalidation": {
      // These follow their plan: once every plan carrying this digest is being
      // removed, the digest has no living subject.
      const planSurvives = records.some((other) =>
        other.recordType === "plan"
        && other.planDigest === record.planDigest
        && !removed.has(other.recordId));
      return !planSurvives;
    }
    default:
      return false;
  }
}

export interface PredictionFeedbackInput {
  readonly feedbackId: string;
  readonly requestId: string;
  readonly candidateId: string;
  readonly feedback: PredictionFeedbackKind;
  readonly occurredAt?: string;
  readonly details?: Record<string, string | number | boolean | null>;
}

const scalar = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const predictionKindSchema = Type.Union([
  Type.Literal("draft_completion"),
  Type.Literal("run_tests"),
  Type.Literal("inspect_error"),
  Type.Literal("search_selection"),
  Type.Literal("none"),
]);
// The registered capability a proposal named, or null when it named none.
// Open-ended by design: the catalog is data, so a tool id is a string here and
// the ledger records what was proposed even after the tool is gone. Null is a
// fact (nothing proposed), not missing data — hence required, not optional.
const toolIdSchema = Type.Union([nonEmptyString(), Type.Null()]);
const candidateSchema = Type.Object({
  kind: predictionKindSchema,
  toolId: toolIdSchema,
  rationale: Type.String(),
  confidence: Type.Number(),
  expiresAt: Type.String({ minLength: 1 }),
  sourceEventIds: Type.Array(Type.String()),
  parameters: Type.Record(Type.String(), scalar),
}, { additionalProperties: false });
// The v2 envelope carries no free text: `rationale` is model prose and
// `parameters` is user text, so only the digest of the latter survives.
const envelopeSchema = Type.Object({
  candidateId: nonEmptyString(),
  ordinal: Type.Integer({ minimum: 0 }),
  kind: predictionKindSchema,
  toolId: toolIdSchema,
  confidence: Type.Number(),
  expiresAt: timestamp(),
  sourceEventIds: Type.Array(Type.String()),
  parametersDigest: Type.String({ pattern: /^sha256:[0-9a-f]{64}$/u.source }),
}, { additionalProperties: false });
const legacyEnvelopeSchema = Type.Object({
  candidateId: nonEmptyString(),
  ordinal: Type.Integer({ minimum: 0 }),
  candidate: candidateSchema,
}, { additionalProperties: false });
const attemptSchema = Type.Object({
  schemaVersion: Type.Literal(2),
  recordId: nonEmptyString(),
  recordType: Type.Literal("attempt"),
  requestId: nonEmptyString(),
  episodeId: Type.Union([Type.String(), Type.Null()]),
  triggerEventId: nonEmptyString(),
  triggeredAt: timestamp(),
  completedAt: timestamp(),
  provider: nonEmptyString(),
  status: Type.Union([
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("timeout"),
    Type.Literal("cancelled"),
    Type.Literal("stale"),
  ]),
  latencyMs: Type.Number({ minimum: 0 }),
  fallbackReason: Type.Optional(Type.String()),
  runtimeSessionId: nonEmptyString(),
  stateDigest: Type.String({ pattern: /^sha256:[0-9a-f]{64}$/u.source }),
  projectionGeneration: Type.Integer({ minimum: 0 }),
  triggerDisposition: Type.Union([Type.Literal("accepted"), Type.Literal("late")]),
  contextPolicyId: nonEmptyString(),
  actionTrust: Type.Union([Type.Literal("trusted"), Type.Literal("suggestion_only")]),
  egressPolicyId: nonEmptyString(),
  candidates: Type.Array(envelopeSchema),
}, { additionalProperties: false });
const legacyAttemptSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  recordId: nonEmptyString(), recordType: Type.Literal("attempt"), requestId: nonEmptyString(),
  episodeId: Type.Union([Type.String(), Type.Null()]), triggerEventId: nonEmptyString(),
  triggeredAt: timestamp(), completedAt: timestamp(), provider: nonEmptyString(),
  status: Type.Union([
    Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("timeout"),
    Type.Literal("cancelled"), Type.Literal("stale"),
  ]), latencyMs: Type.Number({ minimum: 0 }), fallbackReason: Type.Optional(Type.String()),
  candidates: Type.Array(legacyEnvelopeSchema),
}, { additionalProperties: false });
const feedbackSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  recordId: nonEmptyString(),
  recordType: Type.Literal("feedback"),
  feedbackId: nonEmptyString(),
  requestId: nonEmptyString(),
  candidateId: nonEmptyString(),
  feedback: Type.Union(feedbackKinds.map((kind) => Type.Literal(kind))),
  occurredAt: timestamp(),
  details: Type.Record(Type.String(), scalar),
}, { additionalProperties: false });
// The belief batch is validated by the belief contract's own schema, reused here
// rather than restated. A second spelling would drift: a field added to the
// contract would be silently dropped by this closed union, and the ledger would
// reject exactly the batches the live path had just accepted.
const beliefBatchSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  recordId: nonEmptyString(),
  recordType: Type.Literal("belief_batch"),
  requestId: nonEmptyString(),
  provider: nonEmptyString(),
  observedAt: timestamp(),
  batch: beliefStateBatchSchema,
}, { additionalProperties: false });
const sha256Pattern = /^sha256:[0-9a-f]{64}$/u.source;
const actionPlanSchema = Type.Object({
  schemaVersion: Type.Literal(2),
  recordId: nonEmptyString(),
  recordType: Type.Literal("plan"),
  attemptId: nonEmptyString(),
  requestId: nonEmptyString(),
  candidateId: nonEmptyString(),
  planDigest: Type.String({ pattern: sha256Pattern }),
  candidateParametersDigest: Type.String({ pattern: sha256Pattern }),
  confirmation: Type.Union([Type.Literal("none"), Type.Literal("required")]),
  egressPolicyId: nonEmptyString(),
  createdAt: timestamp(),
}, { additionalProperties: false });
const planDecisionSchema = Type.Object({
  schemaVersion: Type.Literal(2),
  recordId: nonEmptyString(),
  recordType: Type.Literal("plan_decision"),
  planDigest: Type.String({ pattern: sha256Pattern }),
  decision: Type.Union([
    Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("expired"),
  ]),
  detailsDigest: Type.String({ pattern: /^(sha256|hmac):[0-9a-f]{64}$/u }),
  decidedAt: timestamp(),
}, { additionalProperties: false });
const planInvalidationSchema = Type.Object({
  schemaVersion: Type.Literal(2),
  recordId: nonEmptyString(),
  recordType: Type.Literal("plan_invalidation"),
  planDigest: Type.String({ pattern: sha256Pattern }),
  reasonCode: Type.Literal("state_changed"),
  invalidatedAt: timestamp(),
}, { additionalProperties: false });
const completedDispatchFields = {
  completedOutcome: Type.Optional(Type.Union([Type.Literal("succeeded"), Type.Literal("failed")])),
  completedDetailsDigest: Type.Optional(Type.String({ pattern: /^(sha256|hmac):[0-9a-f]{64}$/u })),
  completedAt: Type.Optional(timestamp()),
} as const;
const planDispatchSchema = Type.Object({
  schemaVersion: Type.Literal(2),
  recordId: nonEmptyString(),
  recordType: Type.Literal("plan_dispatch"),
  claimId: nonEmptyString(),
  planDigest: Type.String({ pattern: sha256Pattern }),
  claimTokenHash: nonEmptyString(),
  egressPolicyId: nonEmptyString(),
  claimedAt: timestamp(),
  ...completedDispatchFields,
}, { additionalProperties: false });
const recordValidator = Compile(Type.Union([
  attemptSchema,
  legacyAttemptSchema,
  feedbackSchema,
  beliefBatchSchema,
  actionPlanSchema,
  planDecisionSchema,
  planDispatchSchema,
  planInvalidationSchema,
]));

export class PredictionLedgerConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PredictionLedgerConflictError";
  }
}

export class PredictionLedgerReferenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PredictionLedgerReferenceError";
  }
}

export interface PredictionLedgerDiagnostic {
  readonly kind: "truncated_final_record";
  readonly line: number;
}

export function candidateEnvelopes(
  requestId: string,
  candidates: readonly PredictionCandidate[],
): readonly PredictionCandidateEnvelope[] {
  if (requestId.length === 0) throw new TypeError("Prediction request ID must not be empty.");
  // The candidate's own text stops here. What crosses into the ledger is the
  // audit shape: identity, kind, confidence, expiry, provenance, and a digest
  // standing in for the parameters. `rationale` is dropped outright — model
  // prose can quote the selection it was reasoning about.
  return candidates.map((candidate, ordinal) => ({
    candidateId: `${requestId}:candidate:${ordinal}`,
    ordinal,
    kind: candidate.kind,
    toolId: candidate.toolId,
    confidence: candidate.confidence,
    expiresAt: candidate.expiresAt,
    sourceEventIds: [...candidate.sourceEventIds],
    parametersDigest: digestCandidateParameters(candidate.parameters),
  }));
}

// Schema v2 metadata is required, not defaulted: a record whose digest,
// generation, or policy identity was silently fabricated would look auditable
// while describing a state that never existed.
export interface AttemptRecordMetadataInput {
  readonly runtimeSessionId: string;
  readonly stateDigest: string;
  readonly projectionGeneration: number;
  readonly triggerDisposition: "accepted" | "late";
  readonly contextPolicyId: string;
  readonly actionTrust: "trusted" | "suggestion_only";
  readonly egressPolicyId: string;
}

export function createAttemptRecord(input: {
  readonly triggerEventId: string;
  readonly episodeId: string | null;
  readonly triggeredAt: string;
  readonly completedAt: string;
  readonly outcome: PredictionOutcome;
  readonly candidates: readonly PredictionCandidateEnvelope[];
} & AttemptRecordMetadataInput): PredictionAttemptRecord {
  return parsePredictionLedgerRecord({
    schemaVersion: 2,
    recordId: `attempt:${input.outcome.requestId}`,
    recordType: "attempt",
    requestId: input.outcome.requestId,
    episodeId: input.episodeId,
    triggerEventId: input.triggerEventId,
    triggeredAt: input.triggeredAt,
    completedAt: input.completedAt,
    provider: input.outcome.provider,
    status: input.outcome.status,
    latencyMs: input.outcome.latencyMs,
    ...(input.outcome.fallbackReason !== undefined ? { fallbackReason: input.outcome.fallbackReason } : {}),
    runtimeSessionId: input.runtimeSessionId,
    stateDigest: input.stateDigest,
    projectionGeneration: input.projectionGeneration,
    triggerDisposition: input.triggerDisposition,
    contextPolicyId: input.contextPolicyId,
    actionTrust: input.actionTrust,
    egressPolicyId: input.egressPolicyId,
    candidates: input.candidates,
  }) as PredictionAttemptRecord;
}

export function createFeedbackRecord(
  input: PredictionFeedbackInput,
  now = new Date(),
): PredictionFeedbackRecord {
  return parsePredictionLedgerRecord({
    schemaVersion: 1,
    recordId: `feedback:${input.feedbackId}`,
    recordType: "feedback",
    feedbackId: input.feedbackId,
    requestId: input.requestId,
    candidateId: input.candidateId,
    feedback: input.feedback,
    occurredAt: input.occurredAt ?? now.toISOString(),
    details: structuredClone(input.details ?? {}),
  }) as PredictionFeedbackRecord;
}

/**
 * Wraps a validated batch as a ledger record.
 *
 * `beliefBatchId` supplies the identity rather than the request id: a request asks
 * for beliefs once, but the id a producer stamps on its batch is the thing an
 * operator correlates against provider-side logs, and reusing it here makes a
 * replayed write idempotent on the fact rather than on the occasion. The batch must
 * already have passed `validateBatchAgainstRequest` — this function re-validates its
 * shape but cannot re-check it against a projection, since the projection it
 * described is by then two generations gone.
 */
export function createBeliefBatchRecord(input: {
  readonly requestId: string;
  readonly batch: BeliefStateBatch;
  readonly observedAt?: string;
}, now = new Date()): BeliefBatchRecord {
  return parsePredictionLedgerRecord({
    schemaVersion: 1,
    recordId: `belief_batch:${input.batch.beliefBatchId}`,
    recordType: "belief_batch",
    requestId: input.requestId,
    // Denormalized from the batch so a report can group by producer without
    // reaching inside it, the same way an attempt record surfaces its provider.
    provider: input.batch.provider,
    observedAt: input.observedAt ?? now.toISOString(),
    batch: input.batch,
  }) as BeliefBatchRecord;
}

export function parsePredictionLedgerRecord(value: unknown): PredictionLedgerRecord {
  if (!recordValidator.Check(value)) {
    // The one shape this message names is the one that actually occurs in the
    // wild: an attempt written before candidates carried `toolId`. Every other
    // rejection is corruption or a bug, and stays generic. Naming the upgrade
    // beats a bare "failed validation" — the operator's next question is
    // always "which record, and what changed".
    const looksLikePreToolIdAttempt = typeof value === "object" && value !== null
      && (value as Record<string, unknown>).schemaVersion === 2
      && (value as Record<string, unknown>).recordType === "attempt"
      && Array.isArray((value as Record<string, unknown>).candidates)
      && ((value as Record<string, unknown>).candidates as readonly unknown[])
        .some((candidate) => typeof candidate === "object" && candidate !== null
          && !("toolId" in candidate));
    if (looksLikePreToolIdAttempt) {
      throw new TypeError(
        "Prediction ledger record failed protocol validation: this ledger holds attempts from before candidates carried toolId (the open tool catalog). Old records are not readable by this build; delete the ledger file or re-run the previous version.",
      );
    }
    throw new TypeError("Prediction ledger record failed protocol validation.");
  }
  const record = recordValidator.Parse(value) as PredictionLedgerRecord;
  if (record.recordType === "attempt") {
    for (const envelope of record.candidates) {
      if (envelope.candidateId !== `${record.requestId}:candidate:${envelope.ordinal}`) {
        throw new TypeError("Prediction candidate ID does not match its request and ordinal.");
      }
    }
  }
  return structuredClone(record);
}

/**
 * The pure dispatch state machine shared by all three ledger backends. It
 * reads a snapshot of the records and answers every narrow-API question —
 * validation, transitions, idempotency — so the backends differ only in how
 * they make the resulting append atomic, never in the semantics themselves.
 */
export class PlanDispatchStateMachine {
  /** Deterministic claim idempotency key. Not a secret. */
  public static claimId(
    attemptId: string,
    candidateId: string,
    runtimeSessionId: string,
    planDigest: string,
  ): string {
    return `claim:${createHash("sha256")
      .update(`claim-v1|${attemptId}|${candidateId}|${runtimeSessionId}|${planDigest}`)
      .digest("hex")}`;
  }

  public static hashClaimToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  /**
   * Validates claim inputs against the snapshot and returns either the
   * dispatched record to append or a non-claimed result.
   */
  public static prepareClaim(
    records: readonly PredictionLedgerRecord[],
    inputs: ClaimDispatchInputs,
    now: string,
    claimToken: string,
  ): { readonly append: PlanDispatchRecord } | DispatchClaimResult {
    const attempt = records.find((record) =>
      record.recordType === "attempt" && record.requestId === inputs.attemptId);
    if (attempt === undefined || attempt.recordType !== "attempt" || attempt.schemaVersion !== 2) {
      return { status: "rejected", reasonCode: "attempt_mismatch" };
    }
    if (
      attempt.runtimeSessionId !== inputs.runtimeSessionId ||
      attempt.projectionGeneration !== inputs.projectionGeneration ||
      attempt.stateDigest !== inputs.stateDigest ||
      attempt.episodeId !== inputs.episodeId ||
      attempt.triggerDisposition !== "accepted" ||
      inputs.triggerDisposition !== "accepted" ||
      attempt.contextPolicyId !== inputs.contextPolicyId ||
      attempt.actionTrust !== inputs.actionTrust ||
      attempt.actionTrust !== "trusted" ||
      attempt.egressPolicyId !== inputs.egressPolicyId
    ) {
      return { status: "rejected", reasonCode: "metadata_mismatch" };
    }
    const envelope = attempt.candidates.find((item) => item.candidateId === inputs.candidateId);
    if (envelope === undefined) {
      return { status: "rejected", reasonCode: "unknown_plan" };
    }
    const plan = records.find((record) =>
      record.recordType === "plan" && record.planDigest === inputs.planDigest &&
      record.candidateId === inputs.candidateId && record.attemptId === inputs.attemptId);
    if (plan === undefined || plan.recordType !== "plan") {
      return { status: "rejected", reasonCode: "unknown_plan" };
    }
    // A system invalidation is terminal: the user accepted this plan, the world
    // then changed, and the plan was withdrawn. Nothing revives it.
    const invalidated = records.some((record) =>
      record.recordType === "plan_invalidation" && record.planDigest === inputs.planDigest);
    if (invalidated) {
      return { status: "rejected", reasonCode: "state_changed" };
    }
    const decision = this.latestDecision(records, inputs.planDigest);
    const dispatch = records.find((record) =>
      record.recordType === "plan_dispatch" && record.claimId === this.claimId(
        inputs.attemptId, inputs.candidateId, inputs.runtimeSessionId, inputs.planDigest));
    if (dispatch?.recordType === "plan_dispatch") {
      return dispatch.completedOutcome === undefined
        ? { status: "already_claimed" }
        : { status: "terminal" };
    }
    if (decision === null) {
      // Plans requiring confirmation must be accepted; confirmation-free plans
      // may dispatch straight from proposed.
      if (plan.confirmation === "required") {
        return Date.parse(envelope.expiresAt) <= Date.parse(now)
          ? { status: "expired" }
          : { status: "rejected", reasonCode: "not_accepted" };
      }
    } else if (decision.decision === "accepted") {
      if (Date.parse(envelope.expiresAt) <= Date.parse(now)) {
        return { status: "expired" };
      }
    } else {
      return {
        status: "rejected",
        reasonCode: decision.decision === "expired" ? "not_accepted" : "state_changed",
      };
    }
    return {
      append: {
        schemaVersion: 2,
        recordId: `plan_dispatch:${this.claimId(inputs.attemptId, inputs.candidateId, inputs.runtimeSessionId, inputs.planDigest)}`,
        recordType: "plan_dispatch",
        claimId: this.claimId(inputs.attemptId, inputs.candidateId, inputs.runtimeSessionId, inputs.planDigest),
        planDigest: inputs.planDigest,
        claimTokenHash: this.hashClaimToken(claimToken),
        egressPolicyId: inputs.egressPolicyId,
        claimedAt: now,
      },
    };
  }

  public static latestDecision(
    records: readonly PredictionLedgerRecord[],
    planDigest: string,
  ): PlanDecisionRecord | null {
    let latest: PlanDecisionRecord | null = null;
    for (const record of records) {
      if (record.recordType === "plan_decision" && record.planDigest === planDigest) {
        if (latest === null || record.decidedAt >= latest.decidedAt) {
          latest = record;
        }
      }
    }
    return latest;
  }

  /**
   * Validates completion against the claimed record. Only the exact token
   * hash and no prior terminal state allow the transition.
   */
  public static prepareComplete(
    records: readonly PredictionLedgerRecord[],
    inputs: { readonly planDigest: string; readonly claimToken: string },
    outcome: "succeeded" | "failed",
    detailsDigest: string,
    now: string,
  ): { readonly patch: Pick<PlanDispatchRecord,
    "completedOutcome" | "completedDetailsDigest" | "completedAt"
  > } | CompleteDispatchResult {
    const dispatch = records.find((record) =>
      record.recordType === "plan_dispatch" && record.planDigest === inputs.planDigest);
    if (dispatch === undefined || dispatch.recordType !== "plan_dispatch") {
      return { status: "conflict", reasonCode: "no_dispatched_record" };
    }
    if (dispatch.claimTokenHash !== this.hashClaimToken(inputs.claimToken)) {
      return { status: "conflict", reasonCode: "token_mismatch" };
    }
    if (dispatch.completedOutcome !== undefined) {
      return dispatch.completedOutcome === outcome &&
        dispatch.completedDetailsDigest === detailsDigest
        ? { status: "completed" }
        : { status: "conflict", reasonCode: "outcome_conflict" };
    }
    return {
      patch: {
        completedOutcome: outcome,
        completedDetailsDigest: detailsDigest,
        completedAt: now,
      },
    };
  }
}

export function createActionPlanRecord(input: {
  readonly attemptId: string;
  readonly requestId: string;
  readonly candidateId: string;
  readonly planDigest: string;
  readonly candidateParametersDigest: string;
  readonly confirmation: "none" | "required";
  readonly egressPolicyId: string;
  readonly createdAt?: string;
}): ActionPlanRecord {
  return parsePredictionLedgerRecord({
    schemaVersion: 2,
    recordId: `plan:${input.candidateId}:${input.planDigest}`,
    recordType: "plan",
    attemptId: input.attemptId,
    requestId: input.requestId,
    candidateId: input.candidateId,
    planDigest: input.planDigest,
    candidateParametersDigest: input.candidateParametersDigest,
    confirmation: input.confirmation,
    egressPolicyId: input.egressPolicyId,
    createdAt: input.createdAt ?? new Date().toISOString(),
  }) as ActionPlanRecord;
}

export function createPlanDecisionRecord(input: {
  readonly planDigest: string;
  readonly decision: ActionPlanDecision;
  readonly detailsDigest: string;
  readonly decidedAt?: string;
}): PlanDecisionRecord {
  return parsePredictionLedgerRecord({
    schemaVersion: 2,
    recordId: `plan_decision:${input.planDigest}:${input.decision}`,
    recordType: "plan_decision",
    planDigest: input.planDigest,
    decision: input.decision,
    detailsDigest: input.detailsDigest,
    decidedAt: input.decidedAt ?? new Date().toISOString(),
  }) as PlanDecisionRecord;
}

export function createPlanInvalidationRecord(input: {
  readonly planDigest: string;
  readonly reasonCode: "state_changed";
  readonly invalidatedAt?: string;
}): PlanInvalidationRecord {
  return parsePredictionLedgerRecord({
    schemaVersion: 2,
    recordId: `plan_invalidation:${input.planDigest}:${input.reasonCode}`,
    recordType: "plan_invalidation",
    planDigest: input.planDigest,
    reasonCode: input.reasonCode,
    invalidatedAt: input.invalidatedAt ?? new Date().toISOString(),
  }) as PlanInvalidationRecord;
}

export class InMemoryPredictionLedger implements PredictionLedger {
  private readonly index = new LedgerIndex();

  public async deleteRecordsRemovedWithEvents(
    removedEventIds: ReadonlySet<string>,
  ): Promise<number> {
    const recordIds = resolveRecordsRemovedWithEvents(this.index.all(), removedEventIds);
    this.index.remove(recordIds);
    return recordIds.size;
  }

  public async appendAttempt(record: PredictionAttemptRecord): Promise<void> {
    this.append(parsePredictionLedgerRecord(record));
  }

  public async appendFeedback(record: PredictionFeedbackRecord): Promise<void> {
    this.append(parsePredictionLedgerRecord(record));
  }

  public async appendBeliefBatch(record: BeliefBatchRecord): Promise<void> {
    this.append(parsePredictionLedgerRecord(record));
  }

  public async all(): Promise<readonly PredictionLedgerRecord[]> {
    return this.index.all();
  }

  public async recordPlan(record: ActionPlanRecord): Promise<void> {
    this.append(parsePredictionLedgerRecord(record));
  }

  public async recordDecision(record: PlanDecisionRecord): Promise<void> {
    this.append(parsePredictionLedgerRecord(record));
  }

  public async recordStateRejection(
    inputs: ClaimDispatchInputs,
    reasonCode: "state_changed",
  ): Promise<void> {
    this.append(createPlanInvalidationRecord({
      planDigest: inputs.planDigest,
      reasonCode,
    }));
  }

  public async claimDispatch(
    inputs: ClaimDispatchInputs,
    now: string,
    generateClaimToken: () => string,
  ): Promise<DispatchClaimResult> {
    const claimToken = generateClaimToken();
    const prepared = PlanDispatchStateMachine.prepareClaim(
      this.index.all(), inputs, now, claimToken,
    );
    if (!("append" in prepared)) return prepared;
    this.append(prepared.append);
    return { status: "claimed", claimToken };
  }

  public async completeDispatch(
    inputs: { readonly planDigest: string; readonly claimToken: string },
    outcome: "succeeded" | "failed",
    detailsDigest: string,
    now: string,
  ): Promise<CompleteDispatchResult> {
    const prepared = PlanDispatchStateMachine.prepareComplete(
      this.index.all(), inputs, outcome, detailsDigest, now,
    );
    if (!("patch" in prepared)) return prepared;
    this.index.completeDispatch(inputs.planDigest, prepared.patch);
    return { status: "completed" };
  }

  private append(record: PredictionLedgerRecord): void {
    if (this.index.hasEquivalent(record)) return;
    this.index.assertCanAccept(record);
    this.index.add(record);
  }
}

export class JsonlPredictionLedger implements PredictionLedger {
  private readonly index = new LedgerIndex();
  private writeTail: Promise<unknown> = Promise.resolve();
  private loadPromise: Promise<void> | null = null;
  private loaded = false;
  private repairAtBytes: number | null = null;
  private readDiagnostics: PredictionLedgerDiagnostic[] = [];

  public constructor(private readonly filePath: string) {}

  public async deleteRecordsRemovedWithEvents(
    removedEventIds: ReadonlySet<string>,
  ): Promise<number> {
    const write = this.writeTail.then(async () => {
      await this.ensureLoaded();
      const recordIds = resolveRecordsRemovedWithEvents(this.index.all(), removedEventIds);
      if (recordIds.size === 0) return 0;

      // Same atomic rewrite the event store uses: temp file, rename over. An
      // interrupted delete leaves either old history or new — never a half
      // ledger whose audit trail no longer parses.
      const kept = this.index.all().filter((record) => !recordIds.has(record.recordId));
      const tempPath = `${this.filePath}.delete-${crypto.randomUUID()}`;
      await mkdir(dirname(this.filePath), { recursive: true });
      if (this.repairAtBytes !== null) {
        // A pending truncated-tail repair is subsumed by this rewrite: the new
        // file contains only parsed records.
        this.repairAtBytes = null;
      }
      await writeFile(tempPath, kept.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
      await rename(tempPath, this.filePath);
      this.index.remove(recordIds);
      return recordIds.size;
    });
    this.writeTail = write.catch(() => undefined);
    return (await write) as number;
  }

  public get diagnostics(): readonly PredictionLedgerDiagnostic[] {
    return this.readDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  public appendAttempt(record: PredictionAttemptRecord): Promise<void> {
    return this.append(parsePredictionLedgerRecord(record));
  }

  public appendFeedback(record: PredictionFeedbackRecord): Promise<void> {
    return this.append(parsePredictionLedgerRecord(record));
  }

  public appendBeliefBatch(record: BeliefBatchRecord): Promise<void> {
    return this.append(parsePredictionLedgerRecord(record));
  }

  public async recordPlan(record: ActionPlanRecord): Promise<void> {
    await this.append(parsePredictionLedgerRecord(record));
  }

  public async recordDecision(record: PlanDecisionRecord): Promise<void> {
    await this.append(parsePredictionLedgerRecord(record));
  }

  public async recordStateRejection(
    inputs: ClaimDispatchInputs,
    reasonCode: "state_changed",
  ): Promise<void> {
    // Same serial write-tail as claims: the system-side invalidation cannot
    // interleave with a claim against the same state snapshot.
    await this.append(createPlanInvalidationRecord({
      planDigest: inputs.planDigest,
      reasonCode,
    }));
  }

  public async claimDispatch(
    inputs: ClaimDispatchInputs,
    now: string,
    generateClaimToken: () => string,
  ): Promise<DispatchClaimResult> {
    const claimToken = generateClaimToken();
    const prepared = PlanDispatchStateMachine.prepareClaim(
      this.snapshot(), inputs, now, claimToken,
    );
    if (!("append" in prepared)) return prepared;
    // Single write-tail hop: validation ran on the pre-append snapshot and the
    // append re-checks conflicts inside the serialized tail.
    await this.append(prepared.append);
    return { status: "claimed", claimToken };
  }

  public async completeDispatch(
    inputs: { readonly planDigest: string; readonly claimToken: string },
    outcome: "succeeded" | "failed",
    detailsDigest: string,
    now: string,
  ): Promise<CompleteDispatchResult> {
    const prepared = PlanDispatchStateMachine.prepareComplete(
      this.snapshot(), inputs, outcome, detailsDigest, now,
    );
    if (!("patch" in prepared)) return prepared;
    let result: CompleteDispatchResult = { status: "completed" };
    const write = this.writeTail.then(async () => {
      await this.ensureLoaded();
      const revalidated = PlanDispatchStateMachine.prepareComplete(
        this.index.all(), inputs, outcome, detailsDigest, now,
      );
      if (!("patch" in revalidated)) {
        result = revalidated;
        return;
      }
      // The completion must reach the file, not just the index. This backend is
      // append-only, so the terminal state is written as a new line carrying the
      // whole record; `loadExisting` lets the later line supersede the open one.
      // Updating memory alone would lose the outcome on restart, and a completed
      // action would come back looking like one that still needs reconciliation.
      const open = this.index.all().find((record): record is PlanDispatchRecord =>
        record.recordType === "plan_dispatch" &&
        record.planDigest === inputs.planDigest &&
        record.completedOutcome === undefined);
      if (open === undefined) {
        result = { status: "conflict", reasonCode: "no_dispatched_record" };
        return;
      }
      const completed: PlanDispatchRecord = { ...open, ...revalidated.patch };
      await mkdir(dirname(this.filePath), { recursive: true });
      if (this.repairAtBytes !== null) {
        await truncate(this.filePath, this.repairAtBytes);
        this.repairAtBytes = null;
      }
      await appendFile(this.filePath, `${JSON.stringify(completed)}\n`, "utf8");
      this.index.completeDispatch(inputs.planDigest, revalidated.patch);
    });
    this.writeTail = write.catch(() => undefined);
    await write;
    return result;
  }

  private snapshot(): readonly PredictionLedgerRecord[] {
    return this.index.all();
  }

  public async all(): Promise<readonly PredictionLedgerRecord[]> {
    await this.writeTail;
    await this.ensureLoaded();
    return this.index.all();
  }

  private async append(record: PredictionLedgerRecord): Promise<void> {
    const write = this.writeTail.then(async () => {
      await this.ensureLoaded();
      if (this.index.hasEquivalent(record)) return;
      this.index.assertCanAccept(record);
      await mkdir(dirname(this.filePath), { recursive: true });
      if (this.repairAtBytes !== null) {
        await truncate(this.filePath, this.repairAtBytes);
        this.repairAtBytes = null;
      }
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
      this.index.add(record);
    });
    this.writeTail = write.catch(() => undefined);
    await write;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise !== null) return this.loadPromise;
    this.loadPromise = this.loadExisting();
    await this.loadPromise;
  }

  private async loadExisting(): Promise<void> {
    this.readDiagnostics = [];
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        this.loaded = true;
        return;
      }
      throw error;
    }

    const lines = content.split("\n");
    const terminal = lines.pop();
    for (const [index, line] of lines.entries()) {
      if (line.length === 0) continue;
      const record = parseLedgerLine(line, index + 1);
      if (this.index.supersedesOpenDispatch(record)) {
        this.index.supersede(record as PlanDispatchRecord);
      } else if (!this.index.hasEquivalent(record)) {
        this.index.add(record);
      }
    }
    if (terminal !== undefined && terminal.length > 0) {
      try {
        const record = parsePredictionLedgerRecord(JSON.parse(terminal));
        if (this.index.supersedesOpenDispatch(record)) {
          this.index.supersede(record as PlanDispatchRecord);
        } else if (!this.index.hasEquivalent(record)) {
          this.index.add(record);
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          this.readDiagnostics.push({ kind: "truncated_final_record", line: lines.length + 1 });
          this.repairAtBytes = Buffer.byteLength(lines.join("\n"), "utf8")
            + (lines.length > 0 ? Buffer.byteLength("\n", "utf8") : 0);
        } else {
          throw new Error(`Invalid prediction ledger record at line ${lines.length + 1}.`, { cause: error });
        }
      }
    }
    this.loaded = true;
  }
}

class LedgerIndex {
  private readonly records: PredictionLedgerRecord[] = [];
  private readonly byRecordId = new Map<string, PredictionLedgerRecord>();
  private readonly byRequestId = new Map<string, PredictionAttemptRecord | LegacyPredictionAttemptRecord>();
  private readonly candidateIds = new Set<string>();
  private readonly requestByCandidateId = new Map<string, string>();

  /**
   * True when this exact fact was already appended, making a replayed write a
   * no-op instead of a conflict.
   *
   * Observation timestamps are excluded from the comparison for plan and
   * decision records: the fact is *which* plan was proposed and *what* the user
   * decided, not the millisecond the write happened. Comparing wall-clock time
   * would turn every idempotent retry — a re-dispatch of the same plan, a
   * replayed confirmation — into a false conflict. Everything that carries
   * meaning (digests, decision, confirmation mode, egress policy) is still
   * compared, so a genuinely different fact under the same ID still conflicts.
   */
  public hasEquivalent(record: PredictionLedgerRecord): boolean {
    const existing = this.byRecordId.get(record.recordId);
    if (existing === undefined) return false;
    return recordIdentity(existing) === recordIdentity(record);
  }

  public assertCanAccept(record: PredictionLedgerRecord): void {
    const existing = this.byRecordId.get(record.recordId);
    if (existing !== undefined) {
      throw new PredictionLedgerConflictError(`Ledger record ${record.recordId} conflicts with an existing record.`);
    }
    if (record.recordType === "attempt") {
      const existingAttempt = this.byRequestId.get(record.requestId);
      if (existingAttempt !== undefined) {
        throw new PredictionLedgerConflictError(`Prediction request ${record.requestId} already has an attempt record.`);
      }
      const ids = new Set<string>();
      for (const candidate of record.candidates) {
        if (ids.has(candidate.candidateId) || this.candidateIds.has(candidate.candidateId)) {
          throw new PredictionLedgerConflictError(`Candidate ${candidate.candidateId} already exists.`);
        }
        ids.add(candidate.candidateId);
      }
    } else if (
      record.recordType === "feedback" ||
      record.recordType === "plan"
    ) {
      if (!this.candidateIds.has(record.candidateId)) {
        throw new PredictionLedgerReferenceError(
          `Record references unknown candidate ${record.candidateId}.`,
        );
      }
      if (this.requestByCandidateId.get(record.candidateId) !== record.requestId) {
        throw new PredictionLedgerReferenceError(
          `Record candidate ${record.candidateId} does not belong to request ${record.requestId}.`,
        );
      }
    }
  }

  /**
   * True when this record is the completed form of a dispatch already held open.
   *
   * The JSONL backend is append-only, so a completion arrives as a second line
   * with the same recordId and a terminal outcome. On load that is not a
   * conflict — it is the later truth about the same claim — so it supersedes the
   * open record instead of being rejected.
   */
  public supersedesOpenDispatch(record: PredictionLedgerRecord): boolean {
    if (record.recordType !== "plan_dispatch" || record.completedOutcome === undefined) {
      return false;
    }
    const existing = this.byRecordId.get(record.recordId);
    return existing?.recordType === "plan_dispatch" && existing.completedOutcome === undefined;
  }

  public supersede(record: PlanDispatchRecord): void {
    const index = this.records.findIndex((existing) =>
      existing.recordType === "plan_dispatch" && existing.recordId === record.recordId);
    if (index < 0) {
      throw new PredictionLedgerConflictError("No open dispatched record to supersede.");
    }
    this.records[index] = structuredClone(record);
    this.byRecordId.set(record.recordId, record);
  }

  public add(record: PredictionLedgerRecord): void {
    this.assertCanAccept(record);
    this.records.push(structuredClone(record));
    this.byRecordId.set(record.recordId, record);
    if (record.recordType === "attempt") {
      this.byRequestId.set(record.requestId, record);
      for (const candidate of record.candidates) {
        this.candidateIds.add(candidate.candidateId);
        this.requestByCandidateId.set(candidate.candidateId, record.requestId);
      }
    }
  }

  /**
   * In-place completion of a dispatched record. The dispatch already exists —
   * this is the only legal mutation path, driven by `completeDispatch` after
   * the state machine validated the transition.
   */
  public completeDispatch(
    planDigest: string,
    patch: Pick<PlanDispatchRecord, "completedOutcome" | "completedDetailsDigest" | "completedAt">,
  ): void {
    const index = this.records.findIndex((record) =>
      record.recordType === "plan_dispatch" &&
      record.planDigest === planDigest &&
      record.completedOutcome === undefined);
    const record = this.records[index];
    if (record === undefined || record.recordType !== "plan_dispatch") {
      throw new PredictionLedgerConflictError("No open dispatched record to complete.");
    }
    this.records[index] = { ...record, ...patch };
  }

  public all(): readonly PredictionLedgerRecord[] {
    return structuredClone(this.records);
  }

  /**
   * Removes the named records and every index entry they owned.
   *
   * The closure resolver guarantees the set is self-consistent — an attempt's
   * candidates go with it, so dropping their index entries cannot leave a
   * feedback record pointing at a candidate that still exists. Records not in
   * the set are untouched; removing an unknown id is a no-op.
   */
  public remove(recordIds: ReadonlySet<string>): void {
    if (recordIds.size === 0) return;
    // Backwards, so splicing never skips the next record.
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index]!;
      if (!recordIds.has(record.recordId)) continue;
      if (record.recordType === "attempt") {
        this.byRequestId.delete(record.requestId);
        for (const envelope of record.candidates) {
          this.candidateIds.delete(envelope.candidateId);
          this.requestByCandidateId.delete(envelope.candidateId);
        }
      }
      this.byRecordId.delete(record.recordId);
      this.records.splice(index, 1);
    }
  }
}

function nonEmptyString() {
  return Type.String({ minLength: 1 });
}

function timestamp() {
  return Type.String({ format: "date-time", minLength: 1 });
}

function parseLedgerLine(line: string, lineNumber: number): PredictionLedgerRecord {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid prediction ledger record at line ${lineNumber}.`, { cause: error });
  }
  try {
    return parsePredictionLedgerRecord(decoded);
  } catch (error) {
    throw new Error(`Invalid prediction ledger record at line ${lineNumber}.`, { cause: error });
  }
}

/**
 * Key-order-independent serialization. Two records are equivalent when this
 * agrees, so a replayed append is idempotent regardless of key order.
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The subset of a record that decides whether two appends are the same fact.
 *
 * Observation timestamps are excluded for plan and decision records: a retried
 * `recordPlan` or a replayed `recordDecision` describes one event that happened
 * once, and the wall clock at the moment of the retry is metadata about the
 * write rather than part of the fact. Including it would turn every idempotent
 * replay into a spurious conflict. Everything that could change meaning —
 * digests, the decision itself, the egress policy — stays in the identity.
 */
export function recordIdentity(record: PredictionLedgerRecord): string {
  if (record.recordType === "plan") {
    const { createdAt: _createdAt, ...identity } = record;
    return stableJson(identity);
  }
  if (record.recordType === "plan_decision") {
    const { decidedAt: _decidedAt, ...identity } = record;
    return stableJson(identity);
  }
  if (record.recordType === "plan_invalidation") {
    const { invalidatedAt: _invalidatedAt, ...identity } = record;
    return stableJson(identity);
  }
  return stableJson(record);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
