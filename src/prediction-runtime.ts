import type { ActivityEvent, WorldState } from "./protocol.js";
import type { IngestDisposition, SquidCore } from "./squid-core.js";
import { PassthroughCapturePolicy, type CapturePolicy } from "./capture-policy.js";

/**
 * The capture boundary in front of the deterministic core.
 *
 * This class used to be the orchestrator: it asked a provider for predictions,
 * wrote an attempt record for every outcome, and owned `admitAndClaim` — the
 * linearization point where a ranked candidate became an authorized command.
 * All of that assumed Squid decided what happened next.
 *
 * It does not. The resident agent reads the projection and chooses its own
 * actions, so what is left here is the one job that genuinely belongs in front
 * of the store: apply the capture policy, then ingest. Capture is the
 * irreversible edge — once an event is ingested it is history — and that is why
 * it stays a distinct stage rather than collapsing into `SquidCore`.
 */

/**
 * Result of ingesting an event.
 *
 * Null when the capture policy excluded the event before the store. The caller
 * learns only that nothing was recorded — which event was refused, and why, is
 * exactly the information exclusion must not surface.
 */
export interface PredictionRuntimeIngestResult {
  readonly ingest: {
    readonly disposition: IngestDisposition;
    readonly state: WorldState;
    readonly stateDigest: string;
    readonly projectionGeneration: number;
    /**
     * The event that triggered this projection.
     *
     * `captured.eventId`, not the caller's — the capture policy is what decided
     * which event entered history, so this is the id retention deletion will
     * match on.
     */
    readonly triggerEventId: string;
    /**
     * The instant this ingest is called to have happened. Falls back to the
     * runtime's own clock when the projection carries no `updatedAt`, so it is
     * resolved once here rather than re-derived by each reader.
     */
    readonly triggeredAt: string;
  } | null;
}

export interface PredictionRuntimeOptions {
  /** Injected for deterministic tests. */
  readonly now?: () => Date;
  /**
   * Ingress filter applied before an event enters the store. Capture is
   * irreversible — once ingested an event is history — so a policy that redacts
   * here narrows what is persisted rather than what is merely projected. The
   * default passes through unchanged, so wiring a runtime never silently filters
   * what was already being captured; a durable path opts in explicitly.
   */
  readonly capturePolicy?: CapturePolicy;
}

export class PredictionRuntime {
  private readonly inFlightIngests = new Set<Promise<PredictionRuntimeIngestResult>>();
  private readonly now: () => Date;
  private readonly capturePolicy: CapturePolicy;
  private disposed = false;

  public constructor(
    private readonly core: SquidCore,
    options: PredictionRuntimeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.capturePolicy = options.capturePolicy ?? new PassthroughCapturePolicy();
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
    // Capture is the irreversible boundary: this is the last chance to strip
    // credential content before `core.ingest` writes the event to history. A
    // null verdict means the policy excluded the event outright — the user's
    // capture policy refused it, and nothing about it (no stub, no marker)
    // enters history. The refusal is silent by design; see ExcludingCapturePolicy.
    const captured = this.capturePolicy.capture(event);
    if (captured === null) {
      return { ingest: null };
    }
    const result = await this.core.ingest(captured);
    return {
      ingest: {
        ...result,
        triggerEventId: captured.eventId,
        triggeredAt: result.state.updatedAt ?? this.now().toISOString(),
      },
    };
  }

  public async awaitIdle(): Promise<void> {
    while (this.inFlightIngests.size > 0) {
      await Promise.allSettled([...this.inFlightIngests]);
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      await this.awaitIdle();
      return;
    }
    this.disposed = true;
    await this.awaitIdle();
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error("PredictionRuntime is disposed.");
    }
  }
}
