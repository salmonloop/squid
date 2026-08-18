import { describe, expect, it } from "bun:test";
import { type Predictor } from "../src/baseline-predictor.js";
import { InMemoryEventStore } from "../src/event-store.js";
import { createActivityEvent } from "../src/protocol.js";
import { ChronicleConflictError, SquidCore } from "../src/squid-core.js";

describe("SquidCore", () => {
  it("reconstructs focus context and emits a completion baseline", async () => {
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
    expect(result.state.focus?.prefix).toBe("Hello");
    expect(result.baselinePredictions[0]?.kind).toBe("draft_completion");
  });

  it("restores state from the event store", async () => {
    const store = new InMemoryEventStore();
    const core = new SquidCore(store);
    await core.ingest(createActivityEvent({
      kind: "browser_navigated",
      payload: { url: "https://example.com", title: "Example", host: "example.com" },
    }));

    const restored = await new SquidCore(store).restore();
    expect(restored.currentBrowserPage?.host).toBe("example.com");
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

  it("does not let a predictor mutate core state", async () => {
    const mutatingPredictor: Predictor = {
      predict(state) {
        state.focus = null;
        return [];
      },
    };
    const core = new SquidCore(new InMemoryEventStore(), mutatingPredictor);

    await core.ingest(createActivityEvent({
      kind: "focus_changed",
      payload: { applicationId: "editor", windowTitle: "main.ts", role: "editor", label: null },
    }));

    expect(core.currentState.focus?.windowTitle).toBe("main.ts");
  });

  it("isolates published state snapshots", async () => {
    const core = new SquidCore(new InMemoryEventStore());
    const result = await core.ingest(createActivityEvent({
      kind: "browser_navigated",
      payload: { url: "https://example.com", title: "Example", host: "example.com" },
    }));

    result.state.currentBrowserPage!.host = "mutated.example";
    core.currentState.currentBrowserPage!.host = "also-mutated.example";

    expect(core.currentState.currentBrowserPage?.host).toBe("example.com");
  });
});
