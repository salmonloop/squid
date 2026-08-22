import { describe, expect, it } from "bun:test";
import { normalizePredictionCandidate } from "../src/pi-runtime.js";
import { emptyWorldState } from "../src/protocol.js";
import type { PredictionProvider, PredictionRequest } from "../src/prediction-provider.js";
import type { PredictionCandidate } from "../src/protocol.js";

const now = new Date("2026-08-18T12:00:00.000Z");

function stateWithRecentActions() {
  const state = emptyWorldState();
  state.recentActions = [
    {
      kind: "file_saved",
      occurredAt: "2026-08-18T11:59:00.000Z",
      sourceEventId: "event-2",
      applicationId: "code",
      target: "src/main.ts",
      outcome: "succeeded",
    },
    {
      kind: "terminal_command",
      occurredAt: "2026-08-18T11:58:00.000Z",
      sourceEventId: "event-1",
      applicationId: null,
      target: "test",
      outcome: "failed",
    },
    {
      kind: "file_saved",
      occurredAt: "2026-08-18T11:57:00.000Z",
      sourceEventId: "event-2",
      applicationId: "code",
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
      parameters: { path: "src/main.ts" },
    }, stateWithRecentActions(), now);

    expect(candidate.kind).toBe("run_tests");
    expect(candidate.confidence).toBe(1);
    expect(candidate.sourceEventIds).toEqual(["event-2", "event-1"]);
    // expiresAt is now derived by Squid, not the model: 60s TTL for run_tests
    expect(candidate.expiresAt).toBe("2026-08-18T12:01:00.000Z");
  });

  it("uses kind-specific TTL for each prediction kind", () => {
    const kinds: [string, number][] = [
      ["draft_completion", 30_000],
      ["run_tests", 60_000],
      ["inspect_error", 120_000],
      ["search_selection", 30_000],
      ["none", 10_000],
    ];

    for (const [kind, expectedTtl] of kinds) {
      const candidate = normalizePredictionCandidate({
        kind,
        rationale: "test",
        confidence: 0.5,
        parameters: {},
      }, emptyWorldState(), now);
      expect(candidate.expiresAt).toBe(new Date(now.getTime() + expectedTtl).toISOString());
    }
  });

  it.each([
    "unknown",
    "",
    "RUN_TESTS",
  ])("returns a safe none candidate for invalid kind %s", (kind) => {
    const candidate = normalizePredictionCandidate({
      kind,
      rationale: "Invalid model output.",
      confidence: -1,
      parameters: {},
    }, stateWithRecentActions(), now);

    expect(candidate.kind).toBe("none");
    expect(candidate.confidence).toBe(0);
    expect(candidate.expiresAt).toBe("2026-08-18T12:00:10.000Z");
    expect(candidate.sourceEventIds).toEqual(["event-2", "event-1"]);
  });

  it("returns a none candidate with empty provenance for empty state", () => {
    const candidate = normalizePredictionCandidate({
      kind: "none",
      rationale: "Nothing to suggest.",
      confidence: 0,
      parameters: {},
    }, emptyWorldState(), now);

    expect(candidate.kind).toBe("none");
    expect(candidate.sourceEventIds).toEqual([]);
  });
});

describe("PiRuntime as PredictionProvider", () => {
  it("implements the PredictionProvider interface", () => {
    // Type-level assertion — PiRuntime must satisfy PredictionProvider.
    // We don't make a real model call here; this just verifies the interface.
    const check = (runtime: PredictionProvider): PredictionProvider => runtime;
    // PiRuntime is imported lazily to avoid requiring a model at import time.
    // The interface check is structural at the type level.
    const typeCheck: typeof import("../src/pi-runtime.js").PiRuntime.prototype.predict extends
      (request: PredictionRequest, signal: AbortSignal) => Promise<readonly PredictionCandidate[]>
      ? true
      : false = true;
    expect(typeCheck).toBe(true);
    expect(check).toBeDefined();
  });
});
