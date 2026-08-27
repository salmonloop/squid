import { describe, expect, it } from "bun:test";
import { InMemoryEventStore } from "../src/event-store.js";
import { createActivityEvent } from "../src/protocol.js";
import { ChronicleConflictError, SquidCore } from "../src/squid-core.js";

describe("SquidCore", () => {
  it("reconstructs focus context and text ownership across events", async () => {
    const core = new SquidCore(new InMemoryEventStore());

    await core.ingest(createActivityEvent({
      kind: "application_activated",
      payload: { applicationId: "editor", applicationName: "Editor" },
    }));
    await core.ingest(createActivityEvent({
      kind: "focus_changed",
      payload: { applicationId: "editor", windowTitle: "draft.md", role: "editor", label: null },
    }));
    const result = await core.ingest(createActivityEvent({
      kind: "text_context_changed",
      payload: { prefix: "Hello", suffix: " world", selection: "", language: "en" },
    }));

    expect(result.disposition).toBe("accepted");
    expect(result.state.activeApplication?.id).toBe("editor");
    expect(result.state.textContext?.prefix).toBe("Hello");
    expect(result.state.textContext?.owner).toEqual({ applicationId: "editor", windowTitle: "draft.md" });
  });

  it("restores state from the event store", async () => {
    const store = new InMemoryEventStore();
    const core = new SquidCore(store);
    const live = await core.ingest(createActivityEvent({
      kind: "browser_navigated",
      eventId: "restore-browser",
      occurredAt: "2026-08-19T14:00:00.000Z",
      payload: { url: "https://example.com", title: "Example", host: "example.com", owner: null },
    }));

    const restored = await new SquidCore(store).restore();
    expect(restored.currentBrowserPage?.host).toBe("example.com");
    expect(restored.episode).toEqual(live.state.episode);
    expect(new SquidCore(store).stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("exposes a deterministic state digest across order, late ingest, and restore", async () => {
    const events = [
      createActivityEvent({
        kind: "application_activated", eventId: "digest-app", sequence: 0,
        occurredAt: "2026-08-21T09:00:00.000Z",
        payload: { applicationId: "editor", applicationName: "Editor" },
      }),
      createActivityEvent({
        kind: "file_saved", eventId: "digest-save", sequence: 1,
        occurredAt: "2026-08-21T09:00:01.000Z",
        payload: { path: "src/main.ts", applicationId: "editor" },
      }),
    ];
    const orderedStore = new InMemoryEventStore();
    const ordered = new SquidCore(orderedStore);
    await ordered.ingest(events[0]!);
    await ordered.ingest(events[1]!);

    const shuffledStore = new InMemoryEventStore();
    const shuffled = new SquidCore(shuffledStore);
    await shuffled.ingest(events[1]!);
    await shuffled.ingest(events[0]!);
    const restored = new SquidCore(shuffledStore);
    await restored.restore();

    expect(ordered.stateDigest).toBe(shuffled.stateDigest);
    expect(ordered.stateDigest).toBe(restored.stateDigest);
    expect(ordered.projectionGeneration).toBeGreaterThan(0);
    expect(restored.projectionGeneration).toBeGreaterThan(0);
  });

  it("ignores exact duplicate event IDs", async () => {
    const core = new SquidCore(new InMemoryEventStore());
    const event = createActivityEvent({
      kind: "file_saved",
      eventId: "event-1",
      sequence: 0,
      payload: { path: "src/main.ts", applicationId: "editor" },
    });

    await core.ingest(event);
    const duplicate = await core.ingest(event);

    expect(duplicate.disposition).toBe("duplicate");
    expect(duplicate.state.recentActions).toHaveLength(1);
  });

  it("serializes concurrent duplicate ingestion", async () => {
    const store = new InMemoryEventStore();
    const core = new SquidCore(store);
    const event = createActivityEvent({
      kind: "file_saved",
      eventId: "concurrent-event",
      sequence: 0,
      payload: { path: "src/main.ts", applicationId: "editor" },
    });

    const results = await Promise.all([core.ingest(event), core.ingest(event)]);

    expect(results.map((result) => result.disposition).sort()).toEqual(["accepted", "duplicate"]);
    expect((await store.all()).map((stored) => stored.eventId)).toEqual(["concurrent-event"]);
  });

  it("rejects conflicting source-local identities", async () => {
    const core = new SquidCore(new InMemoryEventStore());
    const source = { kind: "ide" as const, instanceId: "editor" };
    await core.ingest(createActivityEvent({
      kind: "file_opened",
      eventId: "event-1",
      source,
      sequence: 0,
      payload: { path: "a.ts", applicationId: "editor" },
    }));

    await expect(core.ingest(createActivityEvent({
      kind: "file_opened",
      eventId: "event-2",
      source,
      sequence: 0,
      payload: { path: "b.ts", applicationId: "editor" },
    }))).rejects.toBeInstanceOf(ChronicleConflictError);
  });

  it("records late events without regressing live state", async () => {
    const core = new SquidCore(new InMemoryEventStore());
    await core.ingest(createActivityEvent({
      kind: "focus_changed",
      eventId: "newer",
      sequence: 1,
      occurredAt: "2026-08-18T12:01:00.000Z",
      payload: { applicationId: "editor", windowTitle: "newer.ts", role: "editor", label: null },
    }));

    const late = await core.ingest(createActivityEvent({
      kind: "focus_changed",
      eventId: "older",
      sequence: 0,
      occurredAt: "2026-08-18T12:00:00.000Z",
      payload: { applicationId: "editor", windowTitle: "older.ts", role: "editor", label: null },
    }));

    expect(late.disposition).toBe("late");
    expect(core.currentState.focus?.windowTitle).toBe("newer.ts");
  });

  it("reprojects late events so live state matches canonical restore", async () => {
    const store = new InMemoryEventStore();
    const core = new SquidCore(store);
    await core.ingest(createActivityEvent({
      kind: "pointer_action",
      eventId: "late-latest",
      sequence: 1,
      occurredAt: "2026-08-18T10:00:00.000Z",
      payload: {},
    }));

    const late = await core.ingest(createActivityEvent({
      kind: "file_saved",
      eventId: "late-inserted",
      sequence: 0,
      occurredAt: "2026-08-18T09:59:00.000Z",
      payload: { path: "late.ts", applicationId: "editor" },
    }));
    const restored = await new SquidCore(store).restore();

    expect(late.disposition).toBe("late");
    expect(late.state.recentFiles).toEqual(["late.ts"]);
    expect(late.state.episode?.eventCount).toBe(2);
    expect(core.currentState).toEqual(restored);
  });

  it("treats equivalent duplicate payload key order as the same event", async () => {
    const core = new SquidCore(new InMemoryEventStore());
    const first = createActivityEvent({
      kind: "window_changed",
      eventId: "same-event",
      source: { kind: "host", instanceId: "desktop" },
      sequence: 0,
      payload: { applicationId: "editor", title: "main.ts", bounds: { x: 0, y: 0, width: 1, height: 1 } },
    });
    const equivalent = {
      ...first,
      ingestedAt: "2026-08-18T12:01:00.000Z",
      payload: { bounds: { height: 1, width: 1, y: 0, x: 0 }, title: "main.ts", applicationId: "editor" },
    };

    await core.ingest(first);
    expect((await core.ingest(equivalent)).disposition).toBe("duplicate");
  });

  it("isolates published state snapshots", async () => {
    const core = new SquidCore(new InMemoryEventStore());
    const result = await core.ingest(createActivityEvent({
      kind: "browser_navigated",
      payload: { url: "https://example.com", title: "Example", host: "example.com", owner: null },
    }));

    result.state.currentBrowserPage!.host = "mutated.example";
    core.currentState.currentBrowserPage!.host = "also-mutated.example";

    expect(core.currentState.currentBrowserPage?.host).toBe("example.com");
  });
});
