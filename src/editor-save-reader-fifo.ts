import { isAbsolute } from "node:path";
import type {
  EditorSaveFrame,
  EditorSaveReaderFactory,
} from "./editor-save-source.js";
import { parsePipeEndpoint, startEndpointLineReader } from "./endpoint-transport.js";

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
 * A starting point for a VS Code extension that feeds it, from `extension.js`.
 * This is a fragment to build from, not a plugin: no packaged extension ships in
 * this repository, and `SQUID_EDITOR_FIFO` has to be set in the *editor's* own
 * environment for the first line to resolve.
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
 *
 * One assumption in that snippet is unverified against a real editor, and it is
 * the assumption the whole pairing rests on. `admitRunTests` compares the
 * reported pid against the foreground application's id by strict equality, and
 * on macOS that id is the *frontmost application process* pid. A VS Code
 * extension runs in a separate extension-host process, so its `process.pid` may
 * not be that pid. If the two differ the equality refuses — the failure is safe
 * and the contract holds — but the snippet would then need to report the pid of
 * the window rather than of the host it runs in. Verify against a real install
 * before trusting it; nothing offline can establish this.
 */
export interface FifoEditorSaveReaderOptions {
  /** Absolute path to the FIFO or append-only file editor extensions write. */
  readonly path: string;
  /** How often to check for new lines. Default 250ms. */
  readonly pollMs?: number;
}

export function createFifoEditorSaveReader(
  options: FifoEditorSaveReaderOptions,
): EditorSaveReaderFactory {
  if (parsePipeEndpoint(options.path) === undefined && !isAbsolute(options.path)) {
    throw new Error("Editor save FIFO path must be an absolute path or a named pipe (\\\\.\\pipe\\<name>).");
  }

  return ({ onFrame, onError }) =>
    startEndpointLineReader({
      path: options.path,
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
      onLine: (line) => {
        let frame: EditorSaveFrame;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (typeof parsed !== "object" || parsed === null) return;
          const record = parsed as { path?: unknown; pid?: unknown; occurredAt?: unknown };
          if (typeof record.path !== "string") return;
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
          return;
        }
        onFrame(frame);
      },
      onError,
    });
}
