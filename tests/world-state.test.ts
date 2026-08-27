import { describe, expect, it } from "bun:test";
import {
  createActivityEvent,
  parseActivityEvent,
  type ActivityEvent,
} from "../src/protocol.js";
import { buildWorldState } from "../src/world-state.js";

const source = { kind: "synthetic" as const, instanceId: "world-state-test" };
const sessionId = "world-state-session";

function event<T>(input: {
  eventId: string;
  sequence: number;
  occurredAt: string;
  kind: ActivityEvent["kind"];
  payload: T;
}): ActivityEvent<T> {
  return createActivityEvent({ ...input, source, sessionId });
}

function browserScene(prefix = "scene"): ActivityEvent[] {
  return [
    event({
      eventId: `${prefix}-app`, sequence: 0, occurredAt: "2026-08-21T10:00:00.000Z",
      kind: "application_activated",
      payload: { applicationId: "browser", applicationName: "Browser" },
    }),
    event({
      eventId: `${prefix}-window`, sequence: 1, occurredAt: "2026-08-21T10:00:01.000Z",
      kind: "window_changed",
      payload: { applicationId: "browser", title: "Docs", bounds: null },
    }),
    event({
      eventId: `${prefix}-focus`, sequence: 2, occurredAt: "2026-08-21T10:00:02.000Z",
      kind: "focus_changed",
      payload: { applicationId: "browser", windowTitle: "Docs", role: "text_input", label: null },
    }),
    event({
      eventId: `${prefix}-page`, sequence: 3, occurredAt: "2026-08-21T10:00:03.000Z",
      kind: "browser_navigated",
      payload: {
        url: "https://example.com/docs",
        title: "Docs",
        host: "example.com",
        owner: { applicationId: "browser", windowTitle: "Docs" },
      },
    }),
    event({
      eventId: `${prefix}-text`, sequence: 4, occurredAt: "2026-08-21T10:00:04.000Z",
      kind: "text_context_changed",
      payload: { prefix: "", suffix: "", selection: "TypeError", language: null },
    }),
  ];
}

describe("WorldState foreground ownership", () => {
  it("clears old window, focus, text, and page when the active application changes", () => {
    const state = buildWorldState([
      ...browserScene("app-switch"),
      event({
        eventId: "app-switch-slack", sequence: 5, occurredAt: "2026-08-21T10:00:05.000Z",
        kind: "application_activated",
        payload: { applicationId: "slack", applicationName: "Slack" },
      }),
    ]);

    expect(state.activeApplication).toEqual({ id: "slack", name: "Slack" });
    expect(state.activeWindow).toBeNull();
    expect(state.focus).toBeNull();
    expect(state.textContext).toBeNull();
    expect(state.currentBrowserPage).toBeNull();
  });

  it("clears old focus, text, and page when the window identity changes", () => {
    const state = buildWorldState([
      ...browserScene("window-switch"),
      event({
        eventId: "window-switch-next", sequence: 5, occurredAt: "2026-08-21T10:00:05.000Z",
        kind: "window_changed",
        payload: { applicationId: "browser", title: "Inbox", bounds: null },
      }),
    ]);

    expect(state.activeWindow?.title).toBe("Inbox");
    expect(state.focus).toBeNull();
    expect(state.textContext).toBeNull();
    expect(state.currentBrowserPage).toBeNull();
  });

  it("does not let a new focus inherit text from another control in the same window", () => {
    const state = buildWorldState([
      ...browserScene("focus-switch"),
      event({
        eventId: "focus-switch-next", sequence: 5, occurredAt: "2026-08-21T10:00:05.000Z",
        kind: "focus_changed",
        payload: { applicationId: "browser", windowTitle: "Docs", role: "text_input", label: "Address" },
      }),
    ]);

    expect(state.focus?.label).toBe("Address");
    expect(state.textContext).toBeNull();
  });

  it("clears a page when focus moves and no active-window observation can prove it is still current", () => {
    const scene = browserScene("focus-owner").filter((item) => item.kind !== "window_changed");
    const state = buildWorldState([
      ...scene,
      event({
        eventId: "focus-owner-other", sequence: 5, occurredAt: "2026-08-21T10:00:05.000Z",
        kind: "focus_changed",
        payload: { applicationId: "browser", windowTitle: "Other", role: "text_input", label: null },
      }),
    ]);

    expect(state.currentBrowserPage).toBeNull();
  });

  it("requires a complete application and window chain before preserving a browser owner", () => {
    const state = buildWorldState([
      event({
        eventId: "partial-focus", sequence: 0, occurredAt: "2026-08-21T10:10:00.000Z",
        kind: "focus_changed",
        payload: { applicationId: "browser", windowTitle: "Docs", role: "text_input", label: null },
      }),
      event({
        eventId: "partial-page", sequence: 1, occurredAt: "2026-08-21T10:10:01.000Z",
        kind: "browser_navigated",
        payload: {
          url: "https://example.com/docs", title: "Docs", host: "example.com",
          owner: { applicationId: "browser", windowTitle: "Docs" },
        },
      }),
    ]);

    expect(state.currentBrowserPage?.owner).toBeNull();
  });
});

describe("WorldState evidence ordering and prediction eligibility", () => {
  it("uses canonical observation ordinals when page and text share a timestamp", () => {
    const at = "2026-08-21T11:00:00.000Z";
    const state = buildWorldState([
      event({
        eventId: "ordinal-text", sequence: 4, occurredAt: at, kind: "text_context_changed",
        payload: { prefix: "", suffix: "", selection: "TypeError", language: null },
      }),
      event({
        eventId: "ordinal-app", sequence: 0, occurredAt: at, kind: "application_activated",
        payload: { applicationId: "browser", applicationName: "Browser" },
      }),
      event({
        eventId: "ordinal-window", sequence: 1, occurredAt: at, kind: "window_changed",
        payload: { applicationId: "browser", title: "Docs", bounds: null },
      }),
      event({
        eventId: "ordinal-focus", sequence: 2, occurredAt: at, kind: "focus_changed",
        payload: { applicationId: "browser", windowTitle: "Docs", role: "text_input", label: null },
      }),
      event({
        eventId: "ordinal-page", sequence: 3, occurredAt: at, kind: "browser_navigated",
        payload: {
          url: "https://example.com/docs", title: "Docs", host: "example.com",
          owner: { applicationId: "browser", windowTitle: "Docs" },
        },
      }),
    ]);

    expect(state.currentBrowserPage?.observationOrdinal).toBe(4);
    expect(state.textContext?.observationOrdinal).toBe(5);
    // Ownership survived the ordinal bookkeeping: the page and the selection
    // belong to the same foreground application, which is what makes a selection
    // searchable at all.
    expect(state.currentBrowserPage?.owner).toEqual({
      applicationId: "browser",
      windowTitle: "Docs",
    });
  });

  it("restores a legacy ownerless page but never treats it as search evidence", () => {
    const canonical = event({
      eventId: "legacy-page", sequence: 0, occurredAt: "2026-08-21T12:00:00.000Z",
      kind: "browser_navigated",
      payload: { url: "https://example.com", title: "Example", host: "example.com", owner: null },
    });
    const legacy = parseActivityEvent({
      ...canonical,
      payload: { url: "https://example.com", title: "Example", host: "example.com" },
    });
    const state = buildWorldState([legacy]);

    expect(state.currentBrowserPage?.owner).toBeNull();
  });

  it("drops page ownership when it mismatches the foreground", () => {
    const events = browserScene("mismatch");
    const page = events.find((item) => item.kind === "browser_navigated")!;
    const state = buildWorldState(events.map((item) => item === page
      ? event({
          eventId: page.eventId,
          sequence: page.sequence,
          occurredAt: page.occurredAt,
          kind: "browser_navigated",
          payload: {
            url: "https://example.com/docs", title: "Docs", host: "example.com",
            owner: { applicationId: "other", windowTitle: "Other" },
          },
        })
      : item));

    expect(state.currentBrowserPage?.owner).toBeNull();
  });

  it("stops treating a failure as the latest outcome after an unrelated event", () => {
    const failed = event({
      eventId: "failed-command", sequence: 0, occurredAt: "2026-08-21T13:00:00.000Z",
      kind: "terminal_command_completed",
      payload: { commandClass: "test", succeeded: false, exitCode: 1 },
    });
    const afterFailure = buildWorldState([failed]);
    const afterPointer = buildWorldState([
      failed,
      event({
        eventId: "after-failure", sequence: 1, occurredAt: "2026-08-21T13:00:01.000Z",
        kind: "pointer_action", payload: {},
      }),
    ]);

    // The failure is the projection's last command outcome right after it lands,
    // and `lastEventKind` moves on once anything else happens — which is how a
    // reader tells "the tests just failed" from "they failed a while ago".
    expect(afterFailure.lastCommandOutcome?.succeeded).toBe(false);
    expect(afterFailure.lastEventKind).toBe("terminal_command_completed");
    expect(afterPointer.lastCommandOutcome?.succeeded).toBe(false);
    expect(afterPointer.lastEventKind).toBe("pointer_action");
  });
});
