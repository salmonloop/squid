import { describe, expect, it } from "bun:test";
import { DEFAULT_EPISODE_GAP_MS, segmentEpisodes } from "../src/episode.js";
import { createActivityEvent, type ActivityEvent } from "../src/protocol.js";
import { buildWorldState } from "../src/world-state.js";

const source = { kind: "synthetic" as const, instanceId: "episode-test" };
const sessionId = "episode-session";

function event(input: {
  eventId: string;
  sequence: number;
  occurredAt: string;
  kind?: ActivityEvent["kind"];
  payload?: unknown;
}): ActivityEvent {
  return createActivityEvent({
    source,
    sessionId,
    kind: input.kind ?? "pointer_action",
    payload: input.payload ?? {},
    ...input,
  });
}

describe("episode segmentation", () => {
  it("returns no episodes for an empty timeline", () => {
    expect(segmentEpisodes([])).toEqual([]);
  });

  it("groups activity below the gap and splits at the exact boundary", () => {
    const first = event({ eventId: "first", sequence: 0, occurredAt: "2026-08-19T09:00:00.000Z" });
    const within = event({ eventId: "within", sequence: 1, occurredAt: "2026-08-19T09:04:59.999Z" });
    const boundary = event({ eventId: "boundary", sequence: 2, occurredAt: "2026-08-19T09:09:59.999Z" });

    expect(segmentEpisodes([boundary, first, within])).toEqual([
      {
        id: "episode-2026-08-19T09:00:00.000Z-first",
        startedAt: "2026-08-19T09:00:00.000Z",
        endedAt: "2026-08-19T09:04:59.999Z",
        eventIds: ["first", "within"],
      },
      {
        id: "episode-2026-08-19T09:09:59.999Z-boundary",
        startedAt: "2026-08-19T09:09:59.999Z",
        endedAt: "2026-08-19T09:09:59.999Z",
        eventIds: ["boundary"],
      },
    ]);
  });

  it("derives stable episode IDs across runs", () => {
    const events = [event({ eventId: "stable", sequence: 0, occurredAt: "2026-08-19T10:00:00.000Z" })];

    expect(segmentEpisodes(events)).toEqual(segmentEpisodes(events));
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("rejects an invalid gap of %p", (gapMs) => {
    expect(() => segmentEpisodes([], gapMs)).toThrow(
      "Episode gap must be a finite, non-negative duration in milliseconds.",
    );
  });
});

describe("episode-scoped world state", () => {
  it("clears context that has not been re-established after the gap", () => {
    const events = [
      event({
        eventId: "app",
        sequence: 0,
        occurredAt: "2026-08-19T11:00:00.000Z",
        kind: "application_activated",
        payload: { applicationId: "vscode", applicationName: "Visual Studio Code" },
      }),
      event({
        eventId: "window",
        sequence: 1,
        occurredAt: "2026-08-19T11:00:01.000Z",
        kind: "window_changed",
        payload: { applicationId: "vscode", title: "main.ts", bounds: null },
      }),
      event({
        eventId: "focus",
        sequence: 2,
        occurredAt: "2026-08-19T11:00:02.000Z",
        kind: "focus_changed",
        payload: { applicationId: "vscode", windowTitle: "main.ts", role: "editor", label: null },
      }),
      event({
        eventId: "text",
        sequence: 3,
        occurredAt: "2026-08-19T11:00:03.000Z",
        kind: "text_context_changed",
        payload: { prefix: "stale", suffix: "", selection: "", language: "ts" },
      }),
      event({
        eventId: "browser",
        sequence: 4,
        occurredAt: "2026-08-19T11:00:04.000Z",
        kind: "browser_navigated",
        payload: { url: "https://example.com", title: "Example", host: "example.com", owner: null },
      }),
      event({
        eventId: "save",
        sequence: 5,
        occurredAt: "2026-08-19T11:00:05.000Z",
        kind: "file_saved",
        payload: { path: "src/main.ts", applicationId: "vscode" },
      }),
      event({
        eventId: "command",
        sequence: 6,
        occurredAt: "2026-08-19T11:00:06.000Z",
        kind: "terminal_command_completed",
        payload: { commandClass: "test", succeeded: false, exitCode: 1 },
      }),
      event({ eventId: "after-gap", sequence: 7, occurredAt: "2026-08-19T12:00:00.000Z" }),
    ];

    const state = buildWorldState(events);

    expect(state.activeApplication).toBeNull();
    expect(state.activeWindow).toBeNull();
    expect(state.focus).toBeNull();
    expect(state.currentBrowserPage).toBeNull();
    expect(state.recentFiles).toEqual([]);
    expect(state.recentActions).toEqual([]);
    expect(state.lastCommandOutcome).toBeNull();
    expect(state.episode).toEqual({
      id: "episode-2026-08-19T12:00:00.000Z-after-gap",
      startedAt: "2026-08-19T12:00:00.000Z",
      eventCount: 1,
    });
  });

  it("re-establishes only foreground state carried by the boundary event", () => {
    const state = buildWorldState([
      event({
        eventId: "old-app",
        sequence: 0,
        occurredAt: "2026-08-19T12:30:00.000Z",
        kind: "application_activated",
        payload: { applicationId: "vscode", applicationName: "Visual Studio Code" },
      }),
      event({
        eventId: "old-window",
        sequence: 1,
        occurredAt: "2026-08-19T12:30:01.000Z",
        kind: "window_changed",
        payload: { applicationId: "vscode", title: "main.ts", bounds: null },
      }),
      event({
        eventId: "new-app",
        sequence: 2,
        occurredAt: "2026-08-19T13:30:01.000Z",
        kind: "application_activated",
        payload: { applicationId: "slack", applicationName: "Slack" },
      }),
    ]);

    expect(state.activeApplication).toEqual({ id: "slack", name: "Slack" });
    expect(state.activeWindow).toBeNull();
  });

  it("keeps context when the gap is below the threshold", () => {
    const first = event({
      eventId: "focus-short",
      sequence: 0,
      occurredAt: "2026-08-19T13:00:00.000Z",
      kind: "focus_changed",
      payload: { applicationId: "editor", windowTitle: "draft.md", role: "editor", label: null },
    });
    const text = event({
      eventId: "text-short",
      sequence: 1,
      occurredAt: "2026-08-19T13:00:01.000Z",
      kind: "text_context_changed",
      payload: { prefix: "current", suffix: "", selection: "", language: "en" },
    });
    const within = event({
      eventId: "within-short",
      sequence: 2,
      occurredAt: new Date(
        new Date(text.occurredAt).getTime() + DEFAULT_EPISODE_GAP_MS - 1,
      ).toISOString(),
    });

    const state = buildWorldState([first, text, within]);

    expect(state.textContext?.prefix).toBe("current");
    expect(state.episode).toEqual({
      id: "episode-2026-08-19T13:00:00.000Z-focus-short",
      startedAt: "2026-08-19T13:00:00.000Z",
      eventCount: 3,
    });
  });
});
