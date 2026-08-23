import type { PredictionCandidate, WorldState } from "./protocol.js";
import type { Predictor } from "./baseline-predictor.js";

/**
 * Identity of the projection a request was built from.
 *
 * A prediction only needs the state itself, but anything that has to prove it
 * reasoned about *this* world rather than a previous one needs the projection's
 * identity — which is why the belief contract requires both fields and refuses a
 * batch whose digest or generation has moved.
 *
 * Grouped rather than two independent optionals because a digest without a
 * generation cannot identify a projection: one field is meaningless alone, so the
 * type should not permit it.
 */
export interface ProjectionIdentity {
  readonly stateDigest: string;
  readonly projectionGeneration: number;
}

/**
 * An immutable snapshot of the world state at the moment a prediction was requested.
 */
export interface PredictionRequest {
  /** Unique ID for this request, stable across retries. */
  readonly id: string;
  /** Immutable world-state snapshot passed to the provider. */
  readonly worldState: WorldState;
  /** Episode ID when available — used to discard stale results. */
  readonly episodeId: string | null;
  /** ISO timestamp of the state that triggered this request. */
  readonly triggeredAt: string;
  /**
   * Which projection this state is, when the caller knows. Absent means the
   * request was not driven by a core projection — a direct `predict` call in a
   * test, for instance.
   *
   * Optional rather than required precisely so no caller is ever forced to invent
   * a digest. A fabricated projection identity would let a belief batch validate
   * against a world that never existed, which is the failure the digest exists to
   * prevent; a consumer that needs one degrades instead when it is absent.
   */
  readonly projection?: ProjectionIdentity;
}

export type PredictionStatus =
  | "succeeded"
  | "failed"
  | "timeout"
  | "cancelled"
  | "stale";

/**
 * The outcome of a prediction attempt. When the provider fails, times out, or is
 * cancelled, the coordinator falls back to the heuristic predictor and reports
 * the original failure reason in `fallbackReason`.
 */
export interface PredictionOutcome {
  readonly requestId: string;
  readonly provider: string;
  readonly status: PredictionStatus;
  readonly candidates: readonly PredictionCandidate[];
  readonly latencyMs: number;
  readonly fallbackReason?: string;
}

/**
 * Async prediction provider — the interface PiRuntime and any future LLM-backed
 * predictor must implement. The provider must respect the AbortSignal: if the
 * signal is already aborted or becomes aborted, the provider must abort its
 * underlying work (e.g. `session.abort()`) and reject with an error.
 */
export interface PredictionProvider {
  readonly name: string;
  predict(request: PredictionRequest, signal: AbortSignal): Promise<readonly PredictionCandidate[]>;
}

/**
 * Wraps a synchronous `Predictor` as a no-op `PredictionProvider` — the signal
 * is ignored because the heuristic predictor is instantaneous. This lets the
 * coordinator treat baseline and LLM providers uniformly.
 */
export class SyncPredictorProvider implements PredictionProvider {
  public readonly name: string;

  public constructor(
    private readonly predictor: Predictor,
    name = "heuristic",
  ) {
    this.name = name;
  }

  public async predict(request: PredictionRequest, _signal: AbortSignal): Promise<readonly PredictionCandidate[]> {
    return this.predictor.predict(request.worldState, new Date(request.triggeredAt));
  }
}
