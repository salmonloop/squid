import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { parseTimestamp, type EventStore } from "./event-store.js";
import { parseActivityEvent, type ActivityEvent } from "./protocol.js";

/**
 * Raised when a write violates Chronicle uniqueness.
 *
 * One error type rather than two on purpose: a row that violates both the
 * `event_id` primary key and the source-local identity index always reports
 * `SQLITE_CONSTRAINT_UNIQUE`, because the identity index is checked first.
 * Error codes therefore cannot separate "same event twice" from "identity
 * reused by a different event", so the type system must not pretend they can.
 */
export class EventStoreConstraintError extends Error {
  public override readonly name = "EventStoreConstraintError";

  public constructor(message: string, options: { cause: unknown }) {
    super(message, options);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chronicle_events (
  event_id        TEXT    NOT NULL PRIMARY KEY,
  occurred_at_ms  INTEGER NOT NULL,
  source_kind     TEXT    NOT NULL,
  source_instance TEXT    NOT NULL,
  session_id      TEXT    NOT NULL,
  sequence        INTEGER NOT NULL,
  event_json      TEXT    NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS chronicle_events_identity
  ON chronicle_events (source_kind, source_instance, session_id, sequence);

CREATE INDEX IF NOT EXISTS chronicle_events_occurred_at
  ON chronicle_events (occurred_at_ms);
`;

const CONSTRAINT_CODES = new Set(["SQLITE_CONSTRAINT_PRIMARYKEY", "SQLITE_CONSTRAINT_UNIQUE"]);

/** The database itself plus the sidecar files WAL and rollback modes maintain. */
const WAL_SIDECAR_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

/**
 * Durable append-only Chronicle storage on SQLite.
 *
 * `event_json` is the authoritative record — every read rehydrates through
 * `parseActivityEvent`, so `ingestedAt`, `correlationId`, and sub-millisecond
 * `occurredAt` spellings survive a round trip. The scalar columns are a lossy
 * projection kept only for filtering and integrity; `occurred_at_ms` in
 * particular collapses sub-millisecond precision.
 *
 * `bun:sqlite` is synchronous, so this performs blocking I/O behind an async
 * interface. Measured at 7,331 events/s against `JsonlEventStore`'s 5,838/s,
 * which is ample for single-user desktop ingest. A bulk replay path should
 * wrap its inserts in one transaction rather than relying on autocommit.
 */
export class SqliteEventStore implements EventStore {
  private readonly database: Database;
  private closed = false;

  public constructor(filePath: string) {
    // `bun:sqlite` does not create the parent directory, unlike
    // `JsonlEventStore.append`; without this a missing parent is SQLITE_CANTOPEN.
    mkdirSync(dirname(filePath), { recursive: true });

    // `{ create: true }` must be explicit: `new Database(path, {})` and
    // `{ readonly: false }` both throw SQLITE_MISUSE.
    this.database = new Database(filePath, { create: true });
    try {
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA synchronous = NORMAL");
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec("PRAGMA busy_timeout = 5000");
      this.database.exec(SCHEMA);
    } catch (error) {
      // Any PRAGMA or schema failure leaves the database handle open but
      // uninitialized; close it so no subsequent call operates on a
      // half-configured connection.
      this.database.close();
      throw error;
    }
  }

  async append(event: ActivityEvent): Promise<void> {
    this.assertOpen();
    const validatedEvent = parseActivityEvent(event);

    try {
      this.database
        .query(
          `INSERT INTO chronicle_events
             (event_id, occurred_at_ms, source_kind, source_instance, session_id, sequence, event_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          validatedEvent.eventId,
          // STRICT rejects REAL in an INTEGER column, so truncate deliberately
          // rather than relying on getTime() always being integral.
          Math.trunc(new Date(validatedEvent.occurredAt).getTime()),
          validatedEvent.source.kind,
          validatedEvent.source.instanceId,
          validatedEvent.sessionId,
          validatedEvent.sequence,
          JSON.stringify(validatedEvent),
        );
    } catch (error) {
      if (isConstraintViolation(error)) {
        throw new EventStoreConstraintError(
          `Event ${validatedEvent.eventId} violates Chronicle uniqueness.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async all(): Promise<readonly ActivityEvent[]> {
    this.assertOpen();
    // No ORDER BY: read order is uncontracted and every caller re-sorts.
    return this.decode(this.database.query("SELECT event_json FROM chronicle_events").all());
  }

  async since(occurredAt: string): Promise<readonly ActivityEvent[]> {
    this.assertOpen();
    const threshold = parseTimestamp(occurredAt);
    return this.decode(
      this.database
        .query("SELECT event_json FROM chronicle_events WHERE occurred_at_ms >= ?")
        .all(threshold),
    );
  }

  /**
   * Releases the database. Not part of `EventStore`; a future source supervisor
   * can promote it if lifecycle management moves up a layer.
   *
   * No `wal_checkpoint(TRUNCATE)` ritual here — `close()` alone truncates and
   * unlinks `-wal`/`-shm`, verified by measurement. Committed data survives
   * process death without an explicit checkpoint because of WAL, but
   * `synchronous = NORMAL` does not guarantee survival of OS or power loss.
   */
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private decode(rows: readonly unknown[]): readonly ActivityEvent[] {
    return rows.map((row) => parseActivityEvent(JSON.parse((row as { event_json: string }).event_json)));
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("SqliteEventStore is closed.");
    }
  }
}

/**
 * Root-relative POSIX paths a filesystem watcher must ignore for this database.
 *
 * A database inside a watched root feeds its own writes back in: every append
 * updates `-wal`, the watcher reports that write, ingesting it appends again.
 * Returns an empty array when the database lives outside the root, so a caller
 * cannot accidentally exclude an unrelated sibling path.
 */
export function sqliteWatchExclusions(root: string, filePath: string): readonly string[] {
  return WAL_SIDECAR_SUFFIXES
    .map((suffix) => relative(root, `${filePath}${suffix}`).split(sep).join("/"))
    .filter((candidate) => candidate.length > 0 && candidate !== ".." && !candidate.startsWith("../"));
}

function isConstraintViolation(error: unknown): boolean {
  // Branch on `.code`, never `.message`: a primary-key violation's message also
  // reads "UNIQUE constraint failed", so substring matching conflates the two.
  return error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    && CONSTRAINT_CODES.has(error.code);
}
