/**
 * A proposed operation's confirmation-safe projection.
 *
 * This deliberately has no dependency on the retired action-planning layer. A
 * future execution seam supplies this small shape; the confirmation machinery
 * neither receives nor displays arguments, selections, or tool payloads.
 */
export interface ActionConfirmationRequest {
  readonly candidateId: string;
  readonly kind: string;
  readonly summary: string;
  readonly why: string;
  readonly denyConsequence: string;
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

/** The only data a confirmation surface may render. */
export interface ConfirmationPrompt {
  readonly candidateId: string;
  readonly kind: string;
  readonly summary: string;
  readonly why: string;
  readonly denyConsequence: string;
  readonly expiresAt: string;
}

export function toConfirmationPrompt(request: ActionConfirmationRequest): ConfirmationPrompt {
  const { candidateId, kind, summary, why, denyConsequence, expiresAt } = request;
  return { candidateId, kind, summary, why, denyConsequence, expiresAt };
}

export type ConfirmationAnswer = "approved" | "declined";

/** A human-facing transport. Deadlines and fail-closed interpretation stay in the policy. */
export interface ConfirmationSurface {
  readonly id: string;
  available(): boolean;
  ask(prompt: ConfirmationPrompt, signal: AbortSignal): Promise<ConfirmationAnswer>;
  close?(): Promise<void>;
}

export interface SerialConfirmationPolicyOptions {
  readonly surface: ConfirmationSurface;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

/**
 * One authoritative, serial, fail-closed confirmation engine.
 *
 * It is intentionally not wired to Pi tools today: Squid's custom tools are
 * read-only and Pi owns sandbox safety. This is the tested UI seam for a future
 * real execution boundary, not a claim that panel answers gate agent actions.
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

  public get surfaceId(): string { return this.surface.id; }

  public confirm(request: ActionConfirmationRequest): Promise<ActionConfirmationDecision> {
    const decision = this.tail.then(() => this.confirmOne(request), () => this.confirmOne(request));
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
    if (this.closed) return { outcome: "rejected", reason: "input_closed" };
    const expiresAt = Date.parse(request.expiresAt);
    const remainingMs = expiresAt - this.now().getTime();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return { outcome: "expired", reason: "candidate_expired" };
    if (!this.surface.available()) return { outcome: "rejected", reason: "non_interactive" };

    const controller = new AbortController();
    this.activeController = controller;
    const deadlineMs = Math.min(this.timeoutMs, remainingMs);
    const deadlineIsExpiry = remainingMs <= this.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answered = this.surface.ask(toConfirmationPrompt(request), controller.signal).then(
        (answer) => ({ kind: "answer" as const, answer }),
        () => ({ kind: "error" as const }),
      );
      const interrupted = new Promise<{ readonly kind: "interrupted" }>((resolve) => {
        const finish = () => resolve({ kind: "interrupted" });
        controller.signal.addEventListener("abort", finish, { once: true });
        timer = setTimeout(() => { controller.abort(); finish(); }, deadlineMs);
      });
      const result = await Promise.race([answered, interrupted]);
      if (result.kind === "interrupted") {
        if (this.closed) return { outcome: "rejected", reason: "input_closed" };
        return deadlineIsExpiry || this.now().getTime() >= expiresAt
          ? { outcome: "expired", reason: "candidate_expired" }
          : { outcome: "rejected", reason: "timed_out" };
      }
      if (result.kind === "error") return { outcome: "rejected", reason: "input_closed" };
      return result.answer === "approved"
        ? { outcome: "accepted", reason: "user_accepted" }
        : { outcome: "rejected", reason: "user_rejected" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      if (this.activeController === controller) this.activeController = undefined;
    }
  }
}

export function isUnavailableSurfaceError(_error: unknown): boolean {
  // Kept as a compatibility predicate for surfaces that classify their own
  // shutdown errors. The policy itself now fail-closes every surface failure.
  return true;
}
