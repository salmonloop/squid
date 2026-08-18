import { mkdir, mkdtemp, rm, unlink, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { InMemoryEventStore, JsonlEventStore } from "../src/event-store.js";
import { createActivityEvent } from "../src/protocol.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("InMemoryEventStore", () => {
  it("isolates stored events from caller and reader mutations", async () => {
    const store = new InMemoryEventStore();
    const event = createActivityEvent({
      kind: "window_changed",
      source: { kind: "browser", instanceId: "browser-1" },
      payload: {
        applicationId: "browser",
        title: "Before",
        bounds: { x: 1, y: 2, width: 3, height: 4 },
      },
    });

    await store.append(event);
    event.source.instanceId = "browser-2";
    event.payload.bounds!.x = 99;

    const firstRead = await store.all();
    firstRead[0]!.source.instanceId = "browser-3";
    (firstRead[0]!.payload as { bounds: { x: number } }).bounds.x = 42;

    const secondRead = await store.all();
    expect(secondRead[0]!.source.instanceId).toBe("browser-1");
    expect((secondRead[0]!.payload as { bounds: { x: number } }).bounds.x).toBe(1);
  });
});

describe("JsonlEventStore", () => {
  it("persists and reads events in order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "squid-events-"));
    temporaryDirectories.push(directory);
    const store = new JsonlEventStore(join(directory, "events.jsonl"));
    const first = createActivityEvent({
      kind: "file_opened",
      occurredAt: "2026-08-17T00:00:00.000Z",
      payload: { path: "a.ts", applicationId: "editor" },
    });
    const second = createActivityEvent({
      kind: "file_saved",
      occurredAt: "2026-08-17T00:00:01.000Z",
      payload: { path: "a.ts", applicationId: "editor" },
    });

    await Promise.all([store.append(first), store.append(second)]);
    expect((await store.all()).map((event) => event.kind)).toEqual(["file_opened", "file_saved"]);
    expect((await store.since("2026-08-17T00:00:01.000Z")).length).toBe(1);
    expect((await store.since("2026-08-16T23:00:01.000-01:00")).length).toBe(1);
    await expect(store.since("not-a-date")).rejects.toThrow("Event query timestamp must be a finite ISO date-time string.");
  });

  it("allows a later append after a recoverable write failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "squid-events-"));
    temporaryDirectories.push(directory);
    const blockedParent = join(directory, "events");
    const eventPath = join(blockedParent, "events.jsonl");
    const store = new JsonlEventStore(eventPath);
    await writeFile(blockedParent, "not a directory", "utf8");

    await expect(store.append(createActivityEvent({ kind: "file_opened", payload: { path: "broken", applicationId: null } })))
      .rejects.toMatchObject({ code: "EEXIST" });

    await unlink(blockedParent);
    await mkdir(blockedParent);
    const recovered = createActivityEvent({ kind: "file_saved", payload: { path: "recovered", applicationId: null } });
    await store.append(recovered);

    expect((await store.all()).map((event) => event.eventId)).toEqual([recovered.eventId]);
  });

  it("recovers an interrupted final record but rejects corrupted history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "squid-events-"));
    temporaryDirectories.push(directory);
    const eventPath = join(directory, "events.jsonl");
    const store = new JsonlEventStore(eventPath);
    const first = createActivityEvent({
      kind: "file_opened",
      payload: { path: "a.ts", applicationId: "editor" },
    });
    await store.append(first);
    await appendFile(eventPath, "\"schemaVersion\":1", "utf8");

    expect((await store.all()).map((event) => event.eventId)).toEqual([first.eventId]);
    expect(store.diagnostics).toEqual([{ kind: "truncated_final_record", line: 2 }]);

    await writeFile(eventPath, JSON.stringify({ not: "an event" }), "utf8");
    await expect(store.all()).rejects.toThrow("Invalid Chronicle JSONL record at line 1.");
  });
});
