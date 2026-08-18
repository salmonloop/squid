import { describe, expect, it } from "bun:test";
import { InMemoryEventStore } from "../src/event-store.js";
import { createActivityEvent } from "../src/protocol.js";
import { ChronicleConflictError, SquidCore } from "../src/squid-core.js";

class FixtureEventStore extends InMemoryEventStore {
  public constructor(private readonly fixture: ReturnType<typeof createActivityEvent>[]) {
    super();
  }

  override async all() {
    return structuredClone(this.fixture);
  }
}

describe("Chronicle replay", () => {
  it("restores a canonical state from shuffled persisted events", async () => {
    const application = createActivityEvent({
      kind: "application_activated",
      eventId: "application",
      sequence: 0,
      occurredAt: "2026-08-18T12:00:00.000Z",
      payload: { applicationId: "editor", applicationName: "Editor" },
    });
    const olderFocus = createActivityEvent({
      kind: "focus_changed",
      eventId: "older-focus",
      sequence: 1,
      occurredAt: "2026-08-18T12:00:01.000Z",
      payload: { applicationId: "editor", windowTitle: "old.ts", role: "editor", label: null },
    });
    const newerFocus = createActivityEvent({
      kind: "focus_changed",
      eventId: "newer-focus",
      sequence: 2,
      occurredAt: "2026-08-18T12:00:02.000Z",
      payload: { applicationId: "editor", windowTitle: "new.ts", role: "editor", label: null },
    });

    const state = await new SquidCore(new FixtureEventStore([newerFocus, application, olderFocus])).restore();

    expect(state.activeApplication?.id).toBe("editor");
    expect(state.focus?.windowTitle).toBe("new.ts");
  });

  it("rejects conflicting persisted source-local records", async () => {
    const source = { kind: "synthetic" as const, instanceId: "fixture" };
    const first = createActivityEvent({
      kind: "file_opened",
      eventId: "event-1",
      source,
      sequence: 0,
      payload: { path: "a.ts", applicationId: "editor" },
    });
    const conflicting = createActivityEvent({
      kind: "file_opened",
      eventId: "event-2",
      source,
      sequence: 0,
      payload: { path: "b.ts", applicationId: "editor" },
    });

    await expect(new SquidCore(new FixtureEventStore([first, conflicting])).restore())
      .rejects.toBeInstanceOf(ChronicleConflictError);
  });
});
