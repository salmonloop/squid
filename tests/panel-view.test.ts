import { describe, expect, it } from "bun:test";
import { panelAgentLine, panelLine, panelServiceLine, panelWorldState } from "../src/panel-view.js";
import { emptyWorldState } from "../src/protocol.js";
import type { SemanticAction, WorldState } from "../src/protocol.js";

function action(kind: string, at: string): SemanticAction {
  return {
    kind,
    occurredAt: at,
    sourceEventId: `ev-${kind}`,
    applicationId: "com.app",
    target: null,
    outcome: "succeeded",
  };
}

describe("panelWorldState", () => {
  it("returns null for a fresh state, rather than inventing a timestamp", () => {
    expect(panelWorldState(emptyWorldState())).toBeNull();
  });

  it("reports updatedAt and lastEvent from the projection", () => {
    const state: WorldState = {
      ...emptyWorldState(),
      updatedAt: "2026-08-27T10:00:00.000Z",
      lastEventKind: "file_saved",
    };
    expect(panelWorldState(state)).toEqual({
      type: "world_state",
      updatedAt: "2026-08-27T10:00:00.000Z",
      lastEvent: "file_saved",
    });
  });

  it("sends the application name, not its id", () => {
    const state: WorldState = {
      ...emptyWorldState(),
      updatedAt: "2026-08-27T10:00:00.000Z",
      activeApplication: { id: "com.microsoft.VSCode", name: "Code" },
    };
    const view = panelWorldState(state);
    expect(view?.application).toBe("Code");
    expect(panelLine(view!)).not.toContain("com.microsoft.VSCode");
  });

  it("reports the gate position as open or paused", () => {
    const base: WorldState = { ...emptyWorldState(), updatedAt: "2026-08-27T10:00:00.000Z" };
    const paused = panelWorldState({
      ...base,
      captureGate: { paused: true, sourceEventId: "ev-1", occurredAt: "2026-08-27T10:00:00.000Z" },
    });
    expect(paused?.gate).toBe("paused");
    const open = panelWorldState({
      ...base,
      captureGate: { paused: false, sourceEventId: "ev-2", occurredAt: "2026-08-27T10:00:00.000Z" },
    });
    expect(open?.gate).toBe("open");
    // Absent until a gate event is seen — "unknown" is not "open".
    expect(panelWorldState(base)?.gate).toBeUndefined();
  });

  it("reports the episode event count", () => {
    const state: WorldState = {
      ...emptyWorldState(),
      updatedAt: "2026-08-27T10:00:00.000Z",
      episode: { id: "ep-1", startedAt: "2026-08-27T09:00:00.000Z", eventCount: 17 },
    };
    expect(panelWorldState(state)?.episodeEvents).toBe(17);
  });
});

describe("panelWorldState privacy boundary", () => {
  it("never lets the raw selection cross the wire, only its length", () => {
    const selection = "SELECT secret_column FROM vault WHERE distinctive_marker_zqxjkv = 1";
    const state: WorldState = {
      ...emptyWorldState(),
      updatedAt: "2026-08-27T10:00:00.000Z",
      textContext: {
        owner: null,
        prefix: "before",
        suffix: "after",
        selection,
        language: "sql",
        sourceEventId: "ev-1",
        observedAt: "2026-08-27T10:00:00.000Z",
        observationOrdinal: 1,
      },
    };
    const line = panelLine(panelWorldState(state)!);
    expect(line).not.toContain(selection);
    expect(line).not.toContain("distinctive_marker_zqxjkv");
    expect(line).not.toContain("secret_column");
    expect(JSON.parse(line).selectionLength).toBe(selection.length);
  });

  it("measures the original selection length, not a truncated one", () => {
    // Well past AUDIT_TEXT_MAX_LENGTH: the panel shows how much was selected,
    // which a length capped at the preview ceiling would understate.
    const selection = "y".repeat(5000);
    const state: WorldState = {
      ...emptyWorldState(),
      updatedAt: "2026-08-27T10:00:00.000Z",
      textContext: {
        owner: null,
        prefix: "",
        suffix: "",
        selection,
        language: null,
        sourceEventId: "ev-1",
        observedAt: "2026-08-27T10:00:00.000Z",
        observationOrdinal: 1,
      },
    };
    const line = panelLine(panelWorldState(state)!);
    expect(JSON.parse(line).selectionLength).toBe(5000);
    expect(line).not.toContain("yyyy");
  });

  it("reports selectionLength 0 for an empty selection rather than omitting it", () => {
    // A cursor with nothing selected is an observation; omitting the field would
    // make it indistinguishable from "no text context seen at all".
    const state: WorldState = {
      ...emptyWorldState(),
      updatedAt: "2026-08-27T10:00:00.000Z",
      textContext: {
        owner: null,
        prefix: "abc",
        suffix: "def",
        selection: "",
        language: null,
        sourceEventId: "ev-1",
        observedAt: "2026-08-27T10:00:00.000Z",
        observationOrdinal: 1,
      },
    };
    const parsed = JSON.parse(panelLine(panelWorldState(state)!));
    expect(parsed.selectionLength).toBe(0);
    expect("selectionLength" in parsed).toBe(true);
  });

  it("redacts a credential-shaped token out of a window title", () => {
    const state: WorldState = {
      ...emptyWorldState(),
      updatedAt: "2026-08-27T10:00:00.000Z",
      activeWindow: {
        applicationId: "com.terminal",
        title: "curl — Bearer sk_live_abcdef0123456789ABCDEF",
        bounds: null,
      },
    };
    const view = panelWorldState(state);
    expect(view?.window).toContain("[redacted]");
    expect(view?.window).not.toContain("sk_live_abcdef0123456789ABCDEF");
    expect(panelLine(view!)).not.toContain("sk_live_");
  });

  it("strips control characters out of a window title", () => {
    // Raw control characters are illegal on the wire; the sanitizer is what makes
    // the line parseable rather than the serializer escaping them through.
    const state: WorldState = {
      ...emptyWorldState(),
      updatedAt: "2026-08-27T10:00:00.000Z",
      activeWindow: {
        applicationId: "com.terminal",
        title: "main\u0000.ts\u001b[31m tail",
        bounds: null,
      },
    };
    const line = panelLine(panelWorldState(state)!);
    expect(line).not.toContain("\\u0000");
    expect(line).not.toContain("\\u001b");
    expect(JSON.parse(line).window).toBe("main .ts [31m tail");
  });
});

describe("panelWorldState field omission", () => {
  it("omits absent fields entirely, never as null or as a present undefined key", () => {
    const state: WorldState = { ...emptyWorldState(), updatedAt: "2026-08-27T10:00:00.000Z" };
    const view = panelWorldState(state)!;
    const parsed = JSON.parse(panelLine(view));

    expect(Object.keys(parsed)).toEqual(["type", "updatedAt"]);
    for (const key of [
      "lastEvent",
      "application",
      "window",
      "gate",
      "selectionLength",
      "recentActions",
      "episodeEvents",
    ]) {
      expect(key in parsed).toBe(false);
    }
    // Also absent from the object itself, not merely dropped by JSON.stringify.
    expect("application" in view).toBe(false);
  });

  it("emits a flat object with no nested objects or arrays", () => {
    const state: WorldState = {
      ...emptyWorldState(),
      updatedAt: "2026-08-27T10:00:00.000Z",
      lastEventKind: "file_saved",
      activeApplication: { id: "com.app", name: "Code" },
      activeWindow: { applicationId: "com.app", title: "main.ts", bounds: null },
      episode: { id: "ep-1", startedAt: "2026-08-27T09:00:00.000Z", eventCount: 3 },
      captureGate: { paused: false, sourceEventId: "ev-1", occurredAt: "2026-08-27T10:00:00.000Z" },
      recentActions: [action("copy", "2026-08-27T10:00:00.000Z")],
    };
    const parsed = JSON.parse(panelLine(panelWorldState(state)!));
    for (const value of Object.values(parsed)) {
      expect(Array.isArray(value)).toBe(false);
      expect(typeof value === "object" && value !== null).toBe(false);
    }
  });

  it("keeps episodeEvents an integer, as the parser requires", () => {
    const state: WorldState = {
      ...emptyWorldState(),
      updatedAt: "2026-08-27T10:00:00.000Z",
      episode: { id: "ep-1", startedAt: "2026-08-27T09:00:00.000Z", eventCount: 4 },
    };
    const line = panelLine(panelWorldState(state)!);
    expect(line).toContain('"episodeEvents":4');
    expect(Number.isInteger(JSON.parse(line).episodeEvents)).toBe(true);
  });
});

describe("panelWorldState recentActions", () => {
  it("joins kinds with ';' newest last, reversing the projection's order", () => {
    // world-state.ts prepends, so index 0 is the newest.
    const state: WorldState = {
      ...emptyWorldState(),
      updatedAt: "2026-08-27T10:00:00.000Z",
      recentActions: [
        action("file_saved", "2026-08-27T10:00:02.000Z"),
        action("copy", "2026-08-27T10:00:01.000Z"),
        action("focus", "2026-08-27T10:00:00.000Z"),
      ],
    };
    expect(panelWorldState(state)?.recentActions).toBe("focus;copy;file_saved");
  });

  it("sends a string, not an array, so the parser stays flat", () => {
    const state: WorldState = {
      ...emptyWorldState(),
      updatedAt: "2026-08-27T10:00:00.000Z",
      recentActions: [action("copy", "2026-08-27T10:00:00.000Z")],
    };
    const parsed = JSON.parse(panelLine(panelWorldState(state)!));
    expect(typeof parsed.recentActions).toBe("string");
    expect(parsed.recentActions).toBe("copy");
  });

  it("omits recentActions when nothing has happened yet", () => {
    const state: WorldState = { ...emptyWorldState(), updatedAt: "2026-08-27T10:00:00.000Z" };
    expect("recentActions" in JSON.parse(panelLine(panelWorldState(state)!))).toBe(false);
  });

  it("does not mutate the projection while reordering", () => {
    const recentActions = [
      action("file_saved", "2026-08-27T10:00:01.000Z"),
      action("copy", "2026-08-27T10:00:00.000Z"),
    ];
    const state: WorldState = {
      ...emptyWorldState(),
      updatedAt: "2026-08-27T10:00:00.000Z",
      recentActions,
    };
    panelWorldState(state);
    expect(recentActions.map((a) => a.kind)).toEqual(["file_saved", "copy"]);
  });
});

describe("panelAgentLine", () => {
  it("carries status and sanitized text", () => {
    const line = panelAgentLine({
      status: "replied",
      text: "ran the tests; they pass",
      at: "2026-08-27T10:00:01.000Z",
    });
    expect(line).toEqual({
      type: "agent",
      at: "2026-08-27T10:00:01.000Z",
      status: "replied",
      text: "ran the tests; they pass",
    });
  });

  it("redacts a credential out of agent text", () => {
    const line = panelAgentLine({
      status: "failed",
      text: "request failed with token=abcdef0123456789",
      at: "2026-08-27T10:00:01.000Z",
    });
    expect(line.text).toContain("[redacted]");
    expect(line.text).not.toContain("abcdef0123456789");
  });

  it("caps a long agent reply rather than streaming a transcript to the panel", () => {
    const line = panelAgentLine({ status: "replied", text: "z".repeat(500) });
    expect(line.text!.length).toBeLessThanOrEqual(201);
    expect(line.text!.endsWith("…")).toBe(true);
  });

  it("omits text when none was given", () => {
    const line = panelAgentLine({ status: "failed", at: "2026-08-27T10:00:01.000Z" });
    expect("text" in line).toBe(false);
    expect("text" in JSON.parse(panelLine(line))).toBe(false);
  });

  it("keeps an empty reply as an empty string, since that is still an answer", () => {
    const line = panelAgentLine({ status: "replied", text: "", at: "2026-08-27T10:00:01.000Z" });
    expect(line.text).toBe("");
    expect("text" in line).toBe(true);
  });

  it("stamps now when no instant is given", () => {
    const before = Date.now();
    const line = panelAgentLine({ status: "replied" });
    const at = Date.parse(line.at);
    expect(Number.isNaN(at)).toBe(false);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe("panelLine", () => {
  it("emits exactly one newline-terminated JSON object", () => {
    const line = panelLine(panelAgentLine({ status: "replied", at: "2026-08-27T10:00:01.000Z" }));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line).type).toBe("agent");
  });

  it("frames a world_state with its type discriminator", () => {
    const state: WorldState = { ...emptyWorldState(), updatedAt: "2026-08-27T10:00:00.000Z" };
    expect(JSON.parse(panelLine(panelWorldState(state)!)).type).toBe("world_state");
  });
});

describe("panelServiceLine", () => {
  it("carries the agent state as a flat object with nothing else", () => {
    expect(panelServiceLine({ agentState: "needs_config" })).toEqual({
      type: "service",
      agentState: "needs_config",
    });
    expect(panelServiceLine({ agentState: "ready" })).toEqual({
      type: "service",
      agentState: "ready",
    });
  });

  it("frames as one newline-terminated line, like every message", () => {
    const line = panelLine(panelServiceLine({ agentState: "needs_config" }));
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line).type).toBe("service");
  });
});
