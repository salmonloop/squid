import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { createActivityEvent } from "../src/protocol.js";
import { deleteHistoryRange, runRetentionPrune } from "../src/retention-prune.js";
import {
  InMemoryEventStore,
  JsonlEventStore,
  type EventStore,
} from "../src/event-store.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";

/**
 * End-to-end retention: the Done-when for issue #6 stated as an assertion.
 *
 * This file used to assert a second half — that deletion left no ledger record
 * referencing a removed event — because a prediction ledger sat beside the store
 * and its records had to be closed over whatever history lost. There is no such
 * ledger now: the agent's own actions live in its Pi session history, and the
 * event store is the only thing Squid deletes from.
 *
 * What remains is still a cross-backend property. Every store decodes both range
 * bounds to epoch milliseconds before comparing, so the same cutoff must select
 * the same events on each one — asserted here rather than inferred from the
 * conformance suites, because a backend that parsed a bound differently would
 * pass those and still under-delete here.
 */

const tempDirs: string[] = [];

interface Harness {
  readonly store: EventStore;
  dispose(): Promise<void>;
}

async function sqliteHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "squid-retention-"));
  tempDirs.push(dir);
  const store = new SqliteEventStore(join(dir, "events.db"));
  return {
    store,
    dispose: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function jsonlHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "squid-retention-"));
  tempDirs.push(dir);
  return {
    store: new JsonlEventStore(join(dir, "events.jsonl")),
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

async function memoryHarness(): Promise<Harness> {
  return Promise.resolve({
    store: new InMemoryEventStore(),
    dispose: () => Promise.resolve(),
  });
}

/** An old event inside the retention range, and a fresh one outside it. */
const OLD_AT = "2026-08-01T00:00:00.000Z";
const NEW_AT = "2026-08-21T12:00:00.000Z";
const CUTOFF_MS = Date.parse("2026-08-20T00:00:00.000Z");

function eventAt(eventId: string, occurredAt: string): ReturnType<typeof createActivityEvent> {
  return createActivityEvent({
    kind: "file_saved",
    eventId,
    occurredAt,
    payload: { path: `${eventId}.ts`, applicationId: null },
  });
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

const backends: readonly { readonly name: string; readonly create: () => Promise<Harness> }[] = [
  { name: "sqlite", create: sqliteHarness },
  { name: "jsonl", create: jsonlHarness },
  { name: "memory", create: memoryHarness },
];

for (const { name, create } of backends) {
  describe(`retention prune end-to-end (${name})`, () => {
    it("removes events at or before the cutoff and keeps the rest", async () => {
      const harness = await create();
      try {
        await harness.store.append(eventAt("old-1", OLD_AT));
        await harness.store.append(eventAt("old-2", OLD_AT));
        await harness.store.append(eventAt("fresh", NEW_AT));

        const result = await runRetentionPrune(harness.store, { cutoffMs: CUTOFF_MS });

        expect(result.removedEvents).toBe(2);
        expect((await harness.store.all()).map((event) => event.eventId)).toEqual(["fresh"]);
      } finally {
        await harness.dispose();
      }
    });

    it("is a no-op when everything is younger than the cutoff", async () => {
      const harness = await create();
      try {
        await harness.store.append(eventAt("fresh-1", NEW_AT));
        await harness.store.append(eventAt("fresh-2", NEW_AT));

        const result = await runRetentionPrune(harness.store, { cutoffMs: CUTOFF_MS });

        expect(result.removedEvents).toBe(0);
        expect(await harness.store.all()).toHaveLength(2);
      } finally {
        await harness.dispose();
      }
    });

    it("deletes an explicit range inclusively at both bounds", async () => {
      const harness = await create();
      try {
        // The bounds themselves go: `history:delete lunch dinner` must remove the
        // event that landed exactly at dinner, or a caller has to guess an offset.
        await harness.store.append(eventAt("before", "2026-08-10T00:00:00.000Z"));
        await harness.store.append(eventAt("at-from", "2026-08-11T00:00:00.000Z"));
        await harness.store.append(eventAt("inside", "2026-08-12T00:00:00.000Z"));
        await harness.store.append(eventAt("at-until", "2026-08-13T00:00:00.000Z"));
        await harness.store.append(eventAt("after", "2026-08-14T00:00:00.000Z"));

        const result = await deleteHistoryRange(harness.store, {
          from: "2026-08-11T00:00:00.000Z",
          until: "2026-08-13T00:00:00.000Z",
        });

        expect(result.removedEvents).toBe(3);
        expect((await harness.store.all()).map((event) => event.eventId))
          .toEqual(["before", "after"]);
      } finally {
        await harness.dispose();
      }
    });
  });
}
