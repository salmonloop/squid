import type { BeliefStateBatch } from "./belief-state.js";
import type { PredictionProvider, PredictionRequest } from "./prediction-provider.js";
import type { PredictionCandidate } from "./protocol.js";

/**
 * Turns beliefs plus world state into prediction candidates.
 *
 * The beliefs are an *additional* input, not a replacement for state: a candidate
 * still has to name the concrete parameters an action needs, and those come from
 * the projection. What a belief adds is why an action is plausible now — a
 * `debug_failure` belief and a `draft_text` belief rank the same world
 * differently.
 *
 * Beliefs may be absent. The belief layer is allowed to be unavailable, so a
 * cognition provider must produce something reasonable from state alone rather
 * than treating a missing batch as an error.
 */
export interface CognitionRequest extends PredictionRequest {
  /** Null when the belief layer produced nothing usable for this state. */
  readonly beliefs: BeliefStateBatch | null;
}

export interface CognitionProvider {
  readonly name: string;
  predict(request: CognitionRequest, signal: AbortSignal): Promise<readonly PredictionCandidate[]>;
}

/**
 * Adapts a `CognitionProvider` to the plain `PredictionProvider` interface every
 * existing consumer expects, given a way to obtain beliefs.
 *
 * This is what keeps the belief layer off the critical path. `resolveBeliefs`
 * returns null on any failure, so an unreachable belief provider degrades to
 * cognition-from-state rather than to no prediction at all — and the coordinator's
 * own heuristic fallback still sits underneath that.
 */
export class BeliefBackedPredictionProvider implements PredictionProvider {
  public readonly name: string;

  public constructor(
    private readonly cognition: CognitionProvider,
    private readonly resolveBeliefs: (
      request: PredictionRequest,
      signal: AbortSignal,
    ) => Promise<BeliefStateBatch | null>,
  ) {
    this.name = cognition.name;
  }

  public async predict(
    request: PredictionRequest,
    signal: AbortSignal,
  ): Promise<readonly PredictionCandidate[]> {
    let beliefs: BeliefStateBatch | null;
    try {
      beliefs = await this.resolveBeliefs(request, signal);
    } catch {
      // A belief failure must not become a prediction failure. Swallowed here
      // rather than in the resolver so any resolver — including one that throws
      // on abort — degrades the same way.
      beliefs = null;
    }
    return this.cognition.predict({ ...request, beliefs }, signal);
  }
}
