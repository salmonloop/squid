import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describeErrorForAudit } from "./action-egress.js";
import type { BrowserPageFrame, BrowserPageReaderFactory } from "./browser-page-source.js";
import {
  createSyntheticBrowserPageReader,
  demoBrowserPageFrames,
} from "./browser-page-reader-synthetic.js";

/**
 * Chooses a browser backend from the environment.
 *
 * Unlike the screen reader, the default here is **off**. Observing a browser is
 * a distinct capability from watching files or the foreground window: it is what
 * makes `search_selection` reachable, and search is the one action that sends
 * user text off the machine. A run gets browser observation because it asked for
 * it, not because it started a watch.
 *
 * `SQUID_BROWSER` has exactly three outcomes, matching `SQUID_SEARCH_EGRESS`:
 * unset means no browser source, the exact string `synthetic` replays scripted
 * frames, and anything else is a startup configuration error. Note that observing
 * a page still does not permit egress — `SQUID_SEARCH_EGRESS=allow` is a separate
 * decision, and both are required before a search can run.
 */
export type BrowserReaderResolution =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly readerKind: "synthetic";
      readonly readerFactory: BrowserPageReaderFactory;
    }
  | { readonly configError: string };

export interface ResolveBrowserReaderOptions {
  /** Path to a scripted frame file; the built-in demo is used when absent. */
  readonly framesPath?: string;
  readonly env?: Record<string, string | undefined>;
}

export async function resolveBrowserReader(
  options: ResolveBrowserReaderOptions = {},
): Promise<BrowserReaderResolution> {
  const env = options.env ?? process.env;
  const kind = env.SQUID_BROWSER;
  if (kind === undefined) return { enabled: false };
  if (kind !== "synthetic") {
    return {
      configError: 'SQUID_BROWSER must be unset (off) or exactly "synthetic".',
    };
  }

  const rawPollMs = env.SQUID_BROWSER_POLL_MS;
  const pollMs = rawPollMs === undefined ? undefined : Number(rawPollMs);
  if (pollMs !== undefined && (!Number.isSafeInteger(pollMs) || pollMs <= 0)) {
    return {
      configError: "SQUID_BROWSER_POLL_MS must be a positive integer number of milliseconds.",
    };
  }

  const frames = await loadFrames(options.framesPath);
  if ("configError" in frames) return frames;
  return {
    enabled: true,
    readerKind: "synthetic",
    readerFactory: createSyntheticBrowserPageReader({
      frames: frames.frames,
      // The built-in demo loops; a caller-supplied script plays once.
      //
      // Two independent readers on independent timers have no guaranteed
      // interleaving, and a page observed while an earlier window is still in
      // front is correctly discarded. Looping gives the demo further passes, so
      // what a reader sees is eventually a page observed under the window that
      // owns it. A scripted file is someone's deliberate sequence and replaying
      // it forever would misrepresent what they asked to happen.
      ...(options.framesPath === undefined ? { loop: true } : {}),
      ...(pollMs === undefined ? {} : { intervalMs: pollMs }),
    }),
  };
}

/**
 * Reads a scripted page list, or falls back to the built-in demo. Only the array
 * shape is checked here; a frame whose URL yields no host is refused later by
 * `projectBrowserFrame`, which drops it rather than crashing the source.
 */
async function loadFrames(
  path: string | undefined,
): Promise<{ readonly frames: readonly BrowserPageFrame[] } | { readonly configError: string }> {
  if (path === undefined) return { frames: demoBrowserPageFrames };

  const absolutePath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    return {
      configError:
        `Could not read browser frames from ${absolutePath}: ${describeErrorForAudit(error)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      configError: `Browser frames file ${absolutePath} must contain a JSON array of frames.`,
    };
  }
  return { frames: parsed as readonly BrowserPageFrame[] };
}
