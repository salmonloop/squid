import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describeErrorForAudit } from "./audit-text.js";
import { createLinuxScreenTextReader } from "./screen-text-reader-linux.js";
import { createMacosScreenTextReader } from "./screen-text-reader-macos.js";
import { createWindowsScreenTextReader } from "./screen-text-reader-windows.js";
import {
  createSyntheticScreenTextReader,
  demoScreenTextFrames,
} from "./screen-text-reader-synthetic.js";
import type { ScreenTextFrame, ScreenTextReaderFactory } from "./screen-text-source.js";

/**
 * Chooses a screen-text backend from the environment.
 *
 * Lives outside `screen-text-source.ts` on purpose: the adapter must not import
 * a backend, or a future OCR reader stops being one new factory and zero
 * adapter changes. Lives outside the entry points because more than one needs
 * it, and a second copy of this validation is a second place for
 * `SQUID_SCREEN_READER` to mean something slightly different.
 *
 * Every failure is a startup configuration error rather than a silent default:
 * a run that asked for the real accessibility reader and quietly replayed demo
 * frames instead looks identical to one that works.
 */
/**
 * The backend a host reads its own screen with, when nobody says otherwise.
 *
 * `synthetic` used to be the default, and that was the wrong kind of default: not
 * "off", but *fake*. A run that nobody configured replayed demo frames — a
 * scripted editor, a scripted window title — and the projection, the agent, and
 * the panel all treated them as observations of this machine. That is the failure
 * this module's own comment warns about, one layer up from where it was looking:
 * the run that "asked for the real accessibility reader and quietly replayed demo
 * frames" is bad, and so is the run that never asked and got them anyway.
 *
 * Every platform with a real backend now gets it. Nothing is guessed — the host
 * reports what it is, and the mismatch check below still refuses a backend asked
 * for on the wrong one — and nothing is silently degraded: a host whose
 * accessibility permission is missing produces read errors the source reports,
 * which is a fixable state a person can be told about, where demo frames are a
 * lie nobody can see through.
 *
 * `synthetic` stays reachable by name. It is what the tests and the offline demo
 * want, and asking for it is a different act from not asking at all.
 */
const HOST_READER: Partial<Record<NodeJS.Platform, ScreenReaderKind>> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

export type ScreenReaderKind = "darwin" | "linux" | "windows" | "synthetic";

export type ScreenReaderResolution =
  | {
      readonly readerKind: ScreenReaderKind;
      readonly readerFactory: ScreenTextReaderFactory;
    }
  | { readonly configError: string };

/** The host platform each real backend requires, and the name a human reads. */
const REQUIRED_PLATFORM: Partial<Record<ScreenReaderKind, { platform: NodeJS.Platform; label: string }>> = {
  darwin: { platform: "darwin", label: "macOS" },
  linux: { platform: "linux", label: "Linux" },
  windows: { platform: "win32", label: "Windows" },
};

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

  const readerKind = env.SQUID_SCREEN_READER ?? HOST_READER[platform] ?? "synthetic";
  if (readerKind !== "darwin" && readerKind !== "linux" && readerKind !== "windows" && readerKind !== "synthetic") {
    return {
      configError:
        'SQUID_SCREEN_READER must be "darwin", "linux", "windows", or "synthetic".',
    };
  }

  const requirement = REQUIRED_PLATFORM[readerKind];
  if (requirement !== undefined && platform !== requirement.platform) {
    return {
      configError:
        `SQUID_SCREEN_READER=${readerKind} requires ${requirement.label}; this host reports ${platform}.`,
    };
  }

  // One knob for every backend: how often the reader produces a frame.
  const rawPollMs = env.SQUID_SCREEN_POLL_MS;
  const pollMs = rawPollMs === undefined ? undefined : Number(rawPollMs);
  if (pollMs !== undefined && (!Number.isSafeInteger(pollMs) || pollMs <= 0)) {
    return {
      configError: "SQUID_SCREEN_POLL_MS must be a positive integer number of milliseconds.",
    };
  }

  // The platform travels with the choice, so the option decides construction as
  // well as validation. A factory left to read `process.platform` would make this
  // seam half-connected: it would pick the backend for the host named here and
  // then refuse to build it unless the process happened to be running there.
  if (readerKind === "darwin") {
    return {
      readerKind,
      readerFactory: createMacosScreenTextReader({ platform, ...(pollMs === undefined ? {} : { pollMs }) }),
    };
  }
  if (readerKind === "linux") {
    return {
      readerKind,
      readerFactory: createLinuxScreenTextReader({ platform, ...(pollMs === undefined ? {} : { pollMs }) }),
    };
  }
  if (readerKind === "windows") {
    return {
      readerKind,
      readerFactory: createWindowsScreenTextReader({ platform, ...(pollMs === undefined ? {} : { pollMs }) }),
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
