import { isAbsolute } from "node:path";
import { parsePipeEndpoint } from "./endpoint-transport.js";
import { createFifoEditorSaveReader } from "./editor-save-reader-fifo.js";
import type {
  EditorSaveReaderFactory,
} from "./editor-save-source.js";

/**
 * Chooses an editor-save backend from the environment.
 *
 * Off by default, like every capability variable here. An editor reporting its
 * own saves is the strongest ownership claim in the system — it is what makes
 * `run_tests` admissible on a save alone — so a run gets that strength by
 * asking for it, not by default.
 *
 * `SQUID_EDITOR_SAVES` has three outcomes, matching the other capability
 * variables: unset means no editor source, exactly `fifo` reads the path in
 * `SQUID_EDITOR_FIFO`, and anything else is a startup configuration error.
 */
export type EditorSaveReaderResolution =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly readerKind: "file" | "pipe";
      readonly readerFactory: EditorSaveReaderFactory;
    }
  | { readonly configError: string };

export interface ResolveEditorSaveReaderOptions {
  readonly env?: Record<string, string | undefined>;
}

export function resolveEditorSaveReader(
  options: ResolveEditorSaveReaderOptions = {},
): EditorSaveReaderResolution {
  const env = options.env ?? process.env;
  const kind = env.SQUID_EDITOR_SAVES;
  if (kind === undefined) return { enabled: false };
  if (kind !== "fifo") {
    return { configError: 'SQUID_EDITOR_SAVES must be unset (off) or exactly "fifo".' };
  }

  const path = env.SQUID_EDITOR_FIFO;
  if (path === undefined || path.length === 0) {
    return {
      configError: "SQUID_EDITOR_SAVES=fifo requires SQUID_EDITOR_FIFO to name a path.",
    };
  }
  const pipeEndpoint = parsePipeEndpoint(path);
  if (pipeEndpoint === undefined && !isAbsolute(path)) {
    return { configError: "SQUID_EDITOR_FIFO must be an absolute path or a named pipe (\\\\.\\pipe\\<name>)." };
  }

  const rawPollMs = env.SQUID_EDITOR_POLL_MS;
  const pollMs = rawPollMs === undefined ? undefined : Number(rawPollMs);
  if (pollMs !== undefined && (!Number.isSafeInteger(pollMs) || pollMs <= 0)) {
    return {
      configError: "SQUID_EDITOR_POLL_MS must be a positive integer number of milliseconds.",
    };
  }

  return {
    enabled: true,
    readerKind: pipeEndpoint === undefined ? "file" : "pipe",
    readerFactory: createFifoEditorSaveReader({
      path,
      ...(pollMs === undefined ? {} : { pollMs }),
    }),
  };
}
