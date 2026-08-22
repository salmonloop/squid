import { sanitizeAuditText, auditTextDigest } from "./action-egress.js";
import type { EgressPolicy } from "./action-egress.js";
import { digestActionPlan, type ImmutableActionPlan } from "./action-plan.js";
import {
  createActionPlanRecord,
  createPlanDecisionRecord,
  PredictionLedgerReferenceError,
  type PredictionLedger,
} from "./prediction-ledger.js";
import type { PredictionRuntime } from "./prediction-runtime.js";
import type { PredictionCandidate } from "./protocol.js";
import type {
  ActionConfirmationDecision,
  ActionConfirmationPolicy,
} from "./action-confirmation.js";

/**
 * Result of a capability invocation.
 *
 * `outcome` distinguishes two very different things. A `failed` result means the
 * tool ran and reported a structured failure — a fact the ledger may record as
 * terminal. A thrown invocation means nobody knows whether the tool ran, which
 * the dispatcher turns into `reconciliation_required` rather than a fabricated
 * failure.
 */
export interface ActionResult {
  readonly planDigest: string;
  readonly outcome: "succeeded" | "failed";
  readonly details?: Record<string, string | number | boolean | null>;
  readonly error?: string;
}

/**
 * Pluggable boundary for executing one already-approved plan.
 *
 * The gateway receives a finished `ImmutableActionPlan` and never sees a
 * candidate, so a model cannot choose the tool or the command: those were fixed
 * by the planner and approved by the user before this interface is reached.
 */
export interface CapabilityGateway {
  readonly id: string;
  invoke(plan: ImmutableActionPlan): Promise<ActionResult>;
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

/** A controllable gateway for offline tests: success, structured failure, latency, or a throw. */
export class FakeCapabilityGateway implements CapabilityGateway {
  public readonly id: string;
  private readonly outcome: ActionResult["outcome"];
  private readonly error: Error | undefined;
  private readonly details: ActionResult["details"] | undefined;
  private readonly delayMs: number;
  private readonly invocations: ImmutableActionPlan[] = [];

  public constructor(options: FakeCapabilityGatewayOptions = {}) {
    this.id = options.id ?? "fake-capability";
    this.outcome = options.outcome ?? "succeeded";
    this.error = options.error;
    this.details = options.details;
    this.delayMs = options.delayMs ?? 0;
  }

  public get recordedInvocations(): readonly ImmutableActionPlan[] {
    return this.invocations;
  }

  public async invoke(plan: ImmutableActionPlan): Promise<ActionResult> {
    this.invocations.push(structuredClone(plan) as ImmutableActionPlan);
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.error !== undefined) {
      throw this.error;
    }
    return {
      planDigest: digestActionPlan(plan),
      outcome: this.outcome,
      ...(this.outcome === "failed" && this.details !== undefined
        ? { details: this.details }
        : {}),
    };
  }
}

/**
 * Every way a dispatch attempt can end.
 *
 * Only `dispatched` means the capability ran and its terminal state was
 * recorded. `reconciliation_required` is the honest answer when the claim
 * succeeded but the outcome is unknowable — a transport timeout, a crash, or a
 * terminal write that failed. It never becomes `failed`, because a fabricated
 * failure would invite an automatic retry of an action that may have run.
 */
export type DispatchStatus =
  | "dispatched"
  | "not_admitted"
  | "not_accepted"
  | "expired"
  | "already_claimed"
  | "terminal"
  | "reconciliation_required";

export interface DispatchOutcome {
  readonly status: DispatchStatus;
  readonly planDigest: string;
  /** Stable refusal identifier. Never carries user text. */
  readonly reasonCode?: string;
  /** Present only when the capability actually ran. */
  readonly action: ActionResult | null;
}

export interface DispatchRequest {
  readonly plan: ImmutableActionPlan;
  readonly planDigest: string;
  readonly candidateParametersDigest: string;
  readonly candidate: PredictionCandidate;
  readonly egressPolicy: EgressPolicy;
}

export interface CapabilityDispatcherOptions {
  readonly runtime: PredictionRuntime;
  readonly gateway: CapabilityGateway;
  readonly ledger: PredictionLedger;
  /** Required for plans whose confirmation is "required". */
  readonly confirmation?: ActionConfirmationPolicy;
  /** Injected for deterministic tests. */
  readonly now?: () => Date;
}

/**
 * The only path from an approved plan to an executed capability.
 *
 * The order is fixed and each step exists to close one hole:
 *
 * 1. `recordPlan` — the plan is durable before the user is asked, so the thing
 *    they approve is the thing the ledger can prove was proposed.
 * 2. confirmation — for plans that need it, recorded as a user decision.
 * 3. `admitAndClaim` — re-validates against the *current* projection and claims
 *    atomically inside the runtime's serial queue. This is the linearization
 *    point: a verdict computed before confirmation says nothing about the world
 *    after it, and two concurrent dispatches of one candidate cannot both win.
 * 4. `invoke` — only a `claimed` status gets here, and no further check may
 *    reject: after the claim, refusing would leave a dispatched record with no
 *    terminal state.
 * 5. `completeDispatch` — records the terminal state under the opaque claim
 *    token.
 *
 * Nothing in this class re-derives a tool or a command; it moves one immutable
 * plan through the state machine.
 */
export class CapabilityDispatcher {
  private readonly runtime: PredictionRuntime;
  private readonly gateway: CapabilityGateway;
  private readonly ledger: PredictionLedger;
  private readonly confirmation: ActionConfirmationPolicy | undefined;
  private readonly now: () => Date;

  public constructor(options: CapabilityDispatcherOptions) {
    this.runtime = options.runtime;
    this.gateway = options.gateway;
    this.ledger = options.ledger;
    this.confirmation = options.confirmation;
    this.now = options.now ?? (() => new Date());
  }

  public async dispatch(request: DispatchRequest): Promise<DispatchOutcome> {
    const { plan, planDigest } = request;

    // The digest and the plan must be the same fact. Everything downstream — the
    // recorded plan, the user's decision, the claim, the terminal outcome — is
    // keyed by the digest while the gateway executes the plan, so a mismatched
    // pair would produce an audit trail describing an operation that never ran.
    // Enforced here rather than trusted from the caller: there is one call site
    // today, and this invariant is what the whole boundary rests on.
    if (digestActionPlan(plan) !== planDigest) {
      return {
        status: "not_admitted",
        planDigest,
        reasonCode: "plan_digest_mismatch",
        action: null,
      };
    }

    // A plan whose attempt never landed durably cannot be dispatched: the claim
    // would have nothing to validate against. This is the "attempt write failed"
    // path — the prediction was still delivered, but the action is refused with
    // zero capability calls rather than dispatched on an unauditable basis.
    try {
      await this.ledger.recordPlan(createActionPlanRecord({
        attemptId: plan.attemptId,
        requestId: plan.attemptId,
        candidateId: plan.candidateId,
        planDigest,
        candidateParametersDigest: request.candidateParametersDigest,
        confirmation: plan.confirmation,
        egressPolicyId: request.egressPolicy.id,
        createdAt: this.now().toISOString(),
      }));
    } catch (error) {
      return {
        status: "not_admitted",
        planDigest,
        reasonCode: error instanceof PredictionLedgerReferenceError
          ? "attempt_missing"
          : "plan_conflict",
        action: null,
      };
    }

    if (plan.confirmation === "required") {
      const refusal = await this.confirmPlan(request);
      if (refusal !== null) return refusal;
    }

    // The linearization point. Everything before this may still be refused;
    // nothing after it may be.
    const claimed = await this.runtime.admitAndClaim({
      plan,
      planDigest,
      candidate: request.candidate,
      egressPolicy: request.egressPolicy,
    });
    if (claimed.status === "not_admitted") {
      return { status: "not_admitted", planDigest, reasonCode: claimed.reasonCode, action: null };
    }
    const claim = claimed.claim;
    if (claim.status !== "claimed") {
      return {
        status: claim.status === "rejected" ? "not_accepted" : claim.status,
        planDigest,
        ...(claim.status === "rejected" ? { reasonCode: claim.reasonCode } : {}),
        action: null,
      };
    }

    let result: ActionResult;
    try {
      result = { ...(await this.gateway.invoke(plan)), planDigest };
    } catch (error) {
      // The call may or may not have reached the tool. Recording `failed` here
      // would assert something unknown, so the dispatch stays open for a human.
      return {
        status: "reconciliation_required",
        planDigest,
        reasonCode: "transport_failure",
        action: null,
      };
    }

    const details = this.auditDetails(result);
    try {
      const completed = await this.ledger.completeDispatch(
        { planDigest, claimToken: claim.claimToken },
        result.outcome,
        auditTextDigest(details),
        this.now().toISOString(),
      );
      if (completed.status !== "completed") {
        // Carry the ledger's own reason rather than a generic "conflict": a
        // token mismatch and a contradictory outcome need different human
        // responses, and this code is all the operator will see.
        return {
          status: "reconciliation_required",
          planDigest,
          reasonCode: completed.reasonCode,
          action: result,
        };
      }
    } catch {
      // The capability ran but its terminal state is not durable. Same rule as
      // a transport failure: report, never fabricate.
      return {
        status: "reconciliation_required",
        planDigest,
        reasonCode: "terminal_write_failed",
        action: result,
      };
    }

    return { status: "dispatched", planDigest, action: result };
  }

  /**
   * Runs the confirmation policy and records the decision. Returns `null` when
   * the plan may proceed, or the terminal outcome when it may not.
   */
  private async confirmPlan(request: DispatchRequest): Promise<DispatchOutcome | null> {
    const { plan, planDigest } = request;
    if (this.confirmation === undefined) {
      return {
        status: "not_accepted",
        planDigest,
        reasonCode: "confirmation_policy_missing",
        action: null,
      };
    }
    // The policy sees the whole immutable plan, not a summary copied out of it:
    // whatever it prints is byte-for-byte what `invoke` will execute.
    let decision: ActionConfirmationDecision;
    try {
      decision = await this.confirmation.confirm({
        candidateId: plan.candidateId,
        plan,
        expiresAt: request.candidate.expiresAt,
      });
    } catch {
      // A confirmation policy that throws — a closed stream, a crashed prompt —
      // is not consent. Treated as a refusal so the caller still gets a
      // DispatchOutcome rather than an exception, and recorded as one so the
      // plan does not sit in the ledger as an undecided proposal forever.
      decision = { outcome: "rejected", reason: "input_closed" };
    }
    await this.ledger.recordDecision(createPlanDecisionRecord({
      planDigest,
      decision: decision.outcome,
      detailsDigest: auditTextDigest(
        sanitizeAuditText(decision.reason, "summary").text,
      ),
      decidedAt: this.now().toISOString(),
    }));
    if (decision.outcome !== "accepted") {
      return {
        status: decision.outcome === "expired" ? "expired" : "not_accepted",
        planDigest,
        reasonCode: decision.reason,
        action: null,
      };
    }
    return null;
  }

  /**
   * Collapses a gateway result into a single sanitized audit line. Tool output
   * may echo user text, so it passes through the same sanitizer as everything
   * else that reaches the ledger, and only its digest is persisted.
   */
  private auditDetails(result: ActionResult): string {
    const summary = typeof result.details?.summary === "string" ? result.details.summary : "";
    const error = result.error ?? "";
    return [
      this.gateway.id,
      result.outcome,
      sanitizeAuditText(summary, "mcp_summary").text,
      sanitizeAuditText(error, "mcp_summary").text,
    ].join("|");
  }
}
