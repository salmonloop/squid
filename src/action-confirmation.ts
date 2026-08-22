import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
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

export interface TerminalActionConfirmationOptions {
  readonly input?: Readable & { readonly isTTY?: boolean };
  readonly output?: Writable & { readonly isTTY?: boolean };
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  /** Injected for deterministic tests; production uses Node's readline. */
  readonly prompt?: (message: string, signal: AbortSignal) => Promise<string>;
  readonly interactive?: boolean;
}

/**
 * Serial terminal confirmation policy. Prompts never overlap, and queued
 * candidates are checked for expiry only when their turn begins.
 */
export class TerminalActionConfirmation implements ActionConfirmationPolicy {
  private readonly input: Readable & { readonly isTTY?: boolean };
  private readonly output: Writable & { readonly isTTY?: boolean };
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly prompt: (message: string, signal: AbortSignal) => Promise<string>;
  private readonly interactive: boolean;
  private tail: Promise<void> = Promise.resolve();
  private activeController: AbortController | undefined;
  private closed = false;

  public constructor(options: TerminalActionConfirmationOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stderr;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
    const inputIsInteractive = this.input.isTTY === true;
    this.interactive = options.interactive ?? inputIsInteractive;
    this.prompt = options.prompt ?? ((message, signal) => this.readLine(message, signal));

    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError("Confirmation timeout must be a positive integer number of milliseconds.");
    }
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
  }

  private async confirmOne(request: ActionConfirmationRequest): Promise<ActionConfirmationDecision> {
    if (this.closed) {
      return { outcome: "rejected", reason: "input_closed" };
    }
    const remainingMs = Date.parse(request.expiresAt) - this.now().getTime();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      return { outcome: "expired", reason: "candidate_expired" };
    }
    if (!this.interactive) {
      return { outcome: "rejected", reason: "non_interactive" };
    }

    const controller = new AbortController();
    this.activeController = controller;
    const deadlineMs = Math.min(this.timeoutMs, remainingMs);
    const deadlineIsExpiry = remainingMs <= this.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const promptResult = this.prompt(
        `\nSquid wants to run this local command:\n  ${request.plan.summary}\nApprove? [y/N] `,
        controller.signal,
      ).then(
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
      const result = await Promise.race([promptResult, interrupted]);
      if (result.kind === "interrupted") {
        if (this.closed) {
          return { outcome: "rejected", reason: "input_closed" };
        }
        return deadlineIsExpiry || this.now().getTime() >= Date.parse(request.expiresAt)
          ? { outcome: "expired", reason: "candidate_expired" }
          : { outcome: "rejected", reason: "timed_out" };
      }
      if (result.kind === "error") {
        if (isClosedInputError(result.error)) {
          return { outcome: "rejected", reason: "input_closed" };
        }
        throw result.error;
      }
      const normalized = result.answer.trim().toLowerCase();
      return normalized === "y" || normalized === "yes"
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

  private async readLine(message: string, signal: AbortSignal): Promise<string> {
    const interface_ = createInterface({ input: this.input, output: this.output });
    try {
      return await interface_.question(message, { signal });
    } finally {
      interface_.close();
    }
  }
}

function isClosedInputError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "AbortError" ||
    error.message.includes("readline was closed") ||
    error.message.includes("input stream")
  );
}
