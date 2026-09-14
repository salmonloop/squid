import { describe, expect, it } from "bun:test";
import {
  panelAgentLine,
  panelAgentThinking,
  panelConfigEnd,
  panelConfigLine,
  panelConfigResult,
  panelLine,
  panelServiceLine,
  panelSourceLine,
  panelWorldState,
} from "../src/panel-view.js";
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

describe("panelAgentThinking", () => {
  it("spells the flag as 1 and 0, never as booleans", () => {
    expect(panelAgentThinking(true)).toEqual({ type: "agent_thinking", thinking: 1 });
    expect(panelAgentThinking(false)).toEqual({ type: "agent_thinking", thinking: 0 });
    // The wire carries integers only; `true` here would be a whole line the
    // Rust parser drops.
    expect(JSON.parse(panelLine(panelAgentThinking(true))).thinking).toBe(1);
  });

  it("carries nothing but the flag — the line is one bit wide", () => {
    expect(Object.keys(panelAgentThinking(true))).toEqual(["type", "thinking"]);
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

describe("panelConfigLine", () => {
  it("emits the flat row a settings form renders, values joined with ;", () => {
    expect(panelConfigLine({
      id: "screenReader",
      label: "Screen reader",
      kind: "enum",
      value: "synthetic",
      applies: "restart",
      overridden: true,
      values: ["synthetic", "darwin", "linux", "windows"],
      group: "Screen",
      description: "How Squid reads the words on your screen.",
    })).toEqual({
      type: "config",
      id: "screenReader",
      label: "Screen reader",
      kind: "enum",
      value: "synthetic",
      applies: "restart",
      overridden: 1,
      values: "synthetic;darwin;linux;windows",
      // Scalars beside the rest, not a nested shape: the panel buckets rows by
      // this string, and a tree here would mean teaching the hand-written Rust
      // parser arrays and objects to say what a flat pass already says.
      group: "Screen",
      description: "How Squid reads the words on your screen.",
    });
  });

  it("omits overridden when false and values when there are none", () => {
    const line = panelConfigLine({
      id: "watchRoot",
      label: "Watch root",
      kind: "text",
      value: "/home/me",
      applies: "restart",
      overridden: false,
    });
    expect("overridden" in line).toBe(false);
    expect("values" in line).toBe(false);
    // The display fields go the same way. A caller that has only the five
    // required fields still gets a wire-legal row, which is the compatibility
    // the metadata was added as optional scalars to keep: an older brain omits
    // them and the panel loses a heading, never the row.
    expect("group" in line).toBe(false);
    expect("description" in line).toBe(false);
    expect("secretPresent" in line).toBe(false);
    // Absence on the object must survive framing: the flat parser's
    // first-key-wins has no null case to fall back on.
    const framed = JSON.parse(panelLine(line));
    expect("overridden" in framed).toBe(false);
    expect("values" in framed).toBe(false);
    expect("group" in framed).toBe(false);
    expect("description" in framed).toBe(false);
    expect("secretPresent" in framed).toBe(false);
  });

  it("passes a secret's empty value through as the empty string", () => {
    // The dump already stripped the value upstream; the builder's job is to
    // not be the place where one could sneak back in, so this asserts the
    // passthrough rather than trusting sanitization to act differently here.
    const line = panelConfigLine({
      id: "apiKey",
      label: "API key",
      kind: "secret",
      value: "",
      applies: "now",
      overridden: false,
    });
    expect(line.value).toBe("");
    expect(JSON.parse(panelLine(line)).value).toBe("");
  });

  it("discloses that a secret is stored without carrying any of it", () => {
    // `secretPresent` is spelled the way `overridden` is — 1 or absent — because
    // it is the same kind of thing: a claim about the value rather than the
    // value. What it buys is the difference between an empty field the user may
    // leave alone and one they must fill, which was previously knowable only by
    // saving an empty value and reading the refusal back.
    const stored = panelConfigLine({
      id: "apiKey",
      label: "API key",
      kind: "secret",
      value: "",
      applies: "now",
      overridden: false,
      secretPresent: true,
    });
    expect(stored.secretPresent).toBe(1);
    // Still no value, in the same line that admits a key exists. The flag is
    // the whole disclosure; if this ever carried text the exception would have
    // become the thing it was allowed instead of.
    expect(stored.value).toBe("");
    expect(JSON.parse(panelLine(stored)).secretPresent).toBe(1);

    const absent = panelConfigLine({
      id: "apiKey",
      label: "API key",
      kind: "secret",
      value: "",
      applies: "now",
      overridden: false,
      secretPresent: false,
    });
    // Omitted rather than sent as 0: "nothing stored" already has a spelling on
    // this wire, and it is the missing field.
    expect("secretPresent" in absent).toBe(false);
  });

  it("sanitizes group and description like every other display string", () => {
    // Authored strings today, which is exactly why they are not trusted: a
    // choke point that sanitized some of its display fields and not others is
    // one edit away from putting a control character on a line the panel parses
    // by hand. Escaped rather than literal control bytes in this source — a raw
    // one makes git treat the file as binary and grep go quiet on it.
    const line = panelConfigLine({
      id: "retentionHours",
      label: "Retention (hours)",
      kind: "int",
      value: "72",
      applies: "restart",
      overridden: false,
      group: "His\u0007tory",
      description: "How long Squid keeps what it\u0007recorded.",
    });
    expect(line.group).not.toContain("\u0007");
    expect(line.description).not.toContain("\u0007");
    // And the framed line still parses as one object, which is the property the
    // sanitizer is actually protecting.
    expect(JSON.parse(panelLine(line)).type).toBe("config");
  });

  it("sanitizes id, label, and value as diagnostics", () => {
    // A value came from a file the user hand-edited, so none of the three
    // fields is trusted prose — the sanitizer is what keeps the line flat.
    const line = panelConfigLine({
      id: "watchRoot",
      label: "Watch root",
      kind: "text",
      value: "/home/me\u0007/notes",
      applies: "restart",
      overridden: false,
    });
    expect(line.value).not.toContain("\u0007");
  });
});

describe("panelConfigEnd", () => {
  it("closes a dump with the entry count", () => {
    expect(panelConfigEnd(18)).toEqual({ type: "config_end", count: 18 });
  });
});

describe("panelConfigResult", () => {
  it("maps ok to the wire booleans and carries applies on success", () => {
    expect(panelConfigResult({ id: "watchRoot", ok: true, applies: "restart" })).toEqual({
      type: "config_result",
      id: "watchRoot",
      ok: 1,
      applies: "restart",
    });
  });

  it("carries a sanitized error instead of applies on failure", () => {
    const result = panelConfigResult({
      id: "retentionHours",
      ok: false,
      error: "Retention (hours) must be a positive integer.",
    });
    expect(result).toEqual({
      type: "config_result",
      id: "retentionHours",
      ok: 0,
      error: "Retention (hours) must be a positive integer.",
    });
  });

  it("omits id when the dump itself failed, so nothing is attributable to a row", () => {
    const result = panelConfigResult({ ok: false, error: "config file is malformed" });
    expect("id" in result).toBe(false);
    expect(JSON.parse(panelLine(result)).id).toBeUndefined();
  });

  it("sanitizes id and error like every diagnostic on the wire", () => {
    const result = panelConfigResult({ id: "key\u0007", ok: false, error: "bad\u0007" });
    expect(result.id).not.toContain("\u0007");
    expect(result.error).not.toContain("\u0007");
  });
});

describe("panelSourceLine", () => {
  it("states the catalog row without a detail when the source has none", () => {
    expect(panelSourceLine({ id: "filesystem-local", label: "Files", state: "running" })).toEqual({
      type: "source",
      id: "filesystem-local",
      label: "Files",
      state: "running",
    });
  });

  /**
   * The detail is how "running but blind" reaches the card: a screen reader
   * without its accessibility permission keeps polling and keeps being refused,
   * and the state stays `running` because it is. Omitted rather than empty when
   * absent — the wire omits what it does not have.
   */
  it("carries the newest diagnostic verbatim when the running source has one", () => {
    expect(
      panelSourceLine({
        id: "screen-text-host",
        label: "Screen",
        state: "running",
        detail: "xdotool exited 1: no DISPLAY",
      }),
    ).toEqual({
      type: "source",
      id: "screen-text-host",
      label: "Screen",
      state: "running",
      detail: "xdotool exited 1: no DISPLAY",
    });
  });

  it("sanitizes the detail like every diagnostic on the wire", () => {
    // A reader's refusal can quote what it saw — a window title holding a
    // credential, control bytes from a hostile file. The detail is a diagnostic
    // and passes the same choke point as the id and label beside it.
    const line = panelSourceLine({
      id: "screen-text-host",
      label: "Screen",
      state: "running",
      detail: "bad\u0007 title\u0007",
    });
    expect(line.detail).not.toContain("\u0007");
  });
});
