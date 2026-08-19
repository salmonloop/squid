import type { PredictionOutcome } from "./prediction-provider.js";
import { PredictionCoordinator } from "./prediction-coordinator.js";
import type { ActivityEvent, PredictionCandidate, WorldState } from "./protocol.js";
import type { IngestDisposition, SquidCore } from "./squid-core.js";
import {
  candidateEnvelopes,
  createAttemptRecord,
  type PredictionLedger,
} from "./prediction-ledger.js";

/**
 * Result of ingesting an event through the live assistant runtime.
 *
 * Core projection is complete before this result is returned. Prediction is
 * deliberately exposed as a separate promise so callers can choose whether to
 * await a provider or keep ingestion responsive while the provider runs.
 */
export interface PredictionRuntimeIngestResult {
  readonly ingest: {
    readonly disposition: IngestDisposition;
    readonly state: WorldState;
    readonly baselinePredictions: readonly PredictionCandidate[];
  };
  readonly prediction: Promise<PredictionOutcome> | null;
}

export interface PredictionRuntimeOptions {
  /**
   * Durable sink for every prediction attempt. When omitted, the runtime runs
   * without persistence — useful for tests and headless runs that only need
   * live outcomes.
   */
  readonly ledger?: PredictionLedger;
  /** Reports non-fatal ledger failures. Ledger failures never block delivery. */
  readonly onDiagnostic?: (diagnostic: PredictionRuntimeDiagnostic) => void;
  /** Injected for deterministic tests. */
  readonly now?: () => Date;
}

export interface PredictionRuntimeDiagnostic {
  readonly kind: "ledger_write_failed";
  readonly requestId: string;
  readonly message: string;
}

interface AttemptContext {
  readonly triggerEventId: string;
  readonly episodeId: string | null;
  readonly triggeredAt: string;
}

/**
 * Live orchestration boundary for the deterministic Chronicle core and an
 * asynchronous prediction coordinator.
 *
 * `SquidCore` remains the source of truth for events and state. This class only
 * decides when a new state snapshot should trigger prediction and guarantees
 * that duplicate events do not create duplicate provider requests. When a
 * ledger is attached, every outcome is persisted as a durable attempt record;
 * a ledger failure is a diagnostic, never a prediction failure.
 */
export class PredictionRuntime {
  private readonly pending = new Set<Promise<PredictionOutcome>>();
  private readonly inFlightIngests = new Set<Promise<PredictionRuntimeIngestResult>>();
  private readonly pendingLedgerWrites = new Set<Promise<void>>();
  private readonly ledger: PredictionLedger | undefined;
  private readonly onDiagnostic: ((diagnostic: PredictionRuntimeDiagnostic) => void) | undefined;
  private readonly now: () => Date;
  private disposed = false;

  public constructor(
    private readonly core: SquidCore,
    private readonly coordinator: PredictionCoordinator,
    options: PredictionRuntimeOptions = {},
  ) {
    this.ledger = options.ledger;
    this.onDiagnostic = options.onDiagnostic;
    this.now = options.now ?? (() => new Date());
  }

  public get currentState(): WorldState {
    return this.core.currentState;
  }

  public async restore(): Promise<WorldState> {
    this.assertOpen();
    return this.core.restore();
  }

  public ingest(event: ActivityEvent): Promise<PredictionRuntimeIngestResult> {
    const operation = this.ingestInternal(event);
    this.inFlightIngests.add(operation);
    void operation.then(
      () => this.inFlightIngests.delete(operation),
      () => this.inFlightIngests.delete(operation),
    );
    return operation;
  }

  private async ingestInternal(event: ActivityEvent): Promise<PredictionRuntimeIngestResult> {
    this.assertOpen();
    const result = await this.core.ingest(event);
    if (this.disposed || result.disposition === "duplicate") {
      return { ingest: result, prediction: null };
    }
    const context: AttemptContext = {
      triggerEventId: event.eventId,
      episodeId: result.state.episode?.id ?? null,
      triggeredAt: result.state.updatedAt ?? this.now().toISOString(),
    };
    const prediction = this.track(this.coordinator.request(result.state), context);

    return {
      ingest: result,
      prediction,
    };
  }

  public async awaitIdle(): Promise<void> {
    while (
      this.pending.size > 0 ||
      this.inFlightIngests.size > 0 ||
      this.pendingLedgerWrites.size > 0
    ) {
      await Promise.allSettled([
        ...this.pending,
        ...this.inFlightIngests,
        ...this.pendingLedgerWrites,
      ]);
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      await this.awaitIdle();
      return;
    }
    this.disposed = true;
    this.coordinator.dispose();
    await this.awaitIdle();
  }

  private track(
    prediction: Promise<PredictionOutcome>,
    context: AttemptContext,
  ): Promise<PredictionOutcome> {
    this.pending.add(prediction);
    void prediction.then(
      (outcome) => {
        this.pending.delete(prediction);
        this.trackLedgerWrite(this.recordAttempt(outcome, context));
      },
      () => this.pending.delete(prediction),
    );
    return prediction;
  }

  private trackLedgerWrite(write: Promise<void>): void {
    this.pendingLedgerWrites.add(write);
    void write.then(
      () => this.pendingLedgerWrites.delete(write),
      () => this.pendingLedgerWrites.delete(write),
    );
  }

  private async recordAttempt(
    outcome: PredictionOutcome,
    context: AttemptContext,
  ): Promise<void> {
    if (this.ledger === undefined) return;
    try {
      const candidates = candidateEnvelopes(outcome.requestId, outcome.candidates);
      const record = createAttemptRecord({
        triggerEventId: context.triggerEventId,
        episodeId: context.episodeId,
        triggeredAt: context.triggeredAt,
        completedAt: this.now().toISOString(),
        outcome,
        candidates,
      });
      await this.ledger.appendAttempt(record);
    } catch (error) {
      this.reportDiagnostic({
        kind: "ledger_write_failed",
        requestId: outcome.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private reportDiagnostic(diagnostic: PredictionRuntimeDiagnostic): void {
    try {
      this.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics are best-effort and must never change prediction delivery.
    }
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error("PredictionRuntime is disposed.");
    }
  }
}
