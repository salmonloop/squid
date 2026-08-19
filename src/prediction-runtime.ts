import type { PredictionOutcome } from "./prediction-provider.js";
import { PredictionCoordinator } from "./prediction-coordinator.js";
import type { ActivityEvent, PredictionCandidate, WorldState } from "./protocol.js";
import type { IngestDisposition, SquidCore } from "./squid-core.js";

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

/**
 * Live orchestration boundary for the deterministic Chronicle core and an
 * asynchronous prediction coordinator.
 *
 * `SquidCore` remains the source of truth for events and state. This class only
 * decides when a new state snapshot should trigger prediction and guarantees
 * that duplicate events do not create duplicate provider requests.
 */
export class PredictionRuntime {
  private readonly pending = new Set<Promise<PredictionOutcome>>();
  private readonly inFlightIngests = new Set<Promise<PredictionRuntimeIngestResult>>();
  private disposed = false;

  public constructor(
    private readonly core: SquidCore,
    private readonly coordinator: PredictionCoordinator,
  ) {}

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
    const prediction = this.disposed || result.disposition === "duplicate"
      ? null
      : this.track(this.coordinator.request(result.state));

    return {
      ingest: result,
      prediction,
    };
  }

  public async awaitIdle(): Promise<void> {
    while (this.pending.size > 0 || this.inFlightIngests.size > 0) {
      await Promise.allSettled([
        ...this.pending,
        ...this.inFlightIngests,
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

  private track(prediction: Promise<PredictionOutcome>): Promise<PredictionOutcome> {
    this.pending.add(prediction);
    void prediction.then(
      () => this.pending.delete(prediction),
      () => this.pending.delete(prediction),
    );
    return prediction;
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error("PredictionRuntime is disposed.");
    }
  }
}
