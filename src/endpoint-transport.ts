import type { Socket, UnixSocketListener } from "bun";
import { startFifoLineReader } from "./fifo-line-reader.js";
import { parsePanelPipeName } from "./resolve-panel.js";

/**
 * The transport seam the FIFO-shaped readers share: an endpoint string names
 * its own transport, and the spelling is the whole dispatch.
 *
 * A POSIX-absolute path (the dialect the config file is written in) is read
 * as the append-only file `fifo-line-reader.ts` already tails. The Windows
 * named-pipe spelling `\\.\pipe\<name>` — the same shapes
 * `parsePanelPipeName` accepts for the panel wire, by design, so a user who
 * has learned one spelling has learned both — is served by `Bun.listen`,
 * exactly as the panel server is: Bun reads the same string and takes its
 * named-pipe branch on Windows.
 *
 * `mkfifo` has no Windows equivalent, which is the gap this module exists to
 * close: the three FIFO-backed capabilities (capture gate, terminal command,
 * editor saves) were unusable on the platform the product ships to, because
 * the only endpoint dialect they read is one Windows cannot create. A pipe
 * spelling is not a courtesy — a Windows run reading
 * `SQUID_CONTROL_FIFO=C:\\...` had a pause that could never be delivered,
 * silently, because the path was legal and nothing ever wrote it.
 *
 * The pipe side is listener-shaped rather than poll-shaped because a pipe
 * cannot be polled the way a file can: `stat` on a pipe reports size 0
 * forever, so the offset arithmetic that serves the file transport would
 * read nothing for the pipe's whole life. A listener is also the honest
 * shape for the writer: a shell hook connects, writes one framed line,
 * closes — on Windows that one connection is the whole write.
 */

/**
 * A pipe endpoint a reader can serve, or `undefined` when the value is a
 * filesystem path the existing readers already read.
 *
 * `parsePanelPipeName` parses and normalizes; this alias exists so the
 * resolvers read as one vocabulary with the panel resolver rather than as
 * three copies of a parser.
 */
export function parsePipeEndpoint(value: string): string | undefined {
  return parsePanelPipeName(value) ?? undefined;
}

export interface EndpointLineReaderOptions {
  /** Absolute POSIX path or Windows named-pipe spelling. */
  readonly path: string;
  /** Used only by the file transport. Default 250ms. */
  readonly pollMs?: number;
  /** Called once per complete, non-empty line. */
  readonly onLine: (line: string) => void;
  readonly onError: (error: Error) => void;
}

/**
 * Reads lines off one endpoint, whatever transport its spelling names.
 *
 * Both transports deliver the same contract: complete, non-empty lines, in
 * write order, with a half-written trailing line held back until its rest
 * arrives. Which transport runs is decided once, from the spelling, at
 * start — an endpoint is a file or a pipe for its whole life, so there is no
 * per-tick dispatch to drift.
 */
export function startEndpointLineReader(
  options: EndpointLineReaderOptions,
): { close(): void } {
  const pipeName = parsePipeEndpoint(options.path);
  if (pipeName !== undefined) {
    return startPipeLineListener({
      pipeName,
      onLine: options.onLine,
      onError: options.onError,
    });
  }
  return startFifoLineReader(options);
}

export interface PipeLineListenerOptions {
  /** The normalized `\\.\pipe\<name>` spelling. */
  readonly pipeName: string;
  /** Called once per complete, non-empty line. */
  readonly onLine: (line: string) => void;
  readonly onError: (error: Error) => void;
}

/**
 * Serves one named pipe and hands every complete line to `onLine`.
 *
 * Each connection is parsed independently: lines from two writers never
 * share a buffer, so interleaved writes cannot fuse into one malformed line.
 * A listen failure is reported once and the listener is not retried — an
 * endpoint the reader cannot serve is a state to surface, not a transient
 * to spin on.
 */
export function startPipeLineListener(
  options: PipeLineListenerOptions,
): { close(): void } {
  let closed = false;
  let server: UnixSocketListener<undefined> | undefined;

  // A connection's unparsed bytes, keyed by socket — the half-line carry
  // that makes a writer's split write one whole line, without letting two
  // writers' interleaved writes fuse into one malformed line.
  const carryOf = new Map<Socket<undefined>, string>();

  // A listen failure must reach `onError`, not the caller of `start()`: the
  // sources start asynchronously behind their own tail, and a throw here
  // would land in a catch that treats it as a source failure and stops the
  // session — when the honest verdict is one undeliverable reader reported
  // to the diagnostics the panel already shows.
  try {
    server = Bun.listen<undefined>({
      unix: options.pipeName,
      socket: {
        data: (_socket, chunk) => {
          const carry = carryOf.get(_socket) ?? "";
          const joined = carry + chunk.toString("utf8");
          const lines = joined.split("\n");
          const rest = lines.pop() ?? "";
          carryOf.set(_socket, rest);
          for (const line of lines) {
            if (line.trim().length === 0) continue;
            options.onLine(line);
          }
        },
        close: (socket) => {
          // A writer that closed mid-line loses the fragment: a half-written
          // line must not be parsed as JSON.
          carryOf.delete(socket);
        },
        error: (_socket, error) => {
          options.onError(error instanceof Error ? error : new Error(String(error)));
        },
      },
    });
  } catch (error) {
    options.onError(error instanceof Error ? error : new Error(String(error)));
  }

  return {
    close: () => {
      if (closed) return;
      closed = true;
      carryOf.clear();
      try {
        server?.stop(true);
      } catch {
        // Already gone; the writer's close is the usual reason.
      }
    },
  };
}
