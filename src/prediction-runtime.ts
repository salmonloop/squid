import type { PredictionOutcome } from "./prediction-provider.js";
import { PredictionCoordinator } from "./prediction-coordinator.js";
import type { ActivityEvent, PredictionCandidate, WorldState } from "./protocol.js";
import type { IngestDisposition, SquidCore } from "./squid-core.js";
import {
  PassthroughCapturePolicy,
  type CapturePolicy,
} from "./capture-policy.js";
import {
  candidateEnvelopes,
  createAttemptRecord,
  createFeedbackRecord,
  type AttemptRecordMetadataInput,
  type DispatchClaimResult,
  type PredictionFeedbackInput,
  type PredictionLedger,
} from "./prediction-ledger.js";
import {
  admitAction,
  type AdmissionReasonCode,
} from "./action-admission.js";
import type { ImmutableActionPlan } from "./action-plan.js";
import { describeErrorForAudit, type EgressPolicy } from "./action-egress.js";

/**
 * Outcome of the runtime's single action gate.
 *
 * `not_admitted` means the world moved and the action must be dropped; the
 * ledger was not touched. `claim` carries the ledger's verdict, and only a
 * `claimed` status inside it authorizes a capability invocation.
 */
export type AdmitAndClaimResult =
  | { readonly status: "not_admitted"; readonly reasonCode: AdmissionReasonCode }
  | { readonly status: "claim"; readonly claim: DispatchClaimResult };

/**
 * Result of ingesting an event through the live assistant runtime.
 *
 * Core projection is complete before this result is returned. Prediction is
 * deliberately exposed as a separate promise so callers can choose whether to
 * await a provider or keep ingestion responsive while the provider runs.
 */
export interface PredictionRuntimeIngestResult {
  /**
   * Null when the capture policy excluded the event before the store. The
   * caller learns only that nothing was recorded — which event was refused,
   * and why, is exactly the information exclusion must not surface.
   */
  readonly ingest: {
    readonly disposition: IngestDisposition;
    readonly state: WorldState;
    readonly baselinePredictions: readonly PredictionCandidate[];
  } | null;
  readonly prediction: Promise<PredictionOutcome> | null;
}

/**
 * The durable identity a runtime stamps onto every attempt record. All four
 * fields are required: a record without them could not be audited back to the
 * policy boundary that authorized it.
 */
export interface PredictionRuntimeIdentity {
  /** Stable for one process lifetime; distinguishes restarts in the ledger. */
  readonly runtimeSessionId: string;
  /** Trust level of the selected provider, from the provider gate. */
  readonly actionTrust: "trusted" | "suggestion_only";
  /** Identifier of the egress policy governing search actions. */
  readonly egressPolicyId: string;
}

export interface PredictionRuntimeOptions extends Partial<PredictionRuntimeIdentity> {
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
  /**
   * Ingress filter applied before an event enters the store. Capture is
   * irreversible — once ingested an event is history — so a policy that redacts
   * here narrows what is persisted rather than what is merely projected. The
   * default passes through unchanged, so wiring a runtime never silently filters
   * what was already being captured; a durable path opts in explicitly.
   */
  readonly capturePolicy?: CapturePolicy;
}

export interface PredictionRuntimeDiagnostic {
  readonly kind: "ledger_write_failed";
  readonly requestId: string;
  readonly message: string;
}

interface AttemptContext extends AttemptRecordMetadataInput {
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
  private readonly capturePolicy: CapturePolicy;
  private readonly runtimeSessionId: string;
  private readonly actionTrust: "trusted" | "suggestion_only";
  private readonly egressPolicyId: string;
  private disposed = false;

  public constructor(
    private readonly core: SquidCore,
    private readonly coordinator: PredictionCoordinator,
    options: PredictionRuntimeOptions = {},
  ) {
    this.ledger = options.ledger;
    this.onDiagnostic = options.onDiagnostic;
    this.now = options.now ?? (() => new Date());
    this.capturePolicy = options.capturePolicy ?? new PassthroughCapturePolicy();
    // Defaults are real values, not placeholders: an unconfigured session is
    // still a distinct session, and an unset trust level conservatively reads
    // as suggestion-only rather than claiming a gate it never passed.
    this.runtimeSessionId =
      options.runtimeSessionId ?? `runtime-${crypto.randomUUID()}`;
    this.actionTrust = options.actionTrust ?? "suggestion_only";
    this.egressPolicyId = options.egressPolicyId ?? "search-egress-deny-v1";
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
      return { ingest: null, prediction: null };
    }
    const result = await this.core.ingest(captured);
    if (this.disposed || result.disposition === "duplicate") {
      return { ingest: result, prediction: null };
    }
    const context: AttemptContext = {
      triggerEventId: captured.eventId,
      episodeId: result.state.episode?.id ?? null,
      triggeredAt: result.state.updatedAt ?? this.now().toISOString(),
      runtimeSessionId: this.runtimeSessionId,
      stateDigest: result.stateDigest,
      projectionGeneration: result.projectionGeneration,
      triggerDisposition: result.disposition === "late" ? "late" : "accepted",
      contextPolicyId: this.coordinator.contextPolicyId,
      actionTrust: this.actionTrust,
      egressPolicyId: this.egressPolicyId,
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

  /**
   * Append a feedback record linked to a candidate by its stable ID. The
   * ledger validates that the candidate exists and belongs to the request, so
   * a reference error is thrown to the caller — feedback is an explicit
   * action, not a best-effort side effect like attempt recording. The write is
   * tracked for shutdown drain, so an unawaited feedback is not lost on
   * dispose.
   */
  public recordFeedback(input: PredictionFeedbackInput): Promise<void> {
    this.assertOpen();
    if (this.ledger === undefined) {
      throw new Error("PredictionRuntime has no ledger attached.");
    }
    const write = this.appendFeedback(input);
    this.trackLedgerWrite(write);
    return write;
  }

  /**
   * The linearization point for action dispatch.
   *
   * Admission and the ledger claim run together inside the core's critical
   * section, so no ingest can land between "the state still matches" and "this
   * claim is recorded". Splitting them — checking first, claiming after — is the
   * race this method exists to close: an event arriving in that window would
   * make the dispatched action reference a projection that no longer exists.
   *
   * Deliberately narrow: callers cannot pass arbitrary work into the queue, and
   * everything the verdict depends on is read inside it rather than supplied by
   * the caller. Only `claimed` authorizes an outside-world invocation.
   */
  public async admitAndClaim(input: {
    readonly plan: ImmutableActionPlan;
    readonly planDigest: string;
    readonly candidate: PredictionCandidate;
    readonly egressPolicy: EgressPolicy;
  }): Promise<AdmitAndClaimResult> {
    this.assertOpen();
    const ledger = this.ledger;
    if (ledger === undefined) {
      throw new Error("PredictionRuntime has no ledger attached.");
    }
    return this.core.runWithProjection(async (snapshot) => {
      const records = await ledger.all();
      const attempt = records.find((record) =>
        record.recordType === "attempt" &&
        record.requestId === input.plan.attemptId &&
        record.schemaVersion === 2);
      const admission = admitAction({
        plan: input.plan,
        attempt: attempt?.recordType === "attempt" && attempt.schemaVersion === 2
          ? attempt
          : undefined,
        candidate: input.candidate,
        state: snapshot.state,
        runtimeSessionId: this.runtimeSessionId,
        stateDigest: snapshot.stateDigest,
        projectionGeneration: snapshot.projectionGeneration,
        contextPolicyId: this.coordinator.contextPolicyId,
        actionTrust: this.actionTrust,
        egressPolicy: input.egressPolicy,
        now: this.now(),
      });
      if (!admission.admitted) {
        return { status: "not_admitted", reasonCode: admission.reasonCode };
      }
      const claim = await ledger.claimDispatch(
        {
          attemptId: input.plan.attemptId,
          candidateId: input.plan.candidateId,
          runtimeSessionId: this.runtimeSessionId,
          projectionGeneration: snapshot.projectionGeneration,
          stateDigest: snapshot.stateDigest,
          episodeId: snapshot.state.episode?.id ?? null,
          triggerDisposition: "accepted",
          contextPolicyId: this.coordinator.contextPolicyId,
          actionTrust: this.actionTrust,
          egressPolicyId: input.egressPolicy.id,
          planDigest: input.planDigest,
        },
        this.now().toISOString(),
        () => crypto.randomUUID(),
      );
      return { status: "claim", claim };
    });
  }

  private async appendFeedback(input: PredictionFeedbackInput): Promise<void> {
    const record = createFeedbackRecord(input, this.now());
    await this.ledger!.appendFeedback(record);
  }

  /**
   * Publishes an outcome only after its attempt record has been written.
   *
   * The order matters for actions, not for tidiness: a caller that receives an
   * outcome may immediately try to dispatch one of its candidates, and the claim
   * validates against the persisted attempt. Settling first would open a window
   * where a dispatch is refused as `attempt_missing` purely because the write
   * had not landed yet.
   *
   * A failed write still delivers the prediction — it is a diagnostic, never a
   * prediction failure — but the attempt is then genuinely absent, so any action
   * built on it is correctly refused rather than silently unauditable.
   */
  private track(
    prediction: Promise<PredictionOutcome>,
    context: AttemptContext,
  ): Promise<PredictionOutcome> {
    this.pending.add(prediction);
    const published = prediction.then(
      async (outcome) => {
        this.pending.delete(prediction);
        const write = this.recordAttempt(outcome, context);
        this.trackLedgerWrite(write);
        await write;
        return outcome;
      },
      (error: unknown) => {
        this.pending.delete(prediction);
        throw error;
      },
    );
    return published;
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
        runtimeSessionId: context.runtimeSessionId,
        stateDigest: context.stateDigest,
        projectionGeneration: context.projectionGeneration,
        triggerDisposition: context.triggerDisposition,
        contextPolicyId: context.contextPolicyId,
        actionTrust: context.actionTrust,
        egressPolicyId: context.egressPolicyId,
      });
      await this.ledger.appendAttempt(record);
    } catch (error) {
      this.reportDiagnostic({
        kind: "ledger_write_failed",
        requestId: outcome.requestId,
        message: describeErrorForAudit(error),
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
