import { isAbsolute } from "node:path";
import { createFifoCaptureGateReader } from "./capture-gate-reader-fifo.js";
import type { CaptureGateReaderFactory } from "./capture-gate-source.js";

/**
 * Chooses a capture-gate backend from the environment.
 *
 * Off by default, like every capability variable. The gate is what lets a user
 * stop being observed, which means enabling it is also declaring that this run
 * can be controlled — a surface worth asking for rather than assuming.
 *
 * `SQUID_CONTROL` has three outcomes, matching every other capability
 * variable: unset means no gate, exactly `fifo` reads the path in
 * `SQUID_CONTROL_FIFO`, and anything else is a startup configuration error.
 */
export type CaptureGateResolution =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly readerKind: "fifo";
      readonly readerFactory: CaptureGateReaderFactory;
    }
  | { readonly configError: string };

export interface ResolveCaptureGateOptions {
  readonly env?: Record<string, string | undefined>;
}

export function resolveCaptureGate(
  options: ResolveCaptureGateOptions = {},
): CaptureGateResolution {
  const env = options.env ?? process.env;
  const kind = env.SQUID_CONTROL;
  if (kind === undefined) return { enabled: false };
  if (kind !== "fifo") {
    return { configError: 'SQUID_CONTROL must be unset (off) or exactly "fifo".' };
  }

  const path = env.SQUID_CONTROL_FIFO;
  if (path === undefined || path.length === 0) {
    return {
      configError: "SQUID_CONTROL=fifo requires SQUID_CONTROL_FIFO to name a path.",
    };
  }
  if (!isAbsolute(path)) {
    return { configError: "SQUID_CONTROL_FIFO must be an absolute path." };
  }

  const rawPollMs = env.SQUID_CONTROL_POLL_MS;
  const pollMs = rawPollMs === undefined ? undefined : Number(rawPollMs);
  if (pollMs !== undefined && (!Number.isSafeInteger(pollMs) || pollMs <= 0)) {
    return {
      configError: "SQUID_CONTROL_POLL_MS must be a positive integer number of milliseconds.",
    };
  }

  return {
    enabled: true,
    readerKind: "fifo",
    readerFactory: createFifoCaptureGateReader({
      path,
      ...(pollMs === undefined ? {} : { pollMs }),
    }),
  };
}
