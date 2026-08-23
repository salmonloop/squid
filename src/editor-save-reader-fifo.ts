import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type {
  EditorSaveFrame,
  EditorSaveReaderFactory,
} from "./editor-save-source.js";

/**
 * Reads save reports an editor extension writes, one JSON object per line.
 *
 * A FIFO (or any append-only file) rather than a socket server, for the same
 * reason the terminal reader chose one: an integration must not sit between
 * the user and their editor. A crashed plugin-side writer costs one lost
 * report, not a broken editor; if nothing is reading, the write is dropped
 * and the editor never notices.
 *
 * Line protocol, one object per line:
 *
 * ```json
 * {"path":"/home/me/proj/src/a.ts","pid":12345}
 * ```
 *
 * `path` is absolute and `pid` is the *editor's* `process.pid` — the writer
 * speaking for itself. Nothing here invents or substitutes identity: a frame
 * whose pid is missing or malformed is refused by `projectEditorSaveFrame`
 * rather than repaired.
 *
 * A VS Code extension that feeds it, from `extension.js`:
 *
 * ```js
 * const fifo = process.env.SQUID_EDITOR_FIFO;
 * if (fifo) workspace.onDidSaveTextDocument((document) => {
 *   require("fs").appendFile(fifo, JSON.stringify({
 *     path: document.uri.fsPath,
 *     pid: process.pid,
 *   }) + "\n", () => undefined);
 * });
 * ```
 */
export interface FifoEditorSaveReaderOptions {
  /** Absolute path to the FIFO or append-only file editor extensions write. */
  readonly path: string;
  /** How often to check for new lines. Default 250ms. */
  readonly pollMs?: number;
}

const DEFAULT_POLL_MS = 250;

export function createFifoEditorSaveReader(
  options: FifoEditorSaveReaderOptions,
): EditorSaveReaderFactory {
  if (!isAbsolute(options.path)) {
    throw new Error("Editor save FIFO path must be absolute.");
  }
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  return ({ onFrame, onError }) => {
    let closed = false;
    let offset = 0;
    let carry = "";
    let reading = false;

    const readAvailable = async (): Promise<void> => {
      // One read at a time: a slow read must not interleave with the next tick
      // and reorder lines, since saves are inherently ordered.
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
        // A missing file is the normal state before the first extension writes,
        // so it is not worth reporting on every tick.
        if (!isMissingFile(error)) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
        reading = false;
        return;
      }

      // Re-checked after the awaits above; see the terminal reader for why a
      // close landing mid-read must not deliver afterwards.
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
        let frame: EditorSaveFrame;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (typeof parsed !== "object" || parsed === null) continue;
          const record = parsed as { path?: unknown; pid?: unknown; occurredAt?: unknown };
          if (typeof record.path !== "string") continue;
          frame = {
            path: record.path,
            pid: typeof record.pid === "number" ? record.pid : Number.NaN,
            ...(typeof record.occurredAt === "string" ? { occurredAt: record.occurredAt } : {}),
          };
        } catch {
          // A malformed line is one lost report, not a reason to stop reading.
          // The source records nothing here because the line never became a
          // frame — and its content names user files, so it must not reach a
          // diagnostic either.
          continue;
        }
        onFrame(frame);
      }
      reading = false;
    };

    const timer = setInterval(() => void readAvailable(), pollMs);
    // Read once immediately so a save reported before start is not delayed by
    // a whole poll interval.
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
