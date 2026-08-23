import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import {
  SerialConfirmationPolicy,
  type ConfirmationAnswer,
  type ConfirmationPrompt,
  type ConfirmationSurface,
} from "./action-confirmation.js";

export interface TerminalConfirmationSurfaceOptions {
  readonly input?: Readable & { readonly isTTY?: boolean };
  readonly output?: Writable & { readonly isTTY?: boolean };
  /** Injected for deterministic tests; production uses Node's readline. */
  readonly prompt?: (message: string, signal: AbortSignal) => Promise<string>;
  /** Overrides TTY detection. Only tests should need this. */
  readonly interactive?: boolean;
}

/**
 * Asks on stdin/stderr, and does nothing else.
 *
 * Everything that used to live here — the serial queue, the deadline race, the
 * expiry-versus-timeout distinction — moved to `SerialConfirmationPolicy`. What
 * remains is the part that is genuinely about a terminal: reading a line, and
 * knowing whether there is a human attached to read it.
 */
export class TerminalConfirmationSurface implements ConfirmationSurface {
  public readonly id = "terminal";

  private readonly input: Readable & { readonly isTTY?: boolean };
  private readonly output: Writable & { readonly isTTY?: boolean };
  private readonly promptFn: (message: string, signal: AbortSignal) => Promise<string>;
  private readonly options: TerminalConfirmationSurfaceOptions;

  public constructor(options: TerminalConfirmationSurfaceOptions = {}) {
    this.options = options;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stderr;
    this.promptFn = options.prompt ?? ((message, signal) => this.readLine(message, signal));
  }

  public available(): boolean {
    // Read per call, never cached at construction. Availability is not static —
    // the contract says a window can close between two suggestions — and a
    // surface that froze this answer would report a vanished user as present.
    // A terminal happens to be stable, but the shape has to be right here
    // because the next surface will copy it.
    //
    // Without a TTY there is nobody to answer, and a pipe that never closes
    // would hold a claim until the deadline. Refusing immediately is both
    // faster and the only honest reading of "no user present".
    return this.options.interactive ?? this.input.isTTY === true;
  }

  public async ask(prompt: ConfirmationPrompt, signal: AbortSignal): Promise<ConfirmationAnswer> {
    const answer = await this.promptFn(
      `\nSquid wants to run this local command:\n  ${prompt.summary}\nApprove? [y/N] `,
      signal,
    );
    const normalized = answer.trim().toLowerCase();
    // Allowlist, not a denylist: anything unrecognized is a decline, so a
    // fat-fingered keypress cannot execute a command.
    return normalized === "y" || normalized === "yes" ? "approved" : "declined";
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

export interface TerminalActionConfirmationOptions extends TerminalConfirmationSurfaceOptions {
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

/**
 * The terminal surface behind the shared policy.
 *
 * A function rather than a subclass: there is exactly one confirmation engine,
 * and a surface composes with it instead of extending it. That is what keeps a
 * second surface from being able to override a fail-closed rule.
 */
export function createTerminalActionConfirmation(
  options: TerminalActionConfirmationOptions = {},
): SerialConfirmationPolicy {
  const { timeoutMs, now, ...surfaceOptions } = options;
  return new SerialConfirmationPolicy({
    surface: new TerminalConfirmationSurface(surfaceOptions),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(now === undefined ? {} : { now }),
  });
}
