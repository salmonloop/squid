import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { SqliteEventStore, EventStoreConstraintError } from "../src/sqlite-event-store.js";
import { createActivityEvent } from "../src/protocol.js";
import { orderActivityEvents } from "../src/chronicle-ordering.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "squid-sqlite-"));
  tempDirs.push(dir);
  return dir;
}

describe("SqliteEventStore", () => {
  it("reopens and reads every event from a fresh connection without closing the first", async () => {
    const dir = await createTempDir();
    const dbPath = join(dir, "events.db");

    const first = new SqliteEventStore(dbPath);
    const events = [
      createActivityEvent({
        kind: "file_opened",
        occurredAt: "2026-08-17T00:00:00.000Z",
        payload: { path: "a.ts", applicationId: "editor" },
      }),
      createActivityEvent({
        kind: "file_saved",
        occurredAt: "2026-08-17T00:00:01.000Z",
        payload: { path: "a.ts", applicationId: "editor" },
      }),
    ];
    for (const event of events) {
      await first.append(event);
    }

    // Open a second connection while the first is still alive — proves WAL
    // durability rather than an orderly checkpoint.
    const second = new SqliteEventStore(dbPath);
    const read = orderActivityEvents(await second.all());
    expect(read.map((e) => e.eventId)).toEqual(events.map((e) => e.eventId));
    // Projection-sensitive fields live only in event_json.
    expect(read.map((e) => e.ingestedAt)).toEqual(events.map((e) => e.ingestedAt));
    expect(read.map((e) => e.correlationId)).toEqual(events.map((e) => e.correlationId));

    second.close();
    first.close();
  });

  it("preserves sub-millisecond occurredAt fidelity through event_json", async () => {
    const dir = await createTempDir();
    const store = new SqliteEventStore(join(dir, "events.db"));
    const event = createActivityEvent({
      kind: "file_saved",
      occurredAt: "2026-08-17T00:00:00.123456Z",
      payload: { path: "a.ts", applicationId: "editor" },
    });
    await store.append(event);
    const read = await store.all();
    expect(read[0]!.occurredAt).toBe("2026-08-17T00:00:00.123456Z");
    store.close();
  });

  it("rejects a duplicate eventId with EventStoreConstraintError", async () => {
    const dir = await createTempDir();
    const store = new SqliteEventStore(join(dir, "events.db"));
    const event = createActivityEvent({
      kind: "file_opened",
      payload: { path: "a.ts", applicationId: "editor" },
    });
    await store.append(event);

    // Same eventId, different payload — a real duplicate, not a replay.
    const duplicate = createActivityEvent({
      kind: "file_saved",
      eventId: event.eventId,
      payload: { path: "b.ts", applicationId: "editor" },
    });
    await expect(store.append(duplicate)).rejects.toBeInstanceOf(EventStoreConstraintError);
    store.close();
  });

  it("rejects a reused source-local identity with EventStoreConstraintError", async () => {
    const dir = await createTempDir();
    const store = new SqliteEventStore(join(dir, "events.db"));
    const first = createActivityEvent({
      kind: "file_opened",
      source: { kind: "ide", instanceId: "ed-1" },
      sessionId: "s-1",
      payload: { path: "a.ts", applicationId: "editor" },
    });
    await store.append(first);

    // Different eventId, same (source.kind, instanceId, sessionId, sequence).
    const conflicting = createActivityEvent({
      kind: "file_saved",
      source: { kind: "ide", instanceId: "ed-1" },
      sessionId: "s-1",
      sequence: first.sequence,
      payload: { path: "b.ts", applicationId: "editor" },
    });
    await expect(store.append(conflicting)).rejects.toBeInstanceOf(EventStoreConstraintError);
    store.close();
  });

  it("creates a missing parent directory", async () => {
    const dir = await createTempDir();
    const nested = join(dir, "a", "b", "events.db");
    const store = new SqliteEventStore(nested);
    await store.append(createActivityEvent({ kind: "file_opened", payload: { path: "x.ts", applicationId: "editor" } }));
    expect((await store.all()).length).toBe(1);
    store.close();
  });

  it("rejects all() after close()", async () => {
    const dir = await createTempDir();
    const store = new SqliteEventStore(join(dir, "events.db"));
    store.close();
    await expect(store.all()).rejects.toThrow("SqliteEventStore is closed.");
  });

  it("rejects append after close()", async () => {
    const dir = await createTempDir();
    const store = new SqliteEventStore(join(dir, "events.db"));
    store.close();
    await expect(
      store.append(createActivityEvent({ kind: "file_opened", payload: { path: "x.ts", applicationId: "editor" } })),
    ).rejects.toThrow("SqliteEventStore is closed.");
  });

  it("removes -wal and -shm files after close()", async () => {
    const dir = await createTempDir();
    const dbPath = join(dir, "events.db");
    const store = new SqliteEventStore(dbPath);
    await store.append(createActivityEvent({ kind: "file_opened", payload: { path: "x.ts", applicationId: "editor" } }));
    store.close();

    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });
});
