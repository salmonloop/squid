import { describe, expect, it } from "bun:test";
import { compareActivityEvents, eventIdentity, orderActivityEvents } from "../src/chronicle-ordering.js";
import { createActivityEvent } from "../src/protocol.js";

function event(input: Parameters<typeof createActivityEvent>[0]) {
  return createActivityEvent({
    source: { kind: "synthetic", instanceId: "fixture" },
    sessionId: "fixture-session",
    ...input,
  });
}

describe("Chronicle ordering", () => {
  it("orders equivalent arrival permutations canonically", () => {
    const first = event({
      kind: "file_opened",
      eventId: "event-b",
      sequence: 1,
      occurredAt: "2026-08-18T12:00:00.000Z",
      payload: { path: "b.ts", applicationId: "editor" },
    });
    const second = event({
      kind: "file_opened",
      eventId: "event-a",
      sequence: 0,
      occurredAt: "2026-08-18T12:00:00.000Z",
      payload: { path: "a.ts", applicationId: "editor" },
    });
    const third = event({
      kind: "file_opened",
      eventId: "event-c",
      sequence: 2,
      occurredAt: "2026-08-18T12:00:01.000Z",
      payload: { path: "c.ts", applicationId: "editor" },
    });

    expect(orderActivityEvents([third, first, second]).map((value) => value.eventId))
      .toEqual(orderActivityEvents([second, third, first]).map((value) => value.eventId));
    expect(orderActivityEvents([third, first, second]).map((value) => value.eventId))
      .toEqual(["event-a", "event-b", "event-c"]);
    expect(compareActivityEvents(first, second)).toBeGreaterThan(0);
  });

  it("compares equivalent instants by time rather than timestamp spelling", () => {
    const utc = event({
      kind: "file_opened",
      eventId: "utc",
      sequence: 0,
      occurredAt: "2026-08-18T12:00:00.000Z",
      payload: { path: "utc.ts", applicationId: "editor" },
    });
    const offset = event({
      kind: "file_opened",
      eventId: "offset",
      sequence: 0,
      occurredAt: "2026-08-18T12:30:00.000+01:00",
      payload: { path: "offset.ts", applicationId: "editor" },
    });

    expect(orderActivityEvents([utc, offset]).map((value) => value.eventId)).toEqual(["offset", "utc"]);
  });

  it("uses source, instance, session, and sequence as source-local identity", () => {
    const first = event({
      kind: "file_opened",
      sequence: 7,
      payload: { path: "a.ts", applicationId: "editor" },
    });
    const second = event({
      kind: "file_saved",
      sequence: 7,
      payload: { path: "a.ts", applicationId: "editor" },
    });

    expect(eventIdentity(first)).toBe(eventIdentity(second));
  });
});
