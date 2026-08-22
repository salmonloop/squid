import { describe, expect, it } from "bun:test";
import {
  BELIEF_LIMITS,
  parseBeliefStateBatch,
  validateBeliefStateBatch,
  type BeliefStateBatch,
  type BeliefValidationContext,
} from "../src/belief-state.js";

const digest = "sha256:" + "a".repeat(64);
const context: BeliefValidationContext = {
  now: "2026-08-22T10:00:00.000Z",
  currentEpisodeId: "episode-1",
  currentStateDigest: digest,
  currentProjectionGeneration: 4,
  eventOccurredAt: new Map([
    ["event-1", "2026-08-22T09:59:00.000Z"],
    ["event-2", "2026-08-22T09:59:30.000Z"],
  ]),
  maxTtlMs: 60_000,
};

function batch(overrides: Partial<BeliefStateBatch> = {}): BeliefStateBatch {
  return {
    schemaVersion: 1,
    beliefBatchId: "batch-1",
    projectionGeneration: 4,
    episodeId: "episode-1",
    stateDigest: digest,
    generatedAt: "2026-08-22T09:59:40.000Z",
    provider: "pi",
    modelVersion: "model-1",
    promptVersion: "prompt-1",
    contextPolicyId: "redacting",
    beliefs: [{
      id: "belief-1",
      type: "task_intent",
      value: "debug_failure",
      confidence: 0.8,
      evidenceEventIds: ["event-1"],
      inferredAt: "2026-08-22T09:59:30.000Z",
      expiresAt: "2026-08-22T10:00:15.000Z",
    }],
    ...overrides,
  };
}

describe("BeliefState contract", () => {
  it("accepts a valid batch and returns a deep clone", () => {
    const input = batch();
    const parsed = parseBeliefStateBatch(input, context);

    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.beliefs).not.toBe(input.beliefs);
    expect(parsed.beliefs[0]).not.toBe(input.beliefs[0]);
    expect(parsed.beliefs[0]!.evidenceEventIds).not.toBe(input.beliefs[0]!.evidenceEventIds);
  });

  it("accepts the non-throwing success shape", () => {
    const result = validateBeliefStateBatch(batch(), context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.beliefBatchId).toBe("batch-1");
  });

  it.each([
    ["episode", { episodeId: "episode-2" }],
    ["digest", { stateDigest: "sha256:" + "b".repeat(64) }],
    ["generation", { projectionGeneration: 5 }],
  ])("rejects a batch with a mismatched %s", (_label, overrides) => {
    expect(() => parseBeliefStateBatch(batch(overrides), context)).toThrow();
  });

  it("rejects empty or repeated evidence and unknown event IDs", () => {
    expect(() => parseBeliefStateBatch(batch({
      beliefs: [{ ...batch().beliefs[0]!, evidenceEventIds: [] }],
    }), context)).toThrow();
    expect(() => parseBeliefStateBatch(batch({
      beliefs: [{ ...batch().beliefs[0]!, evidenceEventIds: ["event-1", "event-1"] }],
    }), context)).toThrow();
    expect(() => parseBeliefStateBatch(batch({
      beliefs: [{ ...batch().beliefs[0]!, evidenceEventIds: ["missing"] }],
    }), context)).toThrow();
  });

  it("rejects evidence newer than inference and timestamps in the future", () => {
    expect(() => parseBeliefStateBatch(batch({
      beliefs: [{ ...batch().beliefs[0]!, inferredAt: "2026-08-22T09:58:00.000Z" }],
    }), context)).toThrow();
    expect(() => parseBeliefStateBatch(batch({
      generatedAt: "2026-08-22T10:00:01.000Z",
    }), context)).toThrow();
  });

  it("rejects expired, zero-length, and overlong beliefs", () => {
    expect(() => parseBeliefStateBatch(batch(), {
      ...context,
      now: "2026-08-22T10:00:15.000Z",
    })).toThrow();
    expect(() => parseBeliefStateBatch(batch({
      beliefs: [{ ...batch().beliefs[0]!, expiresAt: "2026-08-22T09:59:30.000Z" }],
    }), context)).toThrow();
    expect(() => parseBeliefStateBatch(batch({
      beliefs: [{
        ...batch().beliefs[0]!,
        expiresAt: "2026-08-22T10:01:00.001Z",
      }],
    }), context)).toThrow();
    expect(() => parseBeliefStateBatch({
      ...batch(),
      beliefs: Array.from({ length: BELIEF_LIMITS.maxBeliefs + 1 }, (_, index) => ({
        ...batch().beliefs[0]!,
        id: `belief-${index}`,
      })),
    }, context)).toThrow();
  });

  it("rejects duplicate belief IDs, invalid confidence, and non-finite numbers", () => {
    expect(() => parseBeliefStateBatch(batch({
      beliefs: [batch().beliefs[0]!, { ...batch().beliefs[0]! }],
    }), context)).toThrow();
    expect(() => parseBeliefStateBatch(batch({
      beliefs: [{ ...batch().beliefs[0]!, confidence: 1.1 }],
    }), context)).toThrow();
    expect(() => parseBeliefStateBatch(batch({
      beliefs: [{ ...batch().beliefs[0]!, confidence: Number.NaN }],
    }), context)).toThrow();
  });

  it("rejects belief IDs used as evidence", () => {
    expect(() => parseBeliefStateBatch(batch({
      beliefs: [{ ...batch().beliefs[0]!, evidenceEventIds: ["belief-1"] }],
    }), {
      ...context,
      eventOccurredAt: new Map([
        ...context.eventOccurredAt,
        ["belief-1", "2026-08-22T09:59:00.000Z"],
      ]),
    })).toThrow();
  });

  it("rejects extra free-text or action fields", () => {
    expect(() => parseBeliefStateBatch({
      ...batch(),
      statement: "run the command",
    }, context)).toThrow();
    expect(() => parseBeliefStateBatch({
      ...batch(),
      beliefs: [{ ...batch().beliefs[0]!, command: "bun test" }],
    }, context)).toThrow();
  });

  it("fails closed for invalid validation context", () => {
    expect(() => parseBeliefStateBatch(batch(), {
      ...context,
      maxTtlMs: 0,
    })).toThrow();
    expect(() => parseBeliefStateBatch(batch(), {
      ...context,
      eventOccurredAt: new Map([["event-1", "not-a-time"]]),
    })).toThrow();
  });

  it("rejects mutation of the returned snapshot from affecting the next validation", () => {
    const parsed = parseBeliefStateBatch(batch(), context);
    (parsed.beliefs[0]!.evidenceEventIds as string[]).push("event-2");

    const again = parseBeliefStateBatch(batch(), context);
    expect(again.beliefs[0]!.evidenceEventIds).toEqual(["event-1"]);
  });
});
