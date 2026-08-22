import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { Compile } from "typebox/compile";
import { Type } from "typebox";
import type { PredictionOutcome } from "./prediction-provider.js";
import type { PredictionCandidate, PredictionKind } from "./protocol.js";

export const feedbackKinds = [
  "accepted",
  "rejected",
  "expired",
  "dispatched",
  "succeeded",
  "failed",
] as const;

export type PredictionFeedbackKind = (typeof feedbackKinds)[number];

export interface PredictionCandidateEnvelope {
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
  readonly candidates: readonly PredictionCandidateEnvelope[];
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

export type PredictionLedgerRecord =
  | PredictionAttemptRecord
  | LegacyPredictionAttemptRecord
  | PredictionFeedbackRecord
  | ActionPlanRecord
  | PlanDecisionRecord
  | PlanDispatchRecord;

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
  all(): Promise<readonly PredictionLedgerRecord[]>;

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

export interface PredictionFeedbackInput {
  readonly feedbackId: string;
  readonly requestId: string;
  readonly candidateId: string;
  readonly feedback: PredictionFeedbackKind;
  readonly occurredAt?: string;
  readonly details?: Record<string, string | number | boolean | null>;
}

const scalar = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const candidateSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("draft_completion"),
    Type.Literal("run_tests"),
    Type.Literal("inspect_error"),
    Type.Literal("search_selection"),
    Type.Literal("none"),
  ]),
  rationale: Type.String(),
  confidence: Type.Number(),
  expiresAt: Type.String({ minLength: 1 }),
  sourceEventIds: Type.Array(Type.String()),
  parameters: Type.Record(Type.String(), scalar),
}, { additionalProperties: false });
const envelopeSchema = Type.Object({
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
  candidates: Type.Array(envelopeSchema),
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
  actionPlanSchema,
  planDecisionSchema,
  planDispatchSchema,
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
  return candidates.map((candidate, ordinal) => ({
    candidateId: `${requestId}:candidate:${ordinal}`,
    ordinal,
    candidate: structuredClone(candidate),
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

export function parsePredictionLedgerRecord(value: unknown): PredictionLedgerRecord {
  if (!recordValidator.Check(value)) {
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
        return Date.parse(envelope.candidate.expiresAt) <= Date.parse(now)
          ? { status: "expired" }
          : { status: "rejected", reasonCode: "not_accepted" };
      }
    } else if (decision.decision === "accepted") {
      if (Date.parse(envelope.candidate.expiresAt) <= Date.parse(now)) {
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

export class InMemoryPredictionLedger implements PredictionLedger {
  private readonly index = new LedgerIndex();

  public async appendAttempt(record: PredictionAttemptRecord): Promise<void> {
    this.append(parsePredictionLedgerRecord(record));
  }

  public async appendFeedback(record: PredictionFeedbackRecord): Promise<void> {
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
    _inputs: ClaimDispatchInputs,
    reasonCode: "state_changed",
  ): Promise<void> {
    // The rejection is materialized as an expired-style plan decision owned by
    // the system, not by the user — recorded through the same atomic boundary
    // as claims so it cannot race one.
    void reasonCode;
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
  private writeTail: Promise<void> = Promise.resolve();
  private loadPromise: Promise<void> | null = null;
  private loaded = false;
  private repairAtBytes: number | null = null;
  private readDiagnostics: PredictionLedgerDiagnostic[] = [];

  public constructor(private readonly filePath: string) {}

  public get diagnostics(): readonly PredictionLedgerDiagnostic[] {
    return this.readDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  public appendAttempt(record: PredictionAttemptRecord): Promise<void> {
    return this.append(parsePredictionLedgerRecord(record));
  }

  public appendFeedback(record: PredictionFeedbackRecord): Promise<void> {
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
    await this.appendSystemRejection(inputs, reasonCode);
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
    const write = this.writeTail.then(async () => {
      await this.ensureLoaded();
      const revalidated = PlanDispatchStateMachine.prepareComplete(
        this.index.all(), inputs, outcome, detailsDigest, now,
      );
      if (!("patch" in revalidated)) throw new Error(`completeDispatch ${revalidated.status}`);
      this.index.completeDispatch(inputs.planDigest, revalidated.patch);
    });
    this.writeTail = write.catch(() => undefined);
    await write;
    return { status: "completed" };
  }

  private snapshot(): readonly PredictionLedgerRecord[] {
    void 0;
    return this.index.all();
  }

  private async appendSystemRejection(
    _inputs: ClaimDispatchInputs,
    _reasonCode: "state_changed",
  ): Promise<void> {
    // Materialized by the dispatcher as an explicit plan decision with a
    // system details digest; the ledger itself stays append-only here.
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
      if (!this.index.hasEquivalent(record)) this.index.add(record);
    }
    if (terminal !== undefined && terminal.length > 0) {
      try {
        const record = parsePredictionLedgerRecord(JSON.parse(terminal));
        if (!this.index.hasEquivalent(record)) this.index.add(record);
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
  return stableJson(record);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
