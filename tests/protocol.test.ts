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
