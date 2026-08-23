import type { ImmutableActionPlan } from "./action-plan.js";

export interface ActionConfirmationRequest {
  readonly candidateId: string;
  readonly plan: ImmutableActionPlan;
  readonly expiresAt: string;
}

export type ActionConfirmationDecision =
  | { readonly outcome: "accepted"; readonly reason: "user_accepted" }
  | {
      readonly outcome: "rejected";
      readonly reason: "user_rejected" | "timed_out" | "non_interactive" | "input_closed";
    }
  | { readonly outcome: "expired"; readonly reason: "candidate_expired" };

export interface ActionConfirmationPolicy {
  confirm(request: ActionConfirmationRequest): Promise<ActionConfirmationDecision>;
  close?(): Promise<void>;
}

/**
 * What a surface is allowed to tell the user about a pending action.
 *
 * Deliberately not the plan. `plan.arguments` carries the real payload — for a
 * search that is the user's selected text — and a surface has no business
 * rendering it. `summary` is built selection-free on purpose (see
 * `action-planner.ts`, which puts only the selection's *length* in it), so
 * handing a surface this projection rather than the plan makes "never render raw
 * selection text" a property of the type instead of a rule someone has to
 * remember.
 */
export interface ConfirmationPrompt {
  readonly candidateId: string;
  readonly kind: ImmutableActionPlan["kind"];
  /** Selection-free, human-readable description of what will run. */
  readonly summary: string;
  readonly expiresAt: string;
}

export function toConfirmationPrompt(request: ActionConfirmationRequest): ConfirmationPrompt {
  return {
    candidateId: request.candidateId,
    kind: request.plan.kind,
    summary: request.plan.summary,
    expiresAt: request.expiresAt,
  };
}

export type ConfirmationAnswer = "approved" | "declined";

/**
 * A place a human can be asked a yes/no question.
 *
 * The narrowest possible seam: a surface answers, and nothing else. It does not
 * decide timeouts, does not check expiry, does not serialize, and cannot
 * construct an `ActionConfirmationDecision`. All of that lives in
 * `SerialConfirmationPolicy`, which is why adding a second surface cannot
 * introduce a second interpretation of "fail closed".
 */
export interface ConfirmationSurface {
  readonly id: string;
  /**
   * Whether a human could answer right now. Checked per request, because
   * availability is not static — a terminal is a TTY or it is not, but a window
   * can be closed between two suggestions.
   */
  available(): boolean;
  /**
   * Asks, and resolves with what the human said.
   *
   * May reject; the engine converts a rejection into a refusal. May ignore
   * `signal` — the engine owns the deadline and settles without it, so a surface
   * that never cancels cannot wedge the dispatch loop.
   */
  ask(prompt: ConfirmationPrompt, signal: AbortSignal): Promise<ConfirmationAnswer>;
  close?(): Promise<void>;
}

export interface SerialConfirmationPolicyOptions {
  readonly surface: ConfirmationSurface;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

/**
 * The whole fail-closed matrix, once, for every surface.
 *
 * Every path that is not an explicit approval produces a refusal with a stable
 * reason, and the reasons are a closed union so a surface cannot invent an
 * outcome. The guarantees, in the order they are enforced:
 *
 * - **Serialized.** Prompts never overlap. Two dialogs racing for one claim is
 *   not a display bug: `admitAndClaim` is the linearization point, and the
 *   second dialog would be asking about a claim the first already took.
 * - **Expiry before asking.** A queued candidate is re-checked when its turn
 *   begins, not when it was enqueued.
 * - **Expiry distinguished from timeout.** A candidate that outlived its TTL is
 *   `expired`; a human who did not answer in time is `timed_out`. Collapsing
 *   them would hide whether the suggestion was too slow or the user was.
 * - **Unavailable surface refuses.** No TTY, no window, no display: refusal, not
 *   a silent hang and not an implicit yes.
 * - **A throwing surface refuses.** A crashed prompt is not consent.
 */
export class SerialConfirmationPolicy implements ActionConfirmationPolicy {
  private readonly surface: ConfirmationSurface;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private tail: Promise<void> = Promise.resolve();
  private activeController: AbortController | undefined;
  private closed = false;

  public constructor(options: SerialConfirmationPolicyOptions) {
    this.surface = options.surface;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.now = options.now ?? (() => new Date());

    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError("Confirmation timeout must be a positive integer number of milliseconds.");
    }
  }

  public get surfaceId(): string {
    return this.surface.id;
  }

  public confirm(request: ActionConfirmationRequest): Promise<ActionConfirmationDecision> {
    const decision = this.tail.then(
      () => this.confirmOne(request),
      () => this.confirmOne(request),
    );
    this.tail = decision.then(() => undefined, () => undefined);
    return decision;
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.activeController?.abort();
    await this.tail;
    await this.surface.close?.();
  }

  private async confirmOne(request: ActionConfirmationRequest): Promise<ActionConfirmationDecision> {
    if (this.closed) {
      return { outcome: "rejected", reason: "input_closed" };
    }
    const remainingMs = Date.parse(request.expiresAt) - this.now().getTime();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      return { outcome: "expired", reason: "candidate_expired" };
    }
    if (!this.surface.available()) {
      return { outcome: "rejected", reason: "non_interactive" };
    }

    const controller = new AbortController();
    this.activeController = controller;
    const deadlineMs = Math.min(this.timeoutMs, remainingMs);
    // Which clock ran out decides the reason, and it has to be decided before
    // the race: after the fact both deadlines have passed.
    const deadlineIsExpiry = remainingMs <= this.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answered = this.surface.ask(toConfirmationPrompt(request), controller.signal).then(
        (answer) => ({ kind: "answer" as const, answer }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const interrupted = new Promise<{ readonly kind: "interrupted" }>((resolve) => {
        const finish = () => resolve({ kind: "interrupted" });
        controller.signal.addEventListener("abort", finish, { once: true });
        timer = setTimeout(() => {
          controller.abort();
          finish();
        }, deadlineMs);
      });
      const result = await Promise.race([answered, interrupted]);
      if (result.kind === "interrupted") {
        if (this.closed) {
          return { outcome: "rejected", reason: "input_closed" };
        }
        return deadlineIsExpiry || this.now().getTime() >= Date.parse(request.expiresAt)
          ? { outcome: "expired", reason: "candidate_expired" }
          : { outcome: "rejected", reason: "timed_out" };
      }
      if (result.kind === "error") {
        if (isUnavailableSurfaceError(result.error)) {
          return { outcome: "rejected", reason: "input_closed" };
        }
        throw result.error;
      }
      return result.answer === "approved"
        ? { outcome: "accepted", reason: "user_accepted" }
        : { outcome: "rejected", reason: "user_rejected" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      if (this.activeController === controller) {
        this.activeController = undefined;
      }
    }
  }
}

/**
 * Whether a surface failure means "the human went away" rather than a defect.
 *
 * Both refuse. The distinction is whether the dispatcher sees a clean refusal or
 * a thrown error, and a vanished surface is an expected shutdown, not a bug to
 * propagate.
 */
export function isUnavailableSurfaceError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "AbortError" ||
    error.message.includes("readline was closed") ||
    error.message.includes("input stream") ||
    error.message.includes("surface closed")
  );
}
