import { appendFile } from "node:fs/promises";

/**
 * The panel's write end of the capture-gate command path.
 *
 * Pause and resume from the panel do **not** mutate capture state directly.
 * They append one line to the same append-only command path that
 * `capture-gate-reader-fifo.ts` already tails, for two reasons:
 *
 * - **One control path, not two.** A shell alias, a keybinding, and the panel
 *   all say the same thing the same way. A second path would need its own
 *   ordering, its own refusal rules, and its own tests, and the two would drift.
 * - **A pause has to leave a trace.** Routed through the reader, the command
 *   becomes a `capture_gate_changed` event in the timeline via
 *   `CaptureGateActivitySource`. That event is what distinguishes a deliberate
 *   gap from an idle machine; a panel that flipped a boolean in memory would
 *   silence the sensors and leave later analysis reading the gap wrong.
 *
 * The format is fixed by the reader, not by this module — one JSON object per
 * line, `{"op":"pause"}` or `{"op":"resume"}`. Anything else is refused there
 * as an unrecognized command, so there is no room to improvise here.
 *
 * `commandPath` is the already-resolved `SQUID_CONTROL_FIFO` value.
 * `resolveCaptureGate` has validated that it is absolute, so this module does
 * not re-check: the path is validated once, where it enters the process.
 */

/** The only two commands the gate reader accepts. */
export type GateCommandOp = "pause" | "resume";

/**
 * Appends exactly one gate command line to the capture-gate command path.
 *
 * Append, never truncate: another process is tailing this file by byte offset,
 * and rewriting it would either replay every earlier command or make the reader
 * slice mid-line. A failed append rejects rather than reporting success — the
 * user pressed pause and is owed the truth about whether it was delivered.
 */
export async function appendGateCommand(
  commandPath: string,
  op: GateCommandOp,
): Promise<void> {
  // One write of one complete line. A FIFO or append-only file gives no
  // atomicity guarantee across writes, so the newline must ride along with the
  // object rather than arriving as a second call the reader could interleave.
  await appendFile(commandPath, `${JSON.stringify({ op })}\n`, "utf8");
}
