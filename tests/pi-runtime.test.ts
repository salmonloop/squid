import { describe, expect, it } from "bun:test";
import { normalizePredictionCandidate } from "../src/pi-runtime.js";
import { emptyWorldState } from "../src/protocol.js";

const now = new Date("2026-08-18T12:00:00.000Z");

function stateWithRecentActions() {
  const state = emptyWorldState();
  state.recentActions = [
    {
      kind: "file_saved",
      occurredAt: "2026-08-18T11:59:00.000Z",
      sourceEventId: "event-2",
      target: "src/main.ts",
      outcome: "succeeded",
    },
    {
      kind: "terminal_command",
      occurredAt: "2026-08-18T11:58:00.000Z",
      sourceEventId: "event-1",
      target: "test",
      outcome: "failed",
    },
    {
      kind: "file_saved",
      occurredAt: "2026-08-18T11:57:00.000Z",
      sourceEventId: "event-2",
      target: "src/main.ts",
      outcome: "succeeded",
    },
  ];
  return state;
}

describe("normalizePredictionCandidate", () => {
  it("clamps confidence and attaches unique recent-action provenance", () => {
    const candidate = normalizePredictionCandidate({
      kind: "run_tests",
      rationale: "A code file was saved.",
      confidence: 2,
      expiresAt: "2026-08-18T12:00:10.000Z",
      parameters: { path: "src/main.ts" },
    }, stateWithRecentActions(), now);

    expect(candidate.kind).toBe("run_tests");
    expect(candidate.confidence).toBe(1);
    expect(candidate.sourceEventIds).toEqual(["event-2", "event-1"]);
    expect(candidate.expiresAt).toBe("2026-08-18T12:00:10.000Z");
  });

  it.each([
    ["unknown", "2026-08-18T12:00:10.000Z"],
    ["run_tests", "not-a-date"],
    ["run_tests", "2026-08-18T12:00:00.000Z"],
  ])("returns a safe none candidate for invalid input", (kind, expiresAt) => {
    const candidate = normalizePredictionCandidate({
      kind,
      rationale: "Invalid model output.",
      confidence: -1,
      expiresAt,
      parameters: {},
    }, stateWithRecentActions(), now);

    expect(candidate.kind).toBe("none");
    expect(candidate.confidence).toBe(0);
    expect(candidate.expiresAt).toBe("2026-08-18T12:00:20.000Z");
    expect(candidate.sourceEventIds).toEqual(["event-2", "event-1"]);
  });
});
