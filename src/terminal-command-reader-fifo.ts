import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type {
  TerminalCommandFrame,
  TerminalCommandReaderFactory,
} from "./terminal-command-source.js";

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

const DEFAULT_POLL_MS = 250;

export function createFifoTerminalCommandReader(
  options: FifoTerminalCommandReaderOptions,
): TerminalCommandReaderFactory {
  if (!isAbsolute(options.path)) {
    throw new Error("Terminal command FIFO path must be absolute.");
  }
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  return ({ onFrame, onError }) => {
    let closed = false;
    let offset = 0;
    let carry = "";
    let reading = false;

    const readAvailable = async (): Promise<void> => {
      // One read at a time: a slow read must not interleave with the next tick
      // and reorder lines, since a shell's completions are inherently ordered.
      if (reading || closed) return;
      reading = true;
      try {
        const handle = await open(options.path, "r");
        try {
          const stats = await handle.stat();
          if (stats.size < offset) {
            // Truncated or replaced. Start over rather than reading from a stale
            // offset, which would slice mid-line and produce garbage.
            offset = 0;
            carry = "";
          }
          if (stats.size > offset) {
            const length = stats.size - offset;
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            offset += bytesRead;
            carry += buffer.subarray(0, bytesRead).toString("utf8");
          }
        } finally {
          await handle.close();
        }
      } catch (error) {
        // A missing file is the normal state before the first shell writes, so it
        // is not worth reporting on every tick.
        if (!isMissingFile(error)) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
        reading = false;
        return;
      }

      // Re-checked after the awaits above. `close()` can land while a read is in
      // flight, and delivering a frame afterwards would push an event into a
      // source that has already stopped — which then discards it on its own
      // lifecycle guard, but only after the sequence and the offset have moved.
      if (closed) {
        reading = false;
        return;
      }

      // Keep any trailing partial line for the next tick: a hook's write is not
      // guaranteed atomic, so a half-written line must not be parsed.
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        let frame: TerminalCommandFrame;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (typeof parsed !== "object" || parsed === null) continue;
          const record = parsed as { command?: unknown; exitCode?: unknown; occurredAt?: unknown };
          if (typeof record.command !== "string") continue;
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
          continue;
        }
        onFrame(frame);
      }
      reading = false;
    };

    const timer = setInterval(() => void readAvailable(), pollMs);
    // Read once immediately so a completion written before start is not delayed
    // by a whole poll interval.
    void readAvailable();

    return {
      close: () => {
        closed = true;
        clearInterval(timer);
      },
    };
  };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
