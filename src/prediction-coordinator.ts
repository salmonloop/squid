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
  /** Reports non-fatal fallback or observer failures. */
  readonly onDiagnostic?: (diagnostic: PredictionCoordinatorDiagnostic) => void;
  /** Injected for deterministic tests. */
  readonly now?: () => Date;
  /** Injected for deterministic tests. */
  readonly random?: () => string;
}

export interface PredictionCoordinatorDiagnostic {
  readonly kind: "fallback_failed" | "outcome_observer_failed";
  readonly requestId: string;
  readonly message: string;
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
  private readonly onDiagnostic: ((diagnostic: PredictionCoordinatorDiagnostic) => void) | undefined;
  private readonly now: () => Date;
  private readonly random: () => string;

  private activeController: AbortController | null = null;
  private activeRequestId: string | null = null;
  private activeEpoch = 0;
  private activeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Request IDs cancelled by an explicit `cancelActive` call (vs. supersede). */
  private readonly explicitCancellationReasons = new Map<string, string>();

  public constructor(options: PredictionCoordinatorOptions) {
    this.provider = options.provider;
    this.fallback = options.fallback ?? new HeuristicPredictor();
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.onOutcome = options.onOutcome;
    this.onDiagnostic = options.onDiagnostic;
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
    let rejectAborted: ((error: PredictionAbortedError) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAborted = reject;
    });
    const onAbort = () => rejectAborted?.(new PredictionAbortedError(requestId));
    controller.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const candidates = await Promise.race([
        this.provider.predict(request, controller.signal),
        timeout,
        aborted,
      ]);
      return this.finish(epoch, request, startedAt, "succeeded", candidates);
    } catch (error) {
      const cancellationReason = this.explicitCancellationReasons.get(requestId);
      const reason = timedOut
        ? "timeout"
        : cancellationReason !== undefined
          ? "cancelled"
          : "failed";
      const message = cancellationReason ?? errorMessage(error);
      if (this.activeEpoch !== epoch) {
        return this.finish(epoch, request, startedAt, reason, [], "superseded");
      }
      let fallbackCandidates: readonly PredictionCandidate[] = [];
      let fallbackReason = message;
      try {
        fallbackCandidates = this.fallback.predict(
          request.worldState,
          new Date(request.triggeredAt),
        );
      } catch (fallbackError) {
        const fallbackMessage = errorMessage(fallbackError);
        fallbackReason = `${message}; fallback failed: ${fallbackMessage}`;
        this.reportDiagnostic({
          kind: "fallback_failed",
          requestId,
          message: fallbackMessage,
        });
      }
      return this.finish(epoch, request, startedAt, reason, fallbackCandidates, fallbackReason);
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  /** Cancel and discard any in-flight request. Idempotent. */
  public cancelActive(reason: string): void {
    const requestId = this.activeRequestId;
    const controller = this.activeController;
    if (requestId === null || controller === null) {
      return;
    }
    this.explicitCancellationReasons.set(requestId, reason);
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
    this.explicitCancellationReasons.delete(request.id);
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
      this.publish(outcome);
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
    this.publish(outcome);
    return outcome;
  }

  private publish(outcome: PredictionOutcome): void {
    try {
      this.onOutcome?.(outcome);
    } catch (error) {
      this.reportDiagnostic({
        kind: "outcome_observer_failed",
        requestId: outcome.requestId,
        message: errorMessage(error),
      });
    }
  }

  private reportDiagnostic(diagnostic: PredictionCoordinatorDiagnostic): void {
    try {
      this.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics are best-effort and must never change prediction delivery.
    }
  }
}

export class PredictionTimeoutError extends Error {
  public constructor(public readonly requestId: string) {
    super(`Prediction request ${requestId} timed out.`);
    this.name = "PredictionTimeoutError";
  }
}

export class PredictionAbortedError extends Error {
  public constructor(public readonly requestId: string) {
    super(`Prediction request ${requestId} completed after it was aborted.`);
    this.name = "PredictionAbortedError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
