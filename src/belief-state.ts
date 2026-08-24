import { Compile } from "typebox/compile";
import { Type } from "typebox";
import { describeErrorForAudit } from "./action-egress.js";

/** The only belief schema shipped in this phase. */
export const BELIEF_SCHEMA_VERSION = 1 as const;
export const BELIEF_TYPE = "task_intent" as const;

export const beliefValues = [
  "debug_failure",
  "draft_text",
  "research_selection",
  "validate_change",
  "unknown",
] as const;

export type BeliefValue = (typeof beliefValues)[number];

/**
 * Bounds keep an untrusted producer from turning a batch into a data sink.
 *
 * `maxTtlMs` needs a word, because read alongside `validateBatchAgainstRequest` it
 * looks self-contradictory: that function demands exact agreement on the state
 * digest and projection generation, and `SquidCore` bumps the generation on every
 * ingest, so a batch is refused the moment the next event lands. A 24-hour ceiling
 * over a validity window of one projection would be incoherent — if they answered
 * the same question.
 *
 * They answer two. `expiresAt` is the *producer's* claim about how long its own
 * inference deserves to be believed, and the ceiling exists to bound that claim: a
 * producer asserting a week-long intent is overreaching whatever else is true. The
 * digest equality decides something else entirely — whether this batch may inform
 * *this* prediction — and the answer has to be no for any world that has moved,
 * because a consumer cannot tell a stale belief from a fresh one by looking at it.
 *
 * So the ceiling is not a promise about reuse. A validated batch is persisted as
 * history (`BeliefBatchRecord` in `prediction-ledger.ts`) and nothing ever reads one
 * back as ranking input, which is why the digest question is never asked of a stored
 * record. That restriction is load-bearing rather than cautious: `runSemanticGate`
 * admits a cognition provider by replaying a corpus and requiring an identical top-1
 * answer every time, which holds only while a prediction is a pure function of the
 * state it was given. A belief read back from the ledger would make the answer
 * depend on what earlier runs happened to write.
 *
 * What accumulates across a session is therefore the record — auditable through
 * `bun run ledger:report` — rather than the ranking. Raising this ceiling would not
 * change that; the equality checks are what bound a belief's reach, and they are
 * deliberate.
 */
export const BELIEF_LIMITS = {
  maxBeliefs: 32,
  maxEvidenceEventIds: 32,
  maxStringLength: 256,
  maxTtlMs: 24 * 60 * 60 * 1000,
} as const;

export interface BeliefState {
  readonly id: string;
  readonly type: typeof BELIEF_TYPE;
  readonly value: BeliefValue;
  readonly confidence: number;
  readonly evidenceEventIds: readonly string[];
  readonly inferredAt: string;
  readonly expiresAt: string;
}

export interface BeliefStateBatch {
  readonly schemaVersion: typeof BELIEF_SCHEMA_VERSION;
  readonly beliefBatchId: string;
  readonly projectionGeneration: number;
  readonly episodeId: string;
  readonly stateDigest: string;
  readonly generatedAt: string;
  readonly provider: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly contextPolicyId: string;
  readonly beliefs: readonly BeliefState[];
}

export interface BeliefValidationContext {
  /** Explicit validation time. The validator never reads the process clock. */
  readonly now: string;
  readonly currentEpisodeId: string;
  readonly currentStateDigest: string;
  readonly currentProjectionGeneration: number;
  /** The authoritative event timeline available to the validator. */
  readonly eventOccurredAt: ReadonlyMap<string, string>;
  /** Maximum allowed lifetime measured from each belief's inferredAt. */
  readonly maxTtlMs: number;
}

export interface BeliefValidationSuccess {
  readonly ok: true;
  readonly value: BeliefStateBatch;
}

export interface BeliefValidationFailure {
  readonly ok: false;
  readonly error: BeliefStateValidationError;
}

export type BeliefValidationResult = BeliefValidationSuccess | BeliefValidationFailure;

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const nonEmptyBoundedString = Type.String({
  minLength: 1,
  maxLength: BELIEF_LIMITS.maxStringLength,
});
const timestamp = Type.String({ minLength: 1, maxLength: 64, format: "date-time" });
const beliefSchema = Type.Object({
  id: nonEmptyBoundedString,
  type: Type.Literal(BELIEF_TYPE),
  value: Type.Union(beliefValues.map((value) => Type.Literal(value))),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  evidenceEventIds: Type.Array(nonEmptyBoundedString, {
    minItems: 1,
    maxItems: BELIEF_LIMITS.maxEvidenceEventIds,
  }),
  inferredAt: timestamp,
  expiresAt: timestamp,
}, { additionalProperties: false });

export const beliefStateBatchSchema = Type.Object({
  schemaVersion: Type.Literal(BELIEF_SCHEMA_VERSION),
  beliefBatchId: nonEmptyBoundedString,
  projectionGeneration: Type.Integer({ minimum: 0 }),
  episodeId: nonEmptyBoundedString,
  stateDigest: Type.String({ pattern: digestPattern.source }),
  generatedAt: timestamp,
  provider: nonEmptyBoundedString,
  modelVersion: nonEmptyBoundedString,
  promptVersion: nonEmptyBoundedString,
  contextPolicyId: nonEmptyBoundedString,
  beliefs: Type.Array(beliefSchema, {
    minItems: 1,
    maxItems: BELIEF_LIMITS.maxBeliefs,
  }),
}, { additionalProperties: false });

const validateBatchShape = Compile(beliefStateBatchSchema);

export class BeliefStateValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BeliefStateValidationError";
  }
}

/**
 * Parses and validates a producer batch against the current observed context.
 * Every failure rejects the whole batch; no partial belief is returned.
 */
export function parseBeliefStateBatch(
  value: unknown,
  context: BeliefValidationContext,
): BeliefStateBatch {
  validateContext(context);
  if (!validateBatchShape.Check(value)) {
    throw new BeliefStateValidationError("Belief state batch failed schema validation.");
  }

  const batch = validateBatchShape.Parse(value) as BeliefStateBatch;
  validateSemantics(batch, context);
  return structuredClone(batch);
}

/** Non-throwing boundary for callers that treat malformed model output as data. */
export function validateBeliefStateBatch(
  value: unknown,
  context: BeliefValidationContext,
): BeliefValidationResult {
  try {
    return { ok: true, value: parseBeliefStateBatch(value, context) };
  } catch (error) {
    // A schema failure quotes the value that failed, and the value here is model
    // output that may have echoed a selection back. Sanitized before it becomes
    // a message any caller is free to log.
    const validationError = error instanceof BeliefStateValidationError
      ? error
      : new BeliefStateValidationError(describeErrorForAudit(error));
    return { ok: false, error: validationError };
  }
}

function validateContext(context: BeliefValidationContext): void {
  if (!isBoundedString(context.currentEpisodeId)) {
    throw new BeliefStateValidationError("Current episode ID is invalid.");
  }
  if (!digestPattern.test(context.currentStateDigest)) {
    throw new BeliefStateValidationError("Current state digest is invalid.");
  }
  if (!isSafeNonNegativeInteger(context.currentProjectionGeneration)) {
    throw new BeliefStateValidationError("Current projection generation is invalid.");
  }
  const now = parseTime(context.now, "Validation time");
  if (!Number.isSafeInteger(context.maxTtlMs)
    || context.maxTtlMs <= 0
    || context.maxTtlMs > BELIEF_LIMITS.maxTtlMs) {
    throw new BeliefStateValidationError("Maximum belief TTL is invalid.");
  }
  if (context.eventOccurredAt === null
    || typeof context.eventOccurredAt !== "object"
    || typeof context.eventOccurredAt.get !== "function"
    || typeof context.eventOccurredAt[Symbol.iterator] !== "function") {
    throw new BeliefStateValidationError("Event occurrence data must be a map.");
  }
  for (const [eventId, occurredAt] of context.eventOccurredAt) {
    if (!isBoundedString(eventId)) {
      throw new BeliefStateValidationError("Event evidence ID is invalid.");
    }
    const eventTime = parseTime(occurredAt, `Occurrence time for ${eventId}`);
    if (eventTime > now) {
      throw new BeliefStateValidationError(`Event ${eventId} occurs in the future.`);
    }
  }
}

function validateSemantics(batch: BeliefStateBatch, context: BeliefValidationContext): void {
  if (batch.episodeId !== context.currentEpisodeId) {
    throw new BeliefStateValidationError("Belief batch episode does not match the current episode.");
  }
  if (batch.stateDigest !== context.currentStateDigest) {
    throw new BeliefStateValidationError("Belief batch state digest does not match the current projection.");
  }
  if (batch.projectionGeneration !== context.currentProjectionGeneration) {
    throw new BeliefStateValidationError("Belief batch generation does not match the current projection.");
  }

  const generatedAt = parseTime(batch.generatedAt, "Batch generatedAt");
  const now = parseTime(context.now, "Validation time");
  if (generatedAt > now) {
    throw new BeliefStateValidationError("Belief batch is generated in the future.");
  }

  const beliefIds = new Set<string>();
  for (const belief of batch.beliefs) {
    if (beliefIds.has(belief.id)) {
      throw new BeliefStateValidationError(`Belief ID ${belief.id} is duplicated.`);
    }
    beliefIds.add(belief.id);
  }

  for (const belief of batch.beliefs) {
    const inferredAt = parseTime(belief.inferredAt, `Belief ${belief.id} inferredAt`);
    const expiresAt = parseTime(belief.expiresAt, `Belief ${belief.id} expiresAt`);
    if (inferredAt > generatedAt) {
      throw new BeliefStateValidationError(`Belief ${belief.id} is inferred after its batch.`);
    }
    if (expiresAt <= inferredAt) {
      throw new BeliefStateValidationError(`Belief ${belief.id} has no positive lifetime.`);
    }
    if (expiresAt - inferredAt > context.maxTtlMs) {
      throw new BeliefStateValidationError(`Belief ${belief.id} exceeds the maximum TTL.`);
    }
    if (expiresAt <= now) {
      throw new BeliefStateValidationError(`Belief ${belief.id} is expired at validation time.`);
    }
    if (!Number.isFinite(belief.confidence) || belief.confidence < 0 || belief.confidence > 1) {
      throw new BeliefStateValidationError(`Belief ${belief.id} has invalid confidence.`);
    }

    const evidenceIds = new Set<string>();
    for (const evidenceId of belief.evidenceEventIds) {
      if (beliefIds.has(evidenceId)) {
        throw new BeliefStateValidationError(`Belief ${belief.id} references a belief as evidence.`);
      }
      if (evidenceIds.has(evidenceId)) {
        throw new BeliefStateValidationError(`Belief ${belief.id} repeats evidence ${evidenceId}.`);
      }
      evidenceIds.add(evidenceId);
      const occurredAt = context.eventOccurredAt.get(evidenceId);
      if (occurredAt === undefined) {
        throw new BeliefStateValidationError(`Belief ${belief.id} references unknown event ${evidenceId}.`);
      }
      if (parseTime(occurredAt, `Occurrence time for ${evidenceId}`) > inferredAt) {
        throw new BeliefStateValidationError(`Belief ${belief.id} uses future evidence ${evidenceId}.`);
      }
    }
  }
}

function parseTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new BeliefStateValidationError(`${label} is not a valid timestamp.`);
  }
  return parsed;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= BELIEF_LIMITS.maxStringLength;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
