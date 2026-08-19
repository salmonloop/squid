import { HeuristicPredictor, type Predictor } from "./baseline-predictor.js";
import type { PredictionCandidate, WorldState } from "./protocol.js";
import { cloneWorldState } from "./world-state.js";
import type { PredictionOutcome, PredictionProvider, PredictionRequest } from "./prediction-provider.js";

export interface PredictionCoordinatorOptions {
  readonly provider: PredictionProvider;
  /** Fallback used when the provider fails, times out, or is cancelled. */
  readonly fallback?: Predictor;
  /** Hard timeout per request. Default 15 seconds. */
  readonly timeoutMs?: number;
  /** Called for every outcome — used in shadow mode to record structured logs. */
  readonly onOutcome?: (outcome: PredictionOutcome) => void;
  /** Injected for deterministic tests. */
  readonly now?: () => Date;
  /** Injected for deterministic tests. */
  readonly random?: () => string;
}

/**
 * Coordinates async predictions: at most one request is in flight at a time.
 * A new request cancels any in-flight one. On timeout, failure, or cancellation
 * the coordinator falls back to the heuristic predictor so a result is always
 * available. Outcomes are published exactly once per request via `onOutcome`.
 *
 * The coordinator never blocks the caller beyond starting the request — the
 * underlying provider call runs in the background and the returned promise
 * resolves when the provider responds or falls back.
 */
export class PredictionCoordinator {
  private readonly provider: PredictionProvider;
  private readonly fallback: Predictor;
  private readonly timeoutMs: number;
  private readonly onOutcome: ((outcome: PredictionOutcome) => void) | undefined;
  private readonly now: () => Date;
  private readonly random: () => string;

  private activeController: AbortController | null = null;
  private activeRequestId: string | null = null;
  private activeEpoch = 0;
  private activeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Request IDs cancelled by an explicit `cancelActive` call (vs. supersede). */
  private readonly explicitlyCancelled = new Set<string>();

  public constructor(options: PredictionCoordinatorOptions) {
    this.provider = options.provider;
    this.fallback = options.fallback ?? new HeuristicPredictor();
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.onOutcome = options.onOutcome;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? (() => crypto.randomUUID());
  }

  /**
   * Request a prediction. Cancels any in-flight request first. Resolves with an
   * outcome — never rejects. On any provider failure (timeout, cancel, error)
   * the outcome carries the heuristic fallback candidates and the failure reason.
   */
  public async request(worldState: WorldState): Promise<PredictionOutcome> {
    this.abortActive();

    const requestId = this.random();
    const epoch = ++this.activeEpoch;
    const episodeId = worldState.episode?.id ?? null;
    const request: PredictionRequest = {
      id: requestId,
      worldState: cloneWorldState(worldState),
      episodeId,
      triggeredAt: worldState.updatedAt ?? this.now().toISOString(),
    };

    const controller = new AbortController();
    this.activeController = controller;
    this.activeRequestId = requestId;

    const startedAt = this.now();
    let timedOut = false;

    const timeout = new Promise<never>((_, reject) => {
      this.activeTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new PredictionTimeoutError(requestId));
      }, this.timeoutMs);
    });

    try {
      const candidates = await Promise.race([
        this.provider.predict(request, controller.signal),
        timeout,
      ]);
      return this.finish(epoch, request, startedAt, "succeeded", candidates);
    } catch (error) {
      const reason = timedOut
        ? "timeout"
        : this.explicitlyCancelled.has(requestId)
          ? "cancelled"
          : "failed";
      const message = error instanceof Error ? error.message : String(error);
      const fallbackCandidates = this.fallback.predict(
        request.worldState,
        new Date(request.triggeredAt),
      );
      return this.finish(epoch, request, startedAt, reason, fallbackCandidates, message);
    }
  }

  /** Cancel and discard any in-flight request. Idempotent. */
  public cancelActive(_reason: string): void {
    const requestId = this.activeRequestId;
    const controller = this.activeController;
    if (requestId === null || controller === null) {
      return;
    }
    this.explicitlyCancelled.add(requestId);
    this.abortActive();
  }

  public dispose(): void {
    this.cancelActive("disposed");
  }

  // -- internal -----------------------------------------------------------

  /**
   * Abort the active controller and clear the timer. Does NOT increment epoch
   * or clear `activeRequestId` — the in-flight request's catch block needs
   * those to decide whether it was superseded, explicitly cancelled, or failed.
   */
  private abortActive(): void {
    if (this.activeTimer !== undefined) {
      clearTimeout(this.activeTimer);
      this.activeTimer = undefined;
    }
    const controller = this.activeController;
    if (controller !== null && !controller.signal.aborted) {
      controller.abort();
    }
  }

  private clearActive(): void {
    if (this.activeTimer !== undefined) {
      clearTimeout(this.activeTimer);
    }
    this.activeController = null;
    this.activeRequestId = null;
    this.activeTimer = undefined;
  }

  private finish(
    epoch: number,
    request: PredictionRequest,
    startedAt: Date,
    status: PredictionOutcome["status"],
    candidates: readonly PredictionCandidate[],
    fallbackReason?: string,
  ): PredictionOutcome {
    this.explicitlyCancelled.delete(request.id);
    const latencyMs = this.now().getTime() - startedAt.getTime();

    // A newer request incremented the epoch — this result is stale.
    if (this.activeEpoch !== epoch) {
      const outcome: PredictionOutcome = {
        requestId: request.id,
        provider: this.provider.name,
        status: "stale",
        candidates: [],
        latencyMs,
        fallbackReason: "superseded",
      };
      this.onOutcome?.(outcome);
      return outcome;
    }

    this.clearActive();

    const outcome: PredictionOutcome = {
      requestId: request.id,
      provider: this.provider.name,
      status,
      candidates: structuredClone(candidates),
      latencyMs,
      ...(fallbackReason !== undefined ? { fallbackReason } : {}),
    };
    this.onOutcome?.(outcome);
    return outcome;
  }
}

export class PredictionTimeoutError extends Error {
  public constructor(public readonly requestId: string) {
    super(`Prediction request ${requestId} timed out.`);
    this.name = "PredictionTimeoutError";
  }
}
