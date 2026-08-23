import { validateBeliefStateBatch, type BeliefStateBatch, type BeliefValidationContext } from "./belief-state.js";
import type { WorldState } from "./protocol.js";

/**
 * Produces beliefs about what the user is doing, from projected world state.
 *
 * Separate from `PredictionProvider` because the two answer different questions.
 * A prediction is "what action might help now"; a belief is "what is going on"
 * — longer-lived, and reusable across several predictions. Splitting them is what
 * lets a belief be evaluated for stability on its own, which is the property the
 * existing predictor path measurably lacks.
 *
 * The provider receives *projected* state, never raw: the request carries what a
 * `ContextPolicy` allowed out, so a belief producer cannot see what a redacting
 * policy withheld.
 */
export interface BeliefRequest {
  /** Unique ID for this request, stable across retries. */
  readonly id: string;
  /** Already projected through the active `ContextPolicy`. */
  readonly worldState: WorldState;
  /** Episode the state belongs to. Beliefs never cross episodes. */
  readonly episodeId: string;
  readonly stateDigest: string;
  readonly projectionGeneration: number;
  readonly contextPolicyId: string;
  readonly triggeredAt: string;
}

export interface BeliefProvider {
  readonly name: string;
  /**
   * Returns a batch, or rejects. Rejection is a normal outcome — the coordinator
   * treats an unavailable belief layer as "no beliefs", never as a reason to
   * block a prediction.
   */
  infer(request: BeliefRequest, signal: AbortSignal): Promise<BeliefStateBatch>;
}

/**
 * The documented way a provider says "nothing to assert".
 *
 * A batch must carry at least one belief (`minItems: 1`), which is deliberate:
 * "no beliefs" and "no batch" must not be two states a consumer has to tell
 * apart. So a provider with no firing rule rejects with this rather than
 * returning an empty batch, and the coordinator maps it to `status: "none"` —
 * a normal outcome, not a failure to report.
 */
export class NoBeliefsError extends Error {
  public constructor(public readonly requestId: string) {
    super(`Belief request ${requestId} produced no beliefs.`);
    this.name = "NoBeliefsError";
  }
}

export type BeliefOutcomeStatus =
  | "succeeded"
  /** The provider had nothing to assert. Not a failure; see `NoBeliefsError`. */
  | "none"
  | "failed"
  | "timeout"
  | "cancelled"
  | "rejected";

/**
 * What one belief attempt produced.
 *
 * `rejected` is distinct from `failed`: the provider answered but its batch did
 * not survive validation. That difference is the whole reason the belief contract
 * is fail-closed — a model that returns malformed or stale beliefs is a different
 * problem from one that is unreachable, and a gate must be able to tell them
 * apart.
 */
export interface BeliefOutcome {
  readonly requestId: string;
  readonly provider: string;
  readonly status: BeliefOutcomeStatus;
  /** Null unless status is "succeeded". */
  readonly batch: BeliefStateBatch | null;
  readonly latencyMs: number;
  /** Stable reason identifier. Never carries model text. */
  readonly reasonCode?: string;
}

/**
 * Validates a provider's batch against the state it was asked about.
 *
 * Exists so every consumer applies the same rules rather than trusting a
 * provider that already claims to be valid. The batch's own metadata must agree
 * with the request: a batch describing a different episode, digest, or generation
 * is about a world that no longer exists, and a belief about a stale world is
 * worse than no belief, because a consumer cannot tell the difference.
 */
export function validateBatchAgainstRequest(
  batch: unknown,
  request: BeliefRequest,
  context: BeliefValidationContext,
): { readonly ok: true; readonly batch: BeliefStateBatch } | { readonly ok: false; readonly reasonCode: string } {
  const validated = validateBeliefStateBatch(batch, context);
  if (!validated.ok) return { ok: false, reasonCode: "batch_invalid" };

  const value = validated.value;
  if (value.episodeId !== request.episodeId) return { ok: false, reasonCode: "episode_mismatch" };
  if (value.stateDigest !== request.stateDigest) return { ok: false, reasonCode: "state_digest_mismatch" };
  if (value.projectionGeneration !== request.projectionGeneration) {
    return { ok: false, reasonCode: "projection_generation_mismatch" };
  }
  // The policy the state was projected through is part of what the beliefs are
  // about: the same world redacted differently is a different input, and a batch
  // claiming another policy was not inferred from what was actually sent.
  if (value.contextPolicyId !== request.contextPolicyId) {
    return { ok: false, reasonCode: "context_policy_mismatch" };
  }
  return { ok: true, batch: value };
}
