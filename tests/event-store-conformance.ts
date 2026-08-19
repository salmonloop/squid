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
  dispose(): Promise<void>;
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
  });
}

export async function jsonlHarness(): Promise<StoreHarness> {
  const dir = await createTempDir();
  const store = new JsonlEventStore(join(dir, "events.jsonl"));
  return { store, dispose: () => rm(dir, { recursive: true, force: true }) };
}

export async function sqliteHarness(): Promise<StoreHarness> {
  const dir = await createTempDir();
  const store = new SqliteEventStore(join(dir, "events.db"));
  return {
    store,
    dispose: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
