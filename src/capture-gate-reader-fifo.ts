import { isAbsolute } from "node:path";
import type { CaptureGateFrame, CaptureGateReaderFactory } from "./capture-gate-source.js";
import { parsePipeEndpoint, startEndpointLineReader } from "./endpoint-transport.js";

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

export function createFifoCaptureGateReader(
  options: FifoCaptureGateReaderOptions,
): CaptureGateReaderFactory {
  if (parsePipeEndpoint(options.path) === undefined && !isAbsolute(options.path)) {
    throw new Error("Capture gate FIFO path must be an absolute path or a named pipe (\\\\.\\pipe\\<name>).");
  }
  return ({ onFrame, onError }) =>
    startEndpointLineReader({
      path: options.path,
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
      onLine: (line) => {
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
          // An unknown op must not be silently ignored: the user believes
          // they toggled capture, and silence would read as obedience. The
          // diagnostic names nothing but the line itself, which never reached
          // a frame.
          onError(new Error("Unrecognized capture-gate command."));
        }
      },
      onError,
    });
}

