import { describe, expect, it } from "bun:test";
import { sensePromptLines } from "../src/agent-senses.js";
import { emptyWorldState } from "../src/protocol.js";
import type { ToolSummary } from "../src/tool-catalog.js";
import type { WorldState } from "../src/protocol.js";

const tool: ToolSummary = {
  id: "run_tests",
  title: "Run tests",
  category: "run_tests",
  parameters: {},
  risk: "mutates_workspace",
};

describe("sensePromptLines", () => {
  it("renders the header and tool catalog even on an empty state", () => {
    const lines = sensePromptLines(emptyWorldState(), [tool]);
    expect(lines[0]).toBe("# Current world state");
    expect(lines).toContain("# Tool catalog");
    // catalogPromptLines is reused — the tool id appears.
    expect(lines.some((l) => l.includes("run_tests"))).toBe(true);
  });

  it("omits every field line when the state is empty", () => {
    const lines = sensePromptLines(emptyWorldState(), []);
    // Only header + blank + catalog header + (empty catalog body).
    expect(lines.some((l) => l.startsWith("updated_at:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("last_event:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("active_application:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("recent_actions:"))).toBe(false);
  });

  it("renders updatedAt and lastEventKind when present", () => {
    const state: WorldState = {
      ...emptyWorldState(),
      updatedAt: "2026-08-26T00:00:00Z",
      lastEventKind: "window_changed",
    };
    const lines = sensePromptLines(state, []);
    expect(lines).toContain("updated_at: 2026-08-26T00:00:00Z");
    expect(lines).toContain("last_event: window_changed");
  });

  it("renders focus and active window together", () => {
    const state: WorldState = {
      ...emptyWorldState(),
      activeWindow: { applicationId: "com.vslivedit", title: "main.ts", bounds: null },
      focus: {
        applicationId: "com.vslivedit",
        windowTitle: "main.ts",
        role: "editor",
        label: null,
      },
    };
    const lines = sensePromptLines(state, []);
    expect(lines.some((l) => l.startsWith("active_window:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("focus:"))).toBe(true);
    expect(lines.some((l) => l.includes("role=editor"))).toBe(true);
  });

  it("renders text_context with truncation markers for long selection", () => {
    const longText = "x".repeat(300);
    const state: WorldState = {
      ...emptyWorldState(),
      textContext: {
        owner: null,
        prefix: "abc",
        suffix: "def",
        selection: longText,
        language: "typescript",
        sourceEventId: "ev-1",
        observedAt: "2026-08-26T00:00:00Z",
        observationOrdinal: 1,
      },
    };
    const lines = sensePromptLines(state, []);
    const ctxLine = lines.find((l) => l.startsWith("text_context:"));
    expect(ctxLine).toBeDefined();
    expect(ctxLine!.includes("language=typescript")).toBe(true);
    // Truncated selection ends with the ellipsis, not the full 300 chars.
    expect(ctxLine!.includes("…")).toBe(true);
    expect(ctxLine!.includes("x".repeat(300))).toBe(false);
  });

  it("renders recent_actions as a labeled list", () => {
    const state: WorldState = {
      ...emptyWorldState(),
      recentActions: [
        {
          kind: "copy",
          occurredAt: "2026-08-26T00:00:00Z",
          sourceEventId: "ev-1",
          applicationId: "com.app",
          target: "snippet.txt",
          outcome: "succeeded",
        },
      ],
    };
    const lines = sensePromptLines(state, []);
    expect(lines).toContain("recent_actions:");
    expect(lines.some((l) => l.includes("kind=copy") && l.includes("outcome=succeeded"))).toBe(true);
  });

  it("renders capture_gate as paused or open", () => {
    const paused: WorldState = {
      ...emptyWorldState(),
      captureGate: {
        paused: true,
        sourceEventId: "ev-1",
        occurredAt: "2026-08-26T00:00:00Z",
      },
    };
    expect(sensePromptLines(paused, [])).toContain("capture_gate: paused");

    const open: WorldState = {
      ...emptyWorldState(),
      captureGate: {
        paused: false,
        sourceEventId: "ev-2",
        occurredAt: "2026-08-26T00:00:00Z",
      },
    };
    expect(sensePromptLines(open, [])).toContain("capture_gate: open");
  });

  it("renders the tool catalog via catalogPromptLines (reuse, not re-implementation)", () => {
    const tools: readonly ToolSummary[] = [
      tool,
      { id: "run_check", title: "Run check", category: "inspect_error", parameters: {}, risk: "read_only" },
    ];
    const lines = sensePromptLines(emptyWorldState(), tools);
    // Both tool ids appear in the catalog section, after the catalog header.
    const catalogStart = lines.indexOf("# Tool catalog");
    const catalogBody = lines.slice(catalogStart).join("\n");
    expect(catalogBody.includes("run_tests")).toBe(true);
    expect(catalogBody.includes("run_check")).toBe(true);
  });
});
