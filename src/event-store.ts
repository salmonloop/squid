import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseActivityEvent, type ActivityEvent } from "./protocol.js";

/**
 * Append-only Chronicle storage.
 *
 * `append` stores exactly one copy of each accepted event. An implementation
 * backed by a uniqueness constraint MAY reject an event whose `eventId` or
 * source-local identity already exists; the in-memory and JSONL stores do not.
 * Callers must not depend on duplicate acceptance — `SquidCore.inspectDuplicate`
 * owns deduplication.
 *
 * `all` returns every appended event exactly once. Return order is NOT part of
 * the contract: it is physical arrival order here, and an implementation is free
 * to return any permutation. Callers needing a timeline apply
 * `orderActivityEvents`, which is total on events with distinct `eventId`s.
 *
 * `since` keeps events whose `occurredAt` is at or after the threshold, after
 * decoding both sides to epoch milliseconds so timezone spellings compare
 * equal. Return order is likewise uncontracted.
 *
 * `deleteRange` is the one operation that removes. Retention deletion must
 * actually free the record — a tombstone would keep every byte it claims to
 * have deleted — so this rewrites or truncates storage in place. The range is
 * inclusive on both ends, decoded to epoch milliseconds like `since`, and the
 * returned count is what was removed. Events outside the range are untouched,
 * and a subsequent read rehydrates them through `parseActivityEvent` exactly as
 * before.
 */
export interface EventStore {
  append(event: ActivityEvent): Promise<void>;
  all(): Promise<readonly ActivityEvent[]>;
  since(occurredAt: string): Promise<readonly ActivityEvent[]>;
  deleteRange(range: { readonly from: string; readonly until: string }): Promise<number>;
}

/**
 * Validates a deletion range into epoch-millisecond bounds.
 *
 * Both endpoints must be finite date-times and `from` may not exceed `until`.
 * An inverted or unparseable range refuses rather than deleting nothing (or
 * everything): retention is the user's "delete my history" request, and acting
 * on a misread range is not recoverable.
 */
export function parseDeletionRange(
  from: string,
  until: string,
): { readonly fromMs: number; readonly untilMs: number } {
  const fromMs = parseTimestamp(from);
  const untilMs = parseTimestamp(until);
  if (fromMs > untilMs) {
    throw new TypeError("Deletion range start must not be after its end.");
  }
  return { fromMs, untilMs };
}

export interface EventStoreDiagnostic {
  kind: "truncated_final_record";
  line: number;
}

export class InMemoryEventStore implements EventStore {
  private readonly events: ActivityEvent[] = [];

  async append(event: ActivityEvent): Promise<void> {
    this.events.push(parseActivityEvent(event));
  }

  async all(): Promise<readonly ActivityEvent[]> {
    return this.events.map(cloneEvent);
  }

  async since(occurredAt: string): Promise<readonly ActivityEvent[]> {
    const threshold = parseTimestamp(occurredAt);
    return (await this.all()).filter((event) => new Date(event.occurredAt).getTime() >= threshold);
  }

  async deleteRange(range: { readonly from: string; readonly until: string }): Promise<number> {
    const { fromMs, untilMs } = parseDeletionRange(range.from, range.until);
    let removed = 0;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      if (inRange(this.events[index]!, fromMs, untilMs)) {
        this.events.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  }
}

/** Shared range test: inclusive on both ends, decoded to epoch milliseconds. */
function inRange(event: ActivityEvent, fromMs: number, untilMs: number): boolean {
  const at = new Date(event.occurredAt).getTime();
  return at >= fromMs && at <= untilMs;
}

export class JsonlEventStore implements EventStore {
  private writeTail: Promise<unknown> = Promise.resolve();
  private readDiagnostics: EventStoreDiagnostic[] = [];

  public constructor(private readonly filePath: string) {}

  public get diagnostics(): readonly EventStoreDiagnostic[] {
    return this.readDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  async append(event: ActivityEvent): Promise<void> {
    const validatedEvent = parseActivityEvent(event);
    const write = this.writeTail.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(validatedEvent)}\n`, "utf8");
    });
    this.writeTail = write.catch(() => undefined);
    await write;
  }

  async all(): Promise<readonly ActivityEvent[]> {
    await this.writeTail;
    this.readDiagnostics = [];
    return readJsonlEvents(await readFileOrNothing(this.filePath), this.readDiagnostics);
  }

  async since(occurredAt: string): Promise<readonly ActivityEvent[]> {
    const threshold = parseTimestamp(occurredAt);
    return (await this.all()).filter((event) => new Date(event.occurredAt).getTime() >= threshold);
  }

  /**
   * Rewrites the file without the ranged events, then replays the remainder.
   *
   * A JSONL line is the only copy of its event, so deletion means writing a new
   * file and renaming it over the old one — an interrupted rewrite must leave
   * either the old history or the new one, never a half-file. `rename` is
   * atomic on the same directory, which the temp file shares. The write-tail
   * serializes this against concurrent appends so a delete can never interleave
   * with a partially written append.
   */
  async deleteRange(range: { readonly from: string; readonly until: string }): Promise<number> {
    const { fromMs, untilMs } = parseDeletionRange(range.from, range.until);
    const write = this.writeTail.then(async () => {
      // Reads the file directly rather than through `all()`: that method awaits
      // the write tail, which this callback *is* — calling it here would await
      // our own completion and deadlock.
      const events = readJsonlEvents(await readFileOrNothing(this.filePath), []);
      const kept = events.filter((event) => !inRange(event, fromMs, untilMs));
      const removed = events.length - kept.length;
      if (removed === 0) return 0;

      const tempPath = `${this.filePath}.delete-${crypto.randomUUID()}`;
      await mkdir(dirname(this.filePath), { recursive: true });
      // Kept lines are already parsed; re-serializing them preserves every
      // field exactly as a read would return it.
      await writeFile(tempPath, kept.map((event) => `${JSON.stringify(event)}\n`).join(""), "utf8");
      await rename(tempPath, this.filePath);
      return removed;
    });
    this.writeTail = write.catch(() => undefined);
    return write;
  }
}

function readJsonlEvents(content: string, diagnostics: EventStoreDiagnostic[]): ActivityEvent[] {
  const lines = content.split("\n");
  const terminalLine = lines.pop();
  const events = lines
    .map((line, index) => parseJsonlEvent(line, index + 1));

  if (terminalLine === undefined || terminalLine.length === 0) {
    return events;
  }

  let decodedTerminalRecord: unknown;
  try {
    decodedTerminalRecord = JSON.parse(terminalLine);
  } catch {
    diagnostics.push({ kind: "truncated_final_record", line: lines.length + 1 });
    return events;
  }

  try {
    events.push(parseActivityEvent(decodedTerminalRecord));
  } catch (error) {
    throw new Error(`Invalid Chronicle JSONL record at line ${lines.length + 1}.`, { cause: error });
  }

  return events;
}

function parseJsonlEvent(line: string, lineNumber: number): ActivityEvent {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid Chronicle JSONL record at line ${lineNumber}.`, { cause: error });
  }

  try {
    return parseActivityEvent(decoded);
  } catch (error) {
    throw new Error(`Invalid Chronicle JSONL record at line ${lineNumber}.`, { cause: error });
  }
}

function cloneEvent(event: ActivityEvent): ActivityEvent {
  return structuredClone(event);
}

export function parseTimestamp(value: string): number {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("Event query timestamp must be a finite ISO date-time string.");
  }
  return timestamp;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Reads the whole store file, treating a missing file as empty history. */
async function readFileOrNothing(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return "";
    throw error;
  }
}
