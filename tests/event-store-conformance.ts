import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { type EventStore, InMemoryEventStore, JsonlEventStore } from "../src/event-store.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { createActivityEvent, type ActivityEvent } from "../src/protocol.js";
import { orderActivityEvents } from "../src/chronicle-ordering.js";

export interface StoreHarness {
  readonly store: EventStore;
  /** Removes the backing storage. Only the harness that created it calls this. */
  dispose(): Promise<void>;
  /**
   * Reopens the same backing storage in a fresh instance, for the
   * deletion-durability test. Its `dispose` releases only that instance's
   * handle — never the files, which stay owned by this harness.
   * `undefined` for the in-memory store, whose storage has no second handle.
   */
  reopen(): Promise<{ readonly store: EventStore; dispose(): Promise<void> } | undefined>;
}

export function describeEventStoreConformance(
  name: string,
  createStore: () => Promise<StoreHarness>,
): void {
  describe(`${name} conformance`, () => {
    async function seedEvents(store: EventStore): Promise<ActivityEvent[]> {
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
        createActivityEvent({
          kind: "window_changed",
          occurredAt: "2026-08-17T00:00:02.000Z",
          source: { kind: "browser", instanceId: "browser-1" },
          payload: {
            applicationId: "browser",
            title: "Doc",
            bounds: { x: 0, y: 0, width: 10, height: 20 },
          },
        }),
      ];
      for (const event of events) {
        await store.append(event);
      }
      return events;
    }

    it("returns an empty array before any append", async () => {
      const harness = await createStore();
      try {
        expect(await harness.store.all()).toEqual([]);
      } finally {
        await harness.dispose();
      }
    });

    it("round-trips every appended event", async () => {
      const harness = await createStore();
      try {
        const events = await seedEvents(harness.store);
        const read = await harness.store.all();
        // Keyed by eventId, never by position: read order is uncontracted, so a
        // positional comparison would assert a contract the store disclaims.
        // Length plus distinct-id count together pin "exactly once".
        const readById = new Map(read.map((event) => [event.eventId, event]));
        expect(read.length).toBe(events.length);
        expect(readById.size).toBe(events.length);
        for (const event of events) {
          const stored = readById.get(event.eventId);
          expect(stored).toBeDefined();
          expect(stored!.kind).toBe(event.kind);
          expect(stored!.occurredAt).toBe(event.occurredAt);
          expect(stored!.ingestedAt).toBe(event.ingestedAt);
          expect(stored!.correlationId).toBe(event.correlationId);
        }
      } finally {
        await harness.dispose();
      }
    });

    it("produces identical canonical order regardless of append order", async () => {
      const forward = await createStore();
      const reversed = await createStore();
      try {
        const events = await seedEvents(forward.store);
        for (const event of [...events].reverse()) {
          await reversed.store.append(event);
        }
        const forwardCanonical = orderActivityEvents(await forward.store.all()).map((e) => e.eventId);
        const reversedCanonical = orderActivityEvents(await reversed.store.all()).map((e) => e.eventId);
        expect(reversedCanonical).toEqual(forwardCanonical);
      } finally {
        await forward.dispose();
        await reversed.dispose();
      }
    });

    it("isolates stored events from caller and reader mutations", async () => {
      const harness = await createStore();
      try {
        const event = createActivityEvent({
          kind: "window_changed",
          source: { kind: "browser", instanceId: "browser-1" },
          payload: {
            applicationId: "browser",
            title: "Before",
            bounds: { x: 1, y: 2, width: 3, height: 4 },
          },
        });
        await harness.store.append(event);
        event.source.instanceId = "browser-2";
        (event.payload as { bounds: { x: number } }).bounds.x = 99;

        const firstRead = await harness.store.all();
        firstRead[0]!.source.instanceId = "browser-3";
        (firstRead[0]!.payload as { bounds: { x: number } }).bounds.x = 42;

        const secondRead = await harness.store.all();
        expect(secondRead[0]!.source.instanceId).toBe("browser-1");
        expect((secondRead[0]!.payload as { bounds: { x: number } }).bounds.x).toBe(1);
      } finally {
        await harness.dispose();
      }
    });

    it("accepts concurrent appends", async () => {
      const harness = await createStore();
      try {
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
        await Promise.all(events.map((e) => harness.store.append(e)));
        expect((await harness.store.all()).length).toBe(events.length);
      } finally {
        await harness.dispose();
      }
    });

    it("filters since() inclusively at the boundary", async () => {
      const harness = await createStore();
      try {
        await seedEvents(harness.store);
        expect((await harness.store.since("2026-08-17T00:00:01.000Z")).length).toBe(2);
      } finally {
        await harness.dispose();
      }
    });

    it("treats timezone-offset spellings as equal in since()", async () => {
      const harness = await createStore();
      try {
        await seedEvents(harness.store);
        expect((await harness.store.since("2026-08-16T23:00:01.000-01:00")).length).toBe(2);
      } finally {
        await harness.dispose();
      }
    });

    it("rejects a non-date since() argument", async () => {
      const harness = await createStore();
      try {
        await expect(harness.store.since("not-a-date")).rejects.toThrow(
          "Event query timestamp must be a finite ISO date-time string.",
        );
      } finally {
        await harness.dispose();
      }
    });

    // Retention deletion is the one operation that removes, and "removes" must
    // mean the same thing in every backend: the bytes actually go, survivors
    // rehydrate unchanged, and a misread range refuses rather than deleting
    // something the user did not ask about.
    it("deletes exactly the ranged events and keeps the rest", async () => {
      const harness = await createStore();
      try {
        const events = await seedEvents(harness.store);
        const removed = await harness.store.deleteRange({
          from: events[1]!.occurredAt,
          until: events[2]!.occurredAt,
        });

        expect(removed).toBe(2);
        const remaining = (await harness.store.all()).map((e) => e.eventId);
        expect(remaining).toEqual([events[0]!.eventId]);
      } finally {
        await harness.dispose();
      }
    });

    it("treats range bounds inclusively", async () => {
      const harness = await createStore();
      try {
        const events = await seedEvents(harness.store);
        // Both endpoints name existing events; both must go.
        const removed = await harness.store.deleteRange({
          from: "2026-08-16T23:00:00.000-01:00",
          until: "2026-08-17T01:00:02.000+01:00",
        });

        expect(removed).toBe(3);
        expect(await harness.store.all()).toEqual([]);
      } finally {
        await harness.dispose();
      }
    });

    it("returns zero and changes nothing for an empty range", async () => {
      const harness = await createStore();
      try {
        const events = await seedEvents(harness.store);

        expect(await harness.store.deleteRange({ from: "2020-01-01T00:00:00.000Z", until: "2020-12-31T23:59:59.999Z" })).toBe(0);
        expect((await harness.store.all()).length).toBe(events.length);
      } finally {
        await harness.dispose();
      }
    });

    it("rejects an inverted or unparseable range without deleting", async () => {
      const harness = await createStore();
      try {
        const events = await seedEvents(harness.store);

        for (const range of [
          { from: "2026-08-17T00:00:02.000Z", until: "2026-08-17T00:00:00.000Z" },
          { from: "not-a-date", until: "2026-08-17T00:00:02.000Z" },
          { from: "2026-08-17T00:00:00.000Z", until: "" },
        ]) {
          await expect(harness.store.deleteRange(range)).rejects.toThrow();
        }
        expect((await harness.store.all()).length).toBe(events.length);
      } finally {
        await harness.dispose();
      }
    });

    it("keeps accepting appends after a deletion", async () => {
      // The store must stay writable once history has been cut: retention runs
      // mid-life, not at teardown, and the next append lands after the gap.
      const harness = await createStore();
      try {
        const events = await seedEvents(harness.store);
        await harness.store.deleteRange({ from: events[1]!.occurredAt, until: events[2]!.occurredAt });

        const later = createActivityEvent({
          kind: "file_saved",
          occurredAt: "2026-08-18T00:00:00.000Z",
          payload: { path: "b.ts", applicationId: "editor" },
        });
        await harness.store.append(later);

        const all = await harness.store.all();
        expect(all.map((e) => e.eventId).sort()).toEqual([events[0]!.eventId, later.eventId].sort());
        expect((await harness.store.all())[0]).toEqual(
          expect.not.objectContaining({ eventId: events[1]!.eventId }),
        );
      } finally {
        await harness.dispose();
      }
    });

    it("survives a reopen with the deletion applied", async () => {
      // Durability of deletion matters as much as durability of capture: a
      // backend that resurrects deleted rows on restart has not deleted them.
      // The reopened instance is read *before* the original harness disposes,
      // because dispose removes the backing files; a reopen handle owns only
      // its connection, never the storage.
      const first = await createStore();
      let reopened: { readonly store: EventStore; dispose(): Promise<void> } | undefined;
      try {
        const events = await seedEvents(first.store);
        await first.store.deleteRange({ from: events[1]!.occurredAt, until: events[2]!.occurredAt });
        reopened = await first.reopen();
        if (reopened !== undefined) {
          expect((await reopened.store.all()).length).toBe(1);
        }
      } finally {
        await reopened?.dispose();
        await first.dispose();
      }
    });
  });
}

// --- Concrete harnesses ---

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "squid-conformance-"));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupConformanceDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

export function inMemoryHarness(): Promise<StoreHarness> {
  return Promise.resolve({
    store: new InMemoryEventStore(),
    dispose: () => Promise.resolve(),
    reopen: () => Promise.resolve(undefined),
  });
}

export async function jsonlHarness(): Promise<StoreHarness> {
  const dir = await createTempDir();
  const filePath = join(dir, "events.jsonl");
  return {
    store: new JsonlEventStore(filePath),
    dispose: () => rm(dir, { recursive: true, force: true }),
    reopen: () =>
      // A reopened JSONL handle owns no files; releasing it is a no-op because
      // the store holds nothing but the path.
      Promise.resolve({ store: new JsonlEventStore(filePath), dispose: () => Promise.resolve() }),
  };
}

export async function sqliteHarness(): Promise<StoreHarness> {
  const dir = await createTempDir();
  const filePath = join(dir, "events.db");
  const store = new SqliteEventStore(filePath);
  return {
    store,
    dispose: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
    reopen: () => {
      const instance = new SqliteEventStore(filePath);
      return Promise.resolve({
        store: instance,
        dispose: async () => {
          instance.close();
          // Two calls, not one: `rm` takes (path, options), so passing a second
          // path put it where `options` belonged — the `-shm` file was never
          // removed and `force` never applied to it.
          await rm(`${filePath}-wal`, { force: true }).catch(() => {});
          await rm(`${filePath}-shm`, { force: true }).catch(() => {});
        },
      });
    },
  };
}
