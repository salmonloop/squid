import { describeErrorForAudit } from "./action-egress.js";
import { evidenceTimeline } from "./belief-evidence.js";
import {
  NoBeliefsError,
  validateBatchAgainstRequest,
  type BeliefOutcome,
  type BeliefProvider,
  type BeliefRequest,
} from "./belief-provider.js";
import { BELIEF_LIMITS, type BeliefStateBatch } from "./belief-state.js";
import type { PredictionRequest } from "./prediction-provider.js";

/**
 * Turns a `PredictionRequest` into a validated belief batch, or into nothing.
 *
 * This is the live-path counterpart to what `ShadowCognitionRunner` does inline:
 * build a `BeliefRequest` from the projection identity the request carries, ask the
 * provider, and refuse to hand back anything the contract does not accept. It is a
 * separate function because `BeliefBackedPredictionProvider` takes the resolver as
 * a seam — which is what keeps the belief layer off the critical path.
 *
 * Every failure resolves to `null` rather than rejecting. A belief is an
 * improvement to a prediction, never a precondition for one: an unreachable belief
 * provider must degrade to cognition-from-state, and below that the coordinator's
 * heuristic fallback still sits. `onOutcome` is how a run says *why* beliefs were
 * absent — without it, a cognition provider silently predicting belief-free forever
 * is indistinguishable from one the belief layer is feeding.
 */
export interface BeliefResolverOptions {
  readonly beliefProvider: BeliefProvider;
  /**
   * The policy the state was projected through. Must be the id of the *same*
   * `ContextPolicy` the coordinator applied: the belief contract refuses a batch
   * claiming a different one, because the same world redacted differently is a
   * different input.
   */
  readonly contextPolicyId: string;
  /** Observes every attempt, including the ones that produced nothing. */
  readonly onOutcome?: (outcome: BeliefOutcome) => void;
  /** Ceiling on belief lifetime. Defaults to the contract maximum. */
  readonly maxTtlMs?: number;
  /** Injected for deterministic latency in tests. */
  readonly now?: () => Date;
}

export type BeliefResolver = (
  request: PredictionRequest,
  signal: AbortSignal,
) => Promise<BeliefStateBatch | null>;

export function createBeliefResolver(options: BeliefResolverOptions): BeliefResolver {
  const maxTtlMs = Math.min(options.maxTtlMs ?? BELIEF_LIMITS.maxTtlMs, BELIEF_LIMITS.maxTtlMs);
  const clock = options.now ?? (() => new Date());

  return async (request, signal) => {
    const startedAt = clock().getTime();
    const report = (
      status: BeliefOutcome["status"],
      batch: BeliefStateBatch | null,
      reasonCode?: string,
    ): BeliefStateBatch | null => {
      try {
        options.onOutcome?.({
          requestId: request.id,
          provider: options.beliefProvider.name,
          status,
          batch,
          latencyMs: clock().getTime() - startedAt,
          ...(reasonCode === undefined ? {} : { reasonCode }),
        });
      } catch {
        // Observation is best-effort and must never change what a prediction sees.
      }
      return batch;
    };

    // Both of these are structural, not failures. A belief is scoped to an
    // episode and to a specific projection by contract, so a request carrying
    // neither has nothing valid to ask for — and inventing a digest to fill the
    // gap is exactly how a batch describing a world that never existed would
    // come to validate.
    if (request.episodeId === null) {
      return report("none", null, "no_episode");
    }
    if (request.projection === undefined) {
      return report("none", null, "no_projection_identity");
    }

    const beliefRequest: BeliefRequest = {
      id: `${request.id}:beliefs`,
      worldState: request.worldState,
      episodeId: request.episodeId,
      stateDigest: request.projection.stateDigest,
      projectionGeneration: request.projection.projectionGeneration,
      contextPolicyId: options.contextPolicyId,
      triggeredAt: request.triggeredAt,
    };

    let produced: unknown;
    try {
      produced = await options.beliefProvider.infer(beliefRequest, signal);
    } catch (error) {
      // "Nothing to assert" is a normal answer. Folding it into `failed` would
      // make a quiet desktop read as a broken belief layer.
      if (error instanceof NoBeliefsError) return report("none", null);
      return report(
        signal.aborted ? "cancelled" : "failed",
        null,
        describeErrorForAudit(error),
      );
    }

    const validated = validateBatchAgainstRequest(produced, beliefRequest, {
      // Validation time is the *state's* time, not the wall clock. Every belief
      // is inferred at `triggeredAt` and expires a bounded interval after it, so
      // checking against the wall clock would reject every batch during a replay
      // of a recorded corpus — the gate would then admit a provider that had
      // never once been given a belief. State time also keeps the whole path a
      // pure function of its input, which is the property the stability gate
      // measures.
      now: request.triggeredAt,
      currentEpisodeId: beliefRequest.episodeId,
      currentStateDigest: beliefRequest.stateDigest,
      currentProjectionGeneration: beliefRequest.projectionGeneration,
      eventOccurredAt: evidenceTimeline(request.worldState),
      maxTtlMs,
    });
    if (!validated.ok) {
      // The provider answered but its batch did not survive validation — a
      // different problem from an unreachable provider, and one a gate has to be
      // able to tell apart.
      return report("rejected", null, validated.reasonCode);
    }
    return report("succeeded", validated.batch);
  };
}
