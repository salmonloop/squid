import { describe, expect, it } from "bun:test";
import {
  ActivityEventValidationError,
  createActivityEvent,
  isActivityEvent,
  parseActivityEvent,
} from "../src/protocol.js";

describe("ActivityEvent protocol", () => {
  it("accepts supported event payloads and creates source-local sequences", () => {
    const source = { kind: "ide" as const, instanceId: "vscode-1" };
    const first = createActivityEvent({
      kind: "file_saved",
      source,
      sessionId: "session-1",
      payload: { path: "src/main.ts", applicationId: "vscode" },
    });
    const second = createActivityEvent({
      kind: "terminal_command_completed",
      source,
      sessionId: "session-1",
      payload: { commandClass: "test", succeeded: true, exitCode: 0 },
    });

    expect(first.sequence).toBe(0);
    expect(second.sequence).toBe(1);
    expect(isActivityEvent(first)).toBe(true);
  });

  it("defaults to a session unique per process, so auto-reservation cannot collide with history", () => {
    // `sequence` is part of an event's persisted identity, and the reservation
    // counter is process-local — it cannot know what a store already holds. A
    // constant default session would therefore make a restarted process reserve
    // 0, 1, 2 again and collide with its own durable history. Each source already
    // defends itself this way; this pins the same property for the default.
    const first = createActivityEvent({
      kind: "application_activated",
      payload: { applicationId: "editor", applicationName: "Editor" },
    });
    const second = createActivityEvent({
      kind: "application_activated",
      payload: { applicationId: "editor", applicationName: "Editor" },
    });

    // Within one process the default session is stable and its sequence advances.
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.sequence).toBe(first.sequence + 1);
    expect(first.sessionId).not.toBe("default");
  });

  it("normalizes legacy browser events without an owner to a null owner", () => {
    const event = createActivityEvent({
      kind: "browser_navigated",
      payload: { url: "https://example.com", title: "Example", host: "example.com", owner: null },
    });
    const legacy = { ...event, payload: { url: "https://example.com", title: "Example", host: "example.com" } };
    expect((parseActivityEvent(legacy).payload as { owner: unknown }).owner).toBeNull();
  });

  it("requires new browser events to state owner explicitly", () => {
    expect(() => createActivityEvent({
      kind: "browser_navigated",
      payload: { url: "https://example.com", title: "Example", host: "example.com" },
    })).toThrow("must include an explicit owner");
  });

  it.each([
    ["unknown event kind", { kind: "unknown" }],
    ["invalid timestamp", { occurredAt: "not-a-date" }],
    ["negative sequence", { sequence: -1 }],
    ["unexpected payload field", { payload: { path: "src/main.ts", applicationId: "vscode", extra: true } }],
  ])("rejects %s", (_label, override) => {
    const event = {
      ...createActivityEvent({
        kind: "file_saved",
        sequence: 0,
        payload: { path: "src/main.ts", applicationId: "vscode" },
      }),
      ...override,
    };

    if ("payload" in override) {
      event.payload = override.payload;
    }

    expect(() => parseActivityEvent(event)).toThrow(ActivityEventValidationError);
  });
});
