import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { CaptureGateFrame, CaptureGateReaderFactory } from "./capture-gate-source.js";

/**
 * Reads gate commands a control script appends, one JSON object per line.
 *
 * Same shape as the terminal and editor FIFOs on purpose: an append-only file
 * means the controlling process cannot wedge Squid — a crashed control script
 * costs one lost command, not a broken watcher. If nothing is reading, the
 * write blocks or drops and the writer moves on.
 *
 * Line protocol, one object per line:
 *
 * ```json
 * {"op":"pause"}
 * {"op":"resume"}
 * ```
 *
 * A shell alias feeds it directly:
 *
 * ```sh
 * squid-pause()  { echo '{"op":"pause"}'  >> "$SQUID_CONTROL_FIFO"; }
 * squid-resume() { echo '{"op":"resume"}' >> "$SQUID_CONTROL_FIFO"; }
 * ```
 *
 * Anything that is not exactly one of those two operations is refused here —
 * an unknown op must not be silently ignored, because the user believes they
 * toggled capture and silence would read as obedience. The refusal surfaces as
 * a diagnostic naming nothing but the line number.
 */
export interface FifoCaptureGateReaderOptions {
  /** Absolute path to the FIFO or append-only file a control script writes. */
  readonly path: string;
  /** How often to check for new lines. Default 250ms. */
  readonly pollMs?: number;
}

const DEFAULT_POLL_MS = 250;

export function createFifoCaptureGateReader(
  options: FifoCaptureGateReaderOptions,
): CaptureGateReaderFactory {
  if (!isAbsolute(options.path)) {
    throw new Error("Capture gate FIFO path must be absolute.");
  }
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  return ({ onFrame, onError }) => {
    let closed = false;
    let offset = 0;
    let carry = "";
    let reading = false;

    const readAvailable = async (): Promise<void> => {
      // One read at a time: pause/resume are ordered facts, and interleaved
      // reads could deliver a resume before the pause it follows.
      if (reading || closed) return;
      reading = true;
      try {
        const handle = await open(options.path, "r");
        try {
          const stats = await handle.stat();
          if (stats.size < offset) {
            // Truncated or replaced. Start over rather than reading from a
            // stale offset, which would slice mid-line and produce garbage.
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
        // A missing file is the normal state before anything has been written,
        // so it is not worth reporting on every tick.
        if (!isMissingFile(error)) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
        reading = false;
        return;
      }

      // Re-checked after the awaits above: a close landing mid-read must not
      // deliver afterwards.
      if (closed) {
        reading = false;
        return;
      }

      // Keep any trailing partial line for the next tick: a shell write is not
      // guaranteed atomic, so a half-written line must not be parsed.
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        let frame: CaptureGateFrame | null = null;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (
            typeof parsed === "object" && parsed !== null
            && "op" in parsed
            && (parsed as { op?: unknown }).op === "pause"
          ) {
            frame = { paused: true };
          } else if (
            typeof parsed === "object" && parsed !== null
            && "op" in parsed
            && (parsed as { op?: unknown }).op === "resume"
          ) {
            frame = { paused: false };
          }
        } catch {
          // Fall through to the diagnostic below with the frame still null.
        }
        if (frame !== null) {
          onFrame(frame);
        } else {
          onError(new Error(`Unrecognized capture-gate command at line ${offset}.`));
        }
      }
      reading = false;
    };

    const timer = setInterval(() => void readAvailable(), pollMs);
    // Read once immediately so a command written before start is honored
    // without waiting a whole poll interval.
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
