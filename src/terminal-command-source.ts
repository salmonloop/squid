import type {
  ActivityEventEmitter,
  ActivitySource,
  ActivitySourceDiagnostic,
} from "./activity-source.js";
import { describeErrorForAudit } from "./action-egress.js";
import {
  createActivityEvent,
  type ActivityEvent,
  type TerminalCommandCompletedPayload,
} from "./protocol.js";

/**
 * One completed shell command, as a shell hook can report it.
 *
 * Note what is deliberately absent: the command text, its output, and its
 * working directory. `TerminalCommandCompletedPayload` carries only a class, a
 * success flag, and an exit code, and this frame does not widen that. A shell
 * command line is among the most sensitive text on a developer's machine — it
 * routinely contains tokens, connection strings, and production hostnames — and
 * capture is irreversible, so the raw line must not enter the timeline at all.
 *
 * `command` here is the *raw* line the hook observed. It exists so classification
 * can happen in one reviewed place rather than being reimplemented in every
 * shell integration, and it never survives `projectTerminalFrame`.
 */
export interface TerminalCommandFrame {
  /** The raw command line. Classified, then discarded — never emitted. */
  readonly command: string;
  readonly exitCode: number | null;
  /** ISO timestamp of completion. Defaults to delivery time when absent. */
  readonly occurredAt?: string;
}

export interface TerminalCommandReader {
  close(): void;
}

/**
 * Injection seam for a shell integration. Mirrors the other reader factories: the
 * backend pushes samples and errors and owns nothing else. A zsh `precmd` hook, a
 * bash `PROMPT_COMMAND`, and a fish event handler are each one implementation.
 */
export type TerminalCommandReaderFactory = (input: {
  onFrame: (frame: TerminalCommandFrame) => void;
  onError: (error: Error) => void;
}) => TerminalCommandReader;

export interface TerminalCommandActivitySourceOptions {
  readerFactory: TerminalCommandReaderFactory;
  sourceId?: string;
  /** Defaults to a fresh identity per instance; see the constructor. */
  sessionId?: string;
  onDiagnostic?: (diagnostic: ActivitySourceDiagnostic) => void;
}

type SourceLifecycle = "idle" | "started" | "stopped";

/**
 * Command classes this source will report, in match order.
 *
 * A closed vocabulary rather than "the first word of the command", because the
 * first word is user text: `./deploy-to-prod-acme-corp.sh` names a client, and
 * `psql postgres://user:pw@host/db` is a credential. A fixed list can leak
 * nothing it was not written to contain.
 *
 * The classes are the ones a *predictor* can act on differently. A failing test
 * run and a failing package install call for different responses; two different
 * linters do not, so both are `lint`.
 */
const COMMAND_CLASSES: readonly { readonly commandClass: string; readonly match: RegExp }[] = [
  { commandClass: "test", match: /^(?:bun\s+test|npm\s+(?:run\s+)?test|yarn\s+test|pnpm\s+test|pytest|cargo\s+test|go\s+test|jest|vitest|mocha)\b/u },
  { commandClass: "build", match: /^(?:bun\s+run\s+build|npm\s+run\s+build|yarn\s+build|pnpm\s+build|make|cargo\s+build|go\s+build|tsc)\b/u },
  { commandClass: "lint", match: /^(?:eslint|biome|ruff|clippy|golangci-lint|bun\s+run\s+lint|npm\s+run\s+lint)\b/u },
  { commandClass: "typecheck", match: /^(?:bun\s+run\s+typecheck|npm\s+run\s+typecheck|mypy|pyright)\b/u },
  { commandClass: "install", match: /^(?:bun\s+install|npm\s+(?:install|ci)|yarn\s+install|pnpm\s+install|pip\s+install|cargo\s+fetch|go\s+mod\s+download)\b/u },
  { commandClass: "vcs", match: /^(?:git|hg|svn|jj)\b/u },
  { commandClass: "container", match: /^(?:docker|podman|kubectl|helm)\b/u },
];

/** Reported when a command matches nothing above. Carries no user text. */
const UNCLASSIFIED = "other";

/**
 * Reduces a raw command line to one of a fixed set of classes.
 *
 * Exported so the vocabulary is testable directly, and so a future shell
 * integration classifies identically rather than inventing its own scheme.
 *
 * Leading whitespace and `env`-style prefixes are stripped first, since
 * `  VAR=1 bun test` is a test run. Variable *values* are not inspected: they
 * are user text, and this function's contract is that nothing it returns depends
 * on content outside the closed list.
 */
export function classifyCommand(command: string): string {
  if (typeof command !== "string") return UNCLASSIFIED;
  // Strip leading whitespace and any run of NAME=value assignments, which shells
  // allow before the command word.
  const normalized = command.replace(/^\s+/u, "").replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/u, "");
  for (const { commandClass, match } of COMMAND_CLASSES) {
    if (match.test(normalized)) return commandClass;
  }
  return UNCLASSIFIED;
}

/**
 * Projects a frame onto a payload, or refuses it.
 *
 * The raw command line stops here: only its class survives. `succeeded` is
 * derived from the exit code rather than trusted from the backend, so a hook
 * cannot report a failing command as successful.
 */
export function projectTerminalFrame(
  frame: TerminalCommandFrame,
): TerminalCommandCompletedPayload | null {
  if (typeof frame.command !== "string" || frame.command.trim().length === 0) return null;
  const exitCode = frame.exitCode;
  if (exitCode !== null && !Number.isSafeInteger(exitCode)) return null;
  return {
    commandClass: classifyCommand(frame.command),
    // A null exit code means the hook could not read one — a killed shell, a
    // backend that does not expose `$?`. Treating unknown as success would
    // silently suppress every `inspect_error` for that shell, so unknown counts
    // as failure: the conservative direction is to surface, not to hide.
    succeeded: exitCode === 0,
    exitCode,
  };
}

/**
 * Turns completed shell commands into `terminal_command_completed` events.
 *
 * This is the source `inspect_error` was blocked on: the predictor rule and the
 * reducer case both existed, but nothing emitted the event, so the kind could
 * never fire outside a fixture.
 *
 * Unlike the screen and browser sources there is no debounce and no dedupe. Two
 * identical failing commands are two facts, not a repeated observation of one —
 * running `bun test` twice and failing twice is exactly the situation a user
 * would want noticed the second time.
 */
export class TerminalCommandActivitySource implements ActivitySource {
  public readonly id: string;
  /** Part of this source's event identity, alongside `id`; see the constructor. */
  public readonly sessionId: string;

  private readonly readerFactory: TerminalCommandReaderFactory;
  private readonly onDiagnostic: ((diagnostic: ActivitySourceDiagnostic) => void) | undefined;
  private readonly recordedDiagnostics: ActivitySourceDiagnostic[] = [];

  private lifecycle: SourceLifecycle = "idle";
  private reader: TerminalCommandReader | null = null;
  private emit: ActivityEventEmitter | null = null;
  private deliveryTail: Promise<void> = Promise.resolve();
  private sequence = 0;

  public constructor(options: TerminalCommandActivitySourceOptions) {
    this.readerFactory = options.readerFactory;
    this.id = options.sourceId ?? "terminal-command-host";
    // `sequence` restarts at 0 for every instance, so the session must be the
    // part of the identity tuple that changes; see the other sources.
    this.sessionId = options.sessionId ?? `terminal-command-${crypto.randomUUID()}`;
    this.onDiagnostic = options.onDiagnostic;
  }

  public get diagnostics(): readonly ActivitySourceDiagnostic[] {
    return this.recordedDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  public async start(emit: ActivityEventEmitter): Promise<void> {
    if (this.lifecycle !== "idle") {
      throw new Error(
        `Terminal command source ${this.id} cannot start from lifecycle state ${this.lifecycle}.`,
      );
    }

    this.emit = emit;
    this.lifecycle = "started";
    try {
      this.reader = this.readerFactory({
        onFrame: (frame) => this.handleFrame(frame),
        onError: (error) => this.record("watcher_error", error),
      });
    } catch (error) {
      this.lifecycle = "idle";
      this.emit = null;
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.lifecycle !== "started") {
      this.lifecycle = "stopped";
      await this.deliveryTail;
      return;
    }
    this.lifecycle = "stopped";
    this.reader?.close();
    this.reader = null;
    await this.deliveryTail;
    this.emit = null;
  }

  private handleFrame(frame: TerminalCommandFrame): void {
    if (this.lifecycle !== "started") return;
    // Serialized, so per-source sequence stays monotonic under a burst.
    this.deliveryTail = this.deliveryTail.then(() => this.deliver(frame));
  }

  private async deliver(frame: TerminalCommandFrame): Promise<void> {
    const emit = this.emit;
    if (emit === null) return;

    let payload: TerminalCommandCompletedPayload | null;
    let occurredAt: string | undefined;
    try {
      payload = projectTerminalFrame(frame);
      occurredAt = frame.occurredAt;
    } catch (error) {
      // A backend pushing a non-object makes every field access throw. An
      // escaping throw would reject the shared delivery tail and kill every
      // later frame, and `stop()` with it.
      this.record("delivery_error", error);
      return;
    }
    if (payload === null) return;

    const event = createActivityEvent<TerminalCommandCompletedPayload>({
      kind: "terminal_command_completed",
      payload,
      source: { kind: "host", instanceId: this.id },
      sessionId: this.sessionId,
      sequence: this.sequence,
      ...(occurredAt === undefined ? {} : { occurredAt }),
    }) as ActivityEvent;

    try {
      await emit(event);
    } catch (error) {
      this.record("delivery_error", error);
      return;
    }
    this.sequence += 1;
  }

  private record(kind: ActivitySourceDiagnostic["kind"], error: unknown): void {
    const diagnostic: ActivitySourceDiagnostic = {
      kind,
      message: describeErrorForAudit(error),
      occurredAt: new Date().toISOString(),
    };
    this.recordedDiagnostics.push(diagnostic);
    this.onDiagnostic?.(diagnostic);
  }
}
