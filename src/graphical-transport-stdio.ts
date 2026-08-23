import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ConfirmationAnswer } from "./action-confirmation.js";
import type { GraphicalPromptPayload, GraphicalTransport } from "./confirmation-surface-graphical.js";

/**
 * Spawns the Rust UI binary and talks a line-delimited JSON protocol over its
 * stdin/stdout — the same wire shape the MCP stdio transport already uses in
 * `watch-actions.ts`, so a reader of this repo sees one cross-process pattern.
 *
 * One prompt in, one answer out:
 *
 * ```jsonc
 * // TS → UI (one line on stdin)
 * {"type":"prompt","candidateId":"...","kind":"run_tests","summary":"bun test","expiresAt":"2030-..."}
 * // UI → TS (one line on stdout)
 * {"answer":"approved"}   // or {"answer":"declined"}
 * ```
 *
 * The process stays alive across asks: respawning per prompt would flash the
 * window and add latency. `SerialConfirmationPolicy` serializes asks, so there
 * is at most one pending answer at a time — one pending slot, not a queue.
 *
 * Any departure — process exit, spawn failure, garbage on stdout — is a
 * `"surface closed"` rejection, which the engine maps to `input_closed`. A
 * crashed window is never consent, and a line that is not exactly `"approved"`
 * or `"declined"` is not an answer.
 */
export interface StdioGraphicalTransportOptions {
  /** Executable to spawn (the compiled Rust binary in production). */
  readonly command: string;
  readonly args?: readonly string[];
}

const SURFACE_CLOSED = "graphical UI surface closed";

export function createStdioGraphicalTransport(
  options: StdioGraphicalTransportOptions,
): GraphicalTransport {
  let child: ChildProcess | undefined;
  let closed = false;
  let pending: {
    readonly resolve: (answer: ConfirmationAnswer) => void;
    readonly reject: (error: Error) => void;
  } | undefined;

  // Two setters, not one with optional fields: `exactOptionalPropertyTypes`
  // forbids passing `undefined` where a property is merely absent, and an
  // answer that might be `undefined` is exactly that case. Keeping the two
  // outcomes as separate functions is also more honest — a resolved ask and a
  // rejected ask are different things, and conflating them into one struct
  // would let a caller hand both an answer and an error.
  const settleAnswer = (answer: ConfirmationAnswer) => {
    if (pending === undefined) return;
    const { resolve } = pending;
    pending = undefined;
    resolve(answer);
  };

  const settleError = (error: Error) => {
    if (pending === undefined) return;
    const { reject } = pending;
    pending = undefined;
    reject(error);
  };

  const ensureChild = (): ChildProcess => {
    if (child !== undefined) return child;
    const spawned = spawn(options.command, [...(options.args ?? [])], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    child = spawned;

    // stderr inherits so a panicking UI is visible to the operator, not silent.
    // stdout is the answer channel; a line on it settles the pending ask.
    if (spawned.stdout !== null) {
      const lines = createInterface({ input: spawned.stdout });
      lines.on("line", (line) => {
        const answer = parseAnswer(line);
        if (answer !== undefined) {
          settleAnswer(answer);
        } else {
          settleError(new Error(`${SURFACE_CLOSED}: unrecognized answer`));
        }
      });
    }

    spawned.on("exit", () => {
      closed = true;
      settleError(new Error(`${SURFACE_CLOSED}: process exited`));
    });
    spawned.on("error", (error: NodeJS.ErrnoException) => {
      closed = true;
      // ENOENT is the common case: the binary is not installed. A missing UI is
      // a closed surface, not a crash worth a stack trace.
      settleError(new Error(`${SURFACE_CLOSED}: ${error.code ?? "spawn failed"}`));
    });

    return spawned;
  };

  return {
    available: () => !closed,
    ask: async (payload, _signal) => {
      if (closed) {
        throw new Error(SURFACE_CLOSED);
      }
      const process = ensureChild();
      return new Promise<ConfirmationAnswer>((resolve, reject) => {
        pending = { resolve, reject };
        // Set the pending slot before writing so a synchronous exit cannot lose
        // the answer: the exit handler settles whatever is pending, even if the
        // write itself was the last thing the process saw.
        const line = `${JSON.stringify({ type: "prompt", ...payload })}\n`;
        process.stdin?.write(line, (error) => {
          if (error !== undefined && error !== null && pending !== undefined) {
            settleError(new Error(`${SURFACE_CLOSED}: write failed`));
          }
        });
      });
    },
    close: async () => {
      closed = true;
      settleError(new Error(SURFACE_CLOSED));
      if (child !== undefined) {
        child.stdin?.end();
        child.kill();
      }
    },
  };
}

/**
 * Parses one stdout line into an answer. Returns `undefined` for anything that
 * is not exactly `{"answer":"approved"}` or `{"answer":"declined"}` — a garbage
 * line is not a decline and not a hang, it is a broken surface, which the caller
 * turns into `input_closed`.
 */
function parseAnswer(line: string): ConfirmationAnswer | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    typeof parsed === "object" && parsed !== null
    && "answer" in parsed
  ) {
    const answer = (parsed as { answer?: unknown }).answer;
    if (answer === "approved" || answer === "declined") {
      return answer;
    }
  }
  return undefined;
}
