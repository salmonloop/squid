import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ConfirmationAnswer } from "./action-confirmation.js";
import type { GraphicalPromptPayload, GraphicalTransport } from "./confirmation-surface-graphical.js";

/**
 * Spawns the Rust UI binary and talks a line-delimited JSON protocol over its
 * stdin/stdout — the same wire shape the MCP stdio transport already uses in
 * `watch-actions.ts`, so a reader of this repo sees one cross-process pattern.
 *
 * Every prompt carries a monotonic `promptId`, and an answer is only accepted
 * when it names the same one:
 *
 * ```jsonc
 * // TS → UI (one line on stdin)
 * {"type":"prompt","promptId":1,"candidateId":"...","kind":"run_tests","summary":"bun test","expiresAt":"2030-..."}
 * // UI → TS (one line on stdout)
 * {"promptId":1,"answer":"approved"}   // or "declined"
 * // TS → UI, when the engine gives up on that prompt
 * {"type":"cancel","promptId":1}
 * ```
 *
 * The id is not ceremony. `SerialConfirmationPolicy` aborts a prompt on timeout
 * or expiry and moves straight to the next candidate, so an answer can arrive
 * *after* this side stopped waiting for it. Without correlation that late reply
 * would settle the following ask — the user clicking "approve" on a question
 * about one plan would authorize a different one. An id mismatch is dropped.
 *
 * The process stays alive across asks: respawning per prompt would flash the
 * window and add latency. The engine serializes asks, so there is at most one
 * pending answer at a time — one slot, not a queue.
 *
 * `cancel` is what keeps the window honest. The abort that ends the wait on this
 * side has to reach the UI too, or an abandoned dialog stays on screen inviting
 * a click nobody will read.
 *
 * Any departure — process exit, spawn failure, an abort, garbage on stdout — is
 * a `"surface closed"` rejection, which the engine maps to `input_closed`. A
 * crashed window is never consent, and a line that is not exactly an
 * `"approved"` or `"declined"` answer for a known id is not an answer.
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
    /**
     * Which ask this slot belongs to. A late answer to an abandoned prompt must
     * never settle the next one: the engine aborts on timeout and moves straight
     * to the following candidate, so without correlation the UI answering the
     * *previous* question would read as consent for a different plan.
     */
    readonly promptId: number;
    readonly resolve: (answer: ConfirmationAnswer) => void;
    readonly reject: (error: Error) => void;
  } | undefined;
  let lastPromptId = 0;

  // Two setters, not one with optional fields: `exactOptionalPropertyTypes`
  // forbids passing `undefined` where a property is merely absent, and an
  // answer that might be `undefined` is exactly that case. Keeping the two
  // outcomes as separate functions is also more honest — a resolved ask and a
  // rejected ask are different things, and conflating them into one struct
  // would let a caller hand both an answer and an error.
  //
  // An answer settles the pending ask only when its `promptId` matches. A reply
  // carrying any other id belongs to a prompt this side has already abandoned,
  // and is dropped rather than applied to whatever is pending now.
  const settleAnswer = (promptId: number, answer: ConfirmationAnswer) => {
    if (pending === undefined || pending.promptId !== promptId) return;
    const { resolve } = pending;
    pending = undefined;
    resolve(answer);
  };

  // Channel-level failures — process exit, spawn failure, close — settle
  // whatever ask is outstanding: the channel is gone regardless of which prompt
  // happened to be on it, so they pass no id.
  //
  // Failures belonging to one prompt (its abort, its failed write) pass that
  // prompt's id, so a late failure cannot reject the ask that replaced it.
  const settleError = (error: Error, promptId?: number) => {
    if (pending === undefined) return;
    if (promptId !== undefined && pending.promptId !== promptId) return;
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
        const reply = parseReply(line);
        if (reply === undefined) {
          settleError(new Error(`${SURFACE_CLOSED}: unrecognized answer`));
          return;
        }
        settleAnswer(reply.promptId, reply.answer);
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
    ask: async (payload, signal) => {
      if (closed) {
        throw new Error(SURFACE_CLOSED);
      }
      if (signal.aborted) {
        throw new Error(`${SURFACE_CLOSED}: aborted before prompting`);
      }
      const spawned = ensureChild();
      const promptId = ++lastPromptId;
      let detach = () => {};
      const answered = new Promise<ConfirmationAnswer>((resolve, reject) => {
        // Set the pending slot before writing so a synchronous exit cannot lose
        // the answer: the exit handler settles whatever is pending, even if the
        // write itself was the last thing the process saw.
        pending = { promptId, resolve, reject };

        // The engine aborts on timeout, on expiry, and on shutdown. Without
        // this the window would stay on screen for a question nobody is
        // waiting for, and this promise would never settle. `cancel` carries
        // the id so the UI closes that prompt rather than whatever it happens
        // to be showing.
        const onAbort = () => {
          spawned.stdin?.write(`${JSON.stringify({ type: "cancel", promptId })}\n`);
          settleError(new Error(`${SURFACE_CLOSED}: aborted`), promptId);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        detach = () => signal.removeEventListener("abort", onAbort);

        const line = `${JSON.stringify({ type: "prompt", promptId, ...payload })}\n`;
        spawned.stdin?.write(line, (error) => {
          if (error !== undefined && error !== null) {
            settleError(new Error(`${SURFACE_CLOSED}: write failed`), promptId);
          }
        });
      });
      // The listener holds this promise's settlers alive; one engine-owned
      // signal can outlive several asks, so each ask removes its own.
      return answered.finally(() => detach());
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
 * Parses one stdout line into a correlated reply. Returns `undefined` for
 * anything that is not exactly
 * `{"promptId":<integer>,"answer":"approved"|"declined"}`.
 *
 * A garbage line is not a decline and not a hang, it is a broken surface, which
 * the caller turns into `input_closed`. The id is required rather than optional:
 * an uncorrelated answer cannot be attributed to a plan, and attributing it to
 * the wrong one is the failure this whole mechanism exists to prevent.
 */
function parseReply(
  line: string,
): { readonly promptId: number; readonly answer: ConfirmationAnswer } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const { promptId, answer } = parsed as {
    readonly promptId?: unknown;
    readonly answer?: unknown;
  };
  if (!Number.isSafeInteger(promptId)) {
    return undefined;
  }
  if (answer !== "approved" && answer !== "declined") {
    return undefined;
  }
  return { promptId: promptId as number, answer };
}
