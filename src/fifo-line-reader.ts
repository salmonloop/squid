import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";

/**
 * The shared reading body of the two FIFO readers — terminal commands and
 * editor saves. The transport is one endpoint naming either a real named pipe
 * or an append-only file, and the two demand different reading:
 *
 * An append-only file answers the offset arithmetic: `stat` reports its size,
 * so the bytes written since the last tick are exactly `size - offset`.
 *
 * A real named pipe answers neither question. `stat` on a pipe always reports
 * size 0, so the offset arithmetic can never see its bytes — an endpoint that
 * was genuinely a FIFO would read nothing forever. A pipe is drained instead:
 * open non-blocking (a blocking open would wedge the tick until a writer
 * arrives; ENOENT-quiet for missing files, EAGAIN for an empty pipe), then
 * read until the pipe runs dry. A writer that has already closed still leaves
 * its bytes in the buffer for the reader.
 *
 * Callers hand in line handling; this module owns the reading, the poll loop,
 * and the partial-line carry. A half-written line is kept for the next tick —
 * a writer's write is not guaranteed atomic, so a trailing fragment must not
 * be parsed as JSON.
 */
export interface FifoLineReaderOptions {
  /** Absolute path to the FIFO or append-only file. */
  readonly path: string;
  /** How often to check for new lines. Default 250ms. */
  readonly pollMs?: number;
  /** Called once per complete, non-empty line. */
  readonly onLine: (line: string) => void;
  readonly onError: (error: Error) => void;
}

const DEFAULT_POLL_MS = 250;
const PIPE_CHUNK = 4096;

export function startFifoLineReader(
  options: FifoLineReaderOptions,
): { close(): void } {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  let closed = false;
  let offset = 0;
  let carry = "";
  let reading = false;

  const readAvailable = async (): Promise<void> => {
    // One read at a time: a slow read must not interleave with the next tick
    // and reorder lines, since what a source reads is inherently ordered.
    if (reading || closed) return;
    reading = true;
    try {
      if (await isFifo(options.path)) {
        await drainPipe();
      } else {
        await readAppended();
      }
    } catch (error) {
      // A missing file is the normal state before the first writer, so it is
      // not worth reporting on every tick.
      if (!isMissingFile(error)) {
        options.onError(error instanceof Error ? error : new Error(String(error)));
      }
      reading = false;
      return;
    }

    // Re-checked after the awaits above. `close()` can land while a read is in
    // flight, and delivering a line afterwards would push an event into a
    // source that has already stopped — which then discards it on its own
    // lifecycle guard, but only after the sequence and the offset have moved.
    if (closed) {
      reading = false;
      return;
    }

    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      options.onLine(line);
    }
    reading = false;
  };

  /** The offset arithmetic that works on append-only files. */
  const readAppended = async (): Promise<void> => {
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
  };

  /** The drain that works on real pipes, where `stat` reports nothing. */
  const drainPipe = async (): Promise<void> => {
    const handle = await open(options.path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const buffer = Buffer.alloc(PIPE_CHUNK);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, PIPE_CHUNK, null);
        if (bytesRead === 0) break;
        carry += buffer.subarray(0, bytesRead).toString("utf8");
      }
    } catch (error) {
      // EAGAIN is the pipe running dry — the clean end of a drain.
      if (!isAgain(error)) throw error;
    } finally {
      await handle.close();
    }
  };

  const timer = setInterval(() => void readAvailable(), pollMs);
  // Read once immediately so a line written before start is not delayed by a
  // whole poll interval.
  void readAvailable();

  return {
    close: () => {
      closed = true;
      clearInterval(timer);
    },
  };
}

/** `stat` the path and tell a real named pipe from an append-only file. */
async function isFifo(path: string): Promise<boolean> {
  const stats = await stat(path);
  return stats.isFIFO();
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAgain(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EAGAIN";
}
