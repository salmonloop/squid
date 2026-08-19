import type { PredictionCandidate, WorldState } from "./protocol.js";
import type { Predictor } from "./baseline-predictor.js";

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
