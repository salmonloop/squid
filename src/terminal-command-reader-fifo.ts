import { isAbsolute } from "node:path";
import type {
  TerminalCommandFrame,
  TerminalCommandReaderFactory,
} from "./terminal-command-source.js";
import { startFifoLineReader } from "./fifo-line-reader.js";

/**
 * Reads command completions a shell hook writes, one JSON object per line.
 *
 * A FIFO (or any append-only file) rather than a wrapper process, because a shell
 * integration must not sit between the user and their shell: a crashed wrapper
 * would take the terminal with it. The hook writes and moves on; if nothing is
 * reading, the write is lost and the shell is unaffected.
 *
 * Line protocol, one object per line:
 *
 * ```json
 * {"command":"bun test","exitCode":1}
 * ```
 *
 * `command` is classified and discarded by `projectTerminalFrame` — it never
 * reaches the timeline. That is why the hook may send the raw line at all:
 * classification happens in one reviewed place instead of being reimplemented in
 * every shell.
 *
 * A zsh hook that feeds it:
 *
 * ```zsh
 * squid_precmd() {
 *   local code=$?
 *   [[ -n $SQUID_LAST_COMMAND ]] || return
 *   printf '%s\n' "{\"command\":$(jq -Rn --arg c "$SQUID_LAST_COMMAND" '$c'),\"exitCode\":$code}" \
 *     >> "$SQUID_TERMINAL_FIFO" 2>/dev/null
 *   SQUID_LAST_COMMAND=
 * }
 * squid_preexec() { SQUID_LAST_COMMAND=$1 }
 * precmd_functions+=(squid_precmd)
 * preexec_functions+=(squid_preexec)
 * ```
 */
export interface FifoTerminalCommandReaderOptions {
  /** Absolute path to the FIFO or append-only file the shell hook writes. */
  readonly path: string;
  /** How often to check for new lines. Default 250ms. */
  readonly pollMs?: number;
}

export function createFifoTerminalCommandReader(
  options: FifoTerminalCommandReaderOptions,
): TerminalCommandReaderFactory {
  if (!isAbsolute(options.path)) {
    throw new Error("Terminal command FIFO path must be absolute.");
  }

  return ({ onFrame, onError }) =>
    startFifoLineReader({
      path: options.path,
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
      onLine: (line) => {
        let frame: TerminalCommandFrame;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (typeof parsed !== "object" || parsed === null) return;
          const record = parsed as { command?: unknown; exitCode?: unknown; occurredAt?: unknown };
          if (typeof record.command !== "string") return;
          frame = {
            command: record.command,
            exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
            ...(typeof record.occurredAt === "string" ? { occurredAt: record.occurredAt } : {}),
          };
        } catch {
          // A malformed line is one lost completion, not a reason to stop
          // reading. The source records nothing here because the line never
          // became a frame — and its content is a raw command, so it must not
          // reach a diagnostic either.
          return;
        }
        onFrame(frame);
      },
      onError,
    });
}
