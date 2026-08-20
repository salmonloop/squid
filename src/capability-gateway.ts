import type { PredictionCandidate, PredictionKind } from "./protocol.js";
import type {
  PredictionFeedbackKind,
  PredictionLedger,
} from "./prediction-ledger.js";
import type { PredictionRuntime } from "./prediction-runtime.js";

/**
 * A capability the base wants the outside world to perform. The base owns the
 * intent; the gateway owns the concrete desktop/browser/IDE operation.
 */
export interface ActionRequest {
  readonly candidateId: string;
  readonly kind: PredictionKind;
  readonly parameters: PredictionCandidate["parameters"];
}

/**
 * Result of a capability invocation. The base records this as feedback and
 * never re-derives success from a side channel.
 */
export interface ActionResult {
  readonly candidateId: string;
  readonly outcome: "succeeded" | "failed";
  readonly details?: Record<string, string | number | boolean | null>;
  readonly error?: string;
}

/**
 * Pluggable boundary for dispatching accepted candidates. A real MCP server
 * (or any mature adapter) implements this interface; the base never assumes a
 * concrete capability.
 */
export interface CapabilityGateway {
  readonly id: string;
  invoke(request: ActionRequest): Promise<ActionResult>;
}

export interface FakeCapabilityGatewayOptions {
  readonly id?: string;
  /** Outcome to return. Default "succeeded". */
  readonly outcome?: ActionResult["outcome"];
  /** If set, invoke rejects with this error instead of resolving. */
  readonly error?: Error;
  /** Attached to the result when outcome is "failed". */
  readonly details?: ActionResult["details"];
  readonly delayMs?: number;
}

/**
 * A controllable gateway for offline tests. It can simulate success, failure,
 * latency, and a thrown invocation.
 */
export class FakeCapabilityGateway implements CapabilityGateway {
  public readonly id: string;
  private readonly outcome: ActionResult["outcome"];
  private readonly error: Error | undefined;
  private readonly details: ActionResult["details"] | undefined;
  private readonly delayMs: number;
  private readonly invocations: ActionRequest[] = [];

  public constructor(options: FakeCapabilityGatewayOptions = {}) {
    this.id = options.id ?? "fake-capability";
    this.outcome = options.outcome ?? "succeeded";
    this.error = options.error;
    this.details = options.details;
    this.delayMs = options.delayMs ?? 0;
  }

  public get recordedInvocations(): readonly ActionRequest[] {
    return this.invocations;
  }

  public async invoke(request: ActionRequest): Promise<ActionResult> {
    this.invocations.push(structuredClone(request));
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.error !== undefined) {
      throw this.error;
    }
    return {
      candidateId: request.candidateId,
      outcome: this.outcome,
      ...(this.outcome === "failed" && this.details !== undefined
        ? { details: this.details }
        : {}),
    };
  }
}

export interface CapabilityDispatcherOptions {
  readonly runtime: PredictionRuntime;
  readonly gateway: CapabilityGateway;
  readonly ledger: PredictionLedger;
  /** Injected for deterministic feedback IDs. */
  readonly random?: () => string;
}

interface ResolvedCandidate {
  readonly requestId: string;
  readonly candidate: PredictionCandidate;
}

/**
 * Dispatches an accepted candidate through a capability gateway and records
 * the lifecycle (dispatched → succeeded/failed) as ledger feedback. The
 * dispatcher owns sequencing and recording; the gateway owns the operation.
 *
 * A thrown gateway invocation becomes a "failed" result rather than escaping —
 * the caller learns the outcome from the returned `ActionResult` and the
 * recorded feedback, not from a thrown error.
 *
 * A failed *ledger* write is different and does escape: an unresolvable
 * candidate or a disposed runtime rejects `dispatch`. Only the gateway's own
 * failure is data; losing the record is an error, because a dispatch that was
 * not recorded must not look like one that succeeded.
 */
export class CapabilityDispatcher {
  private readonly runtime: PredictionRuntime;
  private readonly gateway: CapabilityGateway;
  private readonly ledger: PredictionLedger;
  private readonly random: () => string;

  public constructor(options: CapabilityDispatcherOptions) {
    this.runtime = options.runtime;
    this.gateway = options.gateway;
    this.ledger = options.ledger;
    this.random = options.random ?? (() => crypto.randomUUID());
  }

  public async dispatch(candidateId: string): Promise<ActionResult> {
    const resolved = await this.findCandidate(candidateId);
    if (resolved === undefined) {
      throw new Error(`No prediction candidate ${candidateId} recorded in the ledger.`);
    }
    const { requestId, candidate } = resolved;
    const feedbackId = (kind: PredictionFeedbackKind) => `${candidateId}:${kind}:${this.random()}`;

    await this.runtime.recordFeedback({
      feedbackId: feedbackId("dispatched"),
      requestId,
      candidateId,
      feedback: "dispatched",
    });

    let result: ActionResult;
    try {
      result = await this.gateway.invoke({
        candidateId,
        kind: candidate.kind,
        parameters: structuredClone(candidate.parameters),
      });
    } catch (error) {
      result = {
        candidateId,
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    await this.runtime.recordFeedback({
      feedbackId: feedbackId(result.outcome),
      requestId,
      candidateId,
      feedback: result.outcome,
      details: this.feedbackDetails(result),
    });

    return result;
  }

  private async findCandidate(candidateId: string): Promise<ResolvedCandidate | undefined> {
    const records = await this.ledger.all();
    for (const record of records) {
      if (record.recordType !== "attempt") continue;
      const envelope = record.candidates.find((item) => item.candidateId === candidateId);
      if (envelope !== undefined) {
        return { requestId: record.requestId, candidate: envelope.candidate };
      }
    }
    return undefined;
  }

  /**
   * Gateway-supplied details are merged first so the dispatcher's own
   * attribution wins: which gateway ran, and whether it threw, are facts the
   * base observed, not fields a gateway may overwrite.
   */
  private feedbackDetails(result: ActionResult): Record<string, string | number | boolean | null> {
    const details: Record<string, string | number | boolean | null> = {
      ...result.details,
      gateway: this.gateway.id,
    };
    if (result.error !== undefined) {
      details.error = result.error;
    }
    return details;
  }
}
