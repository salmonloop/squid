import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describeErrorForAudit } from "./audit-text.js";
import { createMacosScreenTextReader } from "./screen-text-reader-macos.js";
import {
  createSyntheticScreenTextReader,
  demoScreenTextFrames,
} from "./screen-text-reader-synthetic.js";
import type { ScreenTextFrame, ScreenTextReaderFactory } from "./screen-text-source.js";

/**
 * Chooses a screen-text backend from the environment.
 *
 * Lives outside `screen-text-source.ts` on purpose: the adapter must not import
 * a backend, or a future OCR or Windows reader stops being one new factory and
 * zero adapter changes. Lives outside the entry points because more than one
 * needs it, and a second copy of this validation is a second place for
 * `SQUID_SCREEN_READER` to mean something slightly different.
 *
 * Every failure is a startup configuration error rather than a silent default:
 * a run that asked for the real accessibility reader and quietly replayed demo
 * frames instead looks identical to one that works.
 */
export type ScreenReaderResolution =
  | {
      readonly readerKind: "darwin" | "synthetic";
      readonly readerFactory: ScreenTextReaderFactory;
    }
  | { readonly configError: string };

export interface ResolveScreenReaderOptions {
  /** Path to a scripted frame file; the built-in demo is used when absent. */
  readonly framesPath?: string;
  readonly env?: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
}

export async function resolveScreenReader(
  options: ResolveScreenReaderOptions = {},
): Promise<ScreenReaderResolution> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const readerKind = env.SQUID_SCREEN_READER ?? "synthetic";
  if (readerKind !== "darwin" && readerKind !== "synthetic") {
    return { configError: 'SQUID_SCREEN_READER must be "darwin" or "synthetic".' };
  }
  if (readerKind === "darwin" && platform !== "darwin") {
    return {
      configError:
        `SQUID_SCREEN_READER=darwin requires macOS; this host reports ${platform}.`,
    };
  }

  // One knob for both backends: how often the reader produces a frame.
  const rawPollMs = env.SQUID_SCREEN_POLL_MS;
  const pollMs = rawPollMs === undefined ? undefined : Number(rawPollMs);
  if (pollMs !== undefined && (!Number.isSafeInteger(pollMs) || pollMs <= 0)) {
    return {
      configError: "SQUID_SCREEN_POLL_MS must be a positive integer number of milliseconds.",
    };
  }

  if (readerKind === "darwin") {
    return {
      readerKind,
      readerFactory: createMacosScreenTextReader(pollMs === undefined ? {} : { pollMs }),
    };
  }

  const frames = await loadFrames(options.framesPath);
  if ("configError" in frames) return frames;
  return {
    readerKind,
    readerFactory: createSyntheticScreenTextReader({
      frames: frames.frames,
      ...(pollMs === undefined ? {} : { intervalMs: pollMs }),
    }),
  };
}

/**
 * Reads a scripted frame list, or falls back to the built-in demo so a screen
 * watch needs no arguments. Only the array shape is checked here; a malformed
 * frame is rejected later by protocol validation, which the source reports as a
 * delivery diagnostic rather than a crash.
 */
async function loadFrames(
  path: string | undefined,
): Promise<{ readonly frames: readonly ScreenTextFrame[] } | { readonly configError: string }> {
  if (path === undefined) return { frames: demoScreenTextFrames };

  const absolutePath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    return {
      configError: `Could not read frames from ${absolutePath}: ${describeErrorForAudit(error)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return { configError: `Frames file ${absolutePath} must contain a JSON array of frames.` };
  }
  return { frames: parsed as readonly ScreenTextFrame[] };
}
