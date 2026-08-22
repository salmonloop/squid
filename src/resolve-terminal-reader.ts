import { isAbsolute } from "node:path";
import { createFifoTerminalCommandReader } from "./terminal-command-reader-fifo.js";
import type { TerminalCommandReaderFactory } from "./terminal-command-source.js";

/**
 * Chooses a terminal backend from the environment.
 *
 * Off by default, for the same reason browser observation is: a shell command
 * line is among the most sensitive text on a developer's machine, so observing
 * one is a capability a run asks for rather than inherits. The raw line never
 * reaches the timeline either way — `projectTerminalFrame` reduces it to a class
 * — but the decision to watch at all still belongs to the user.
 *
 * `SQUID_TERMINAL` has three outcomes, matching the other capability variables:
 * unset means no terminal source, exactly `fifo` reads the path in
 * `SQUID_TERMINAL_FIFO`, and anything else is a startup configuration error.
 */
export type TerminalReaderResolution =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly readerKind: "fifo";
      readonly readerFactory: TerminalCommandReaderFactory;
    }
  | { readonly configError: string };

export interface ResolveTerminalReaderOptions {
  readonly env?: Record<string, string | undefined>;
}

export function resolveTerminalReader(
  options: ResolveTerminalReaderOptions = {},
): TerminalReaderResolution {
  const env = options.env ?? process.env;
  const kind = env.SQUID_TERMINAL;
  if (kind === undefined) return { enabled: false };
  if (kind !== "fifo") {
    return { configError: 'SQUID_TERMINAL must be unset (off) or exactly "fifo".' };
  }

  const path = env.SQUID_TERMINAL_FIFO;
  if (path === undefined || path.length === 0) {
    return {
      configError: "SQUID_TERMINAL=fifo requires SQUID_TERMINAL_FIFO to name a path.",
    };
  }
  if (!isAbsolute(path)) {
    return { configError: "SQUID_TERMINAL_FIFO must be an absolute path." };
  }

  const rawPollMs = env.SQUID_TERMINAL_POLL_MS;
  const pollMs = rawPollMs === undefined ? undefined : Number(rawPollMs);
  if (pollMs !== undefined && (!Number.isSafeInteger(pollMs) || pollMs <= 0)) {
    return {
      configError: "SQUID_TERMINAL_POLL_MS must be a positive integer number of milliseconds.",
    };
  }

  return {
    enabled: true,
    readerKind: "fifo",
    readerFactory: createFifoTerminalCommandReader({
      path,
      ...(pollMs === undefined ? {} : { pollMs }),
    }),
  };
}
