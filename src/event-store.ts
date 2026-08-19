import { appendFile, mkdir, readFile } from "node:fs/promises";
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
 */
export interface EventStore {
  append(event: ActivityEvent): Promise<void>;
  all(): Promise<readonly ActivityEvent[]>;
  since(occurredAt: string): Promise<readonly ActivityEvent[]>;
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
}

export class JsonlEventStore implements EventStore {
  private writeTail: Promise<void> = Promise.resolve();
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

    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }

    return readJsonlEvents(content, this.readDiagnostics);
  }

  async since(occurredAt: string): Promise<readonly ActivityEvent[]> {
    const threshold = parseTimestamp(occurredAt);
    return (await this.all()).filter((event) => new Date(event.occurredAt).getTime() >= threshold);
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
