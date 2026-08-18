import { describe, expect, it } from "bun:test";
import { HeuristicPredictor, type Predictor } from "../src/baseline-predictor.js";
import { heuristicEvaluationScenarios } from "../src/evaluation-fixtures.js";
import { evaluateScenarios, type ReplayScenario } from "../src/evaluation.js";
import { createActivityEvent, type PredictionCandidate, type PredictionKind, type WorldState } from "../src/protocol.js";

function stubPredictor(kindsByCall: readonly PredictionKind[][]): Predictor {
  let call = 0;
  return {
    predict(_state: WorldState, now = new Date()): readonly PredictionCandidate[] {
      const kinds = kindsByCall[call++] ?? [];
      return kinds.map((kind, index) => ({
        kind,
        rationale: "stub",
        confidence: 1 - index * 0.1,
        expiresAt: new Date(now.getTime() + 20_000).toISOString(),
        sourceEventIds: [],
        parameters: {},
      }));
    },
  };
}

describe("Replay evaluation", () => {
  it("scores the heuristic baseline on synthetic fixtures", async () => {
    const report = await evaluateScenarios(heuristicEvaluationScenarios, new HeuristicPredictor());

    expect(report.scenarioCount).toBe(heuristicEvaluationScenarios.length);
    expect(report.cutPointCount).toBe(heuristicEvaluationScenarios.length);
    expect(report.top1.rate).toBe(1);
    expect(report.noneCorrectness.rate).toBe(1);
    expect(report.results.map((result) => result.expectedKind)).toEqual([
      "search_selection",
      "run_tests",
      "draft_completion",
      "inspect_error",
      "none",
    ]);
  });

  it("produces identical reports across runs", async () => {
    const first = await evaluateScenarios(heuristicEvaluationScenarios, new HeuristicPredictor());
    const second = await evaluateScenarios(heuristicEvaluationScenarios, new HeuristicPredictor());

    expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
  });

  it("computes rank, MRR, and coverage for ranked, missing, and empty output", async () => {
    const scenario: ReplayScenario = {
      id: "ranking",
      title: "Ranking behavior",
      events: [
        createActivityEvent({
          kind: "file_saved",
          eventId: "rank-1",
          sequence: 0,
          occurredAt: "2026-08-18T11:00:00.000Z",
          payload: { path: "a.ts", applicationId: "editor" },
        }),
        createActivityEvent({
          kind: "file_saved",
          eventId: "rank-2",
          sequence: 1,
          occurredAt: "2026-08-18T11:00:01.000Z",
          payload: { path: "b.ts", applicationId: "editor" },
        }),
        createActivityEvent({
          kind: "file_saved",
          eventId: "rank-3",
          sequence: 2,
          occurredAt: "2026-08-18T11:00:02.000Z",
          payload: { path: "c.ts", applicationId: "editor" },
        }),
      ],
      cutPoints: [
        { id: "a-rank-2", eventIndex: 0, expectedKind: "run_tests", description: "Second-ranked hit." },
        { id: "b-missing", eventIndex: 1, expectedKind: "run_tests", description: "Missing from candidates." },
        { id: "c-empty", eventIndex: 2, expectedKind: "none", description: "No candidates emitted." },
      ],
    };

    const report = await evaluateScenarios([scenario], stubPredictor([
      ["draft_completion", "run_tests"],
      ["draft_completion", "inspect_error", "search_selection"],
      [],
    ]));

    expect(report.results.map((result) => result.rank)).toEqual([2, null, null]);
    expect(report.top1.hits).toBe(1);
    expect(report.top3.hits).toBe(2);
    expect(report.meanReciprocalRank).toBeCloseTo(0.5 / 3, 10);
    expect(report.coverage).toEqual({ hits: 2, total: 3, rate: 2 / 3 });
  });

  it("does not leak future events into a cut point's state", async () => {
    const scenario: ReplayScenario = {
      id: "leakage",
      title: "Future leakage guard",
      events: [
        createActivityEvent({
          kind: "application_activated",
          eventId: "leak-1",
          sequence: 0,
          occurredAt: "2026-08-18T11:10:00.000Z",
          payload: { applicationId: "editor", applicationName: "Editor" },
        }),
        createActivityEvent({
          kind: "terminal_command_completed",
          eventId: "leak-2",
          sequence: 1,
          occurredAt: "2026-08-18T11:10:01.000Z",
          payload: { commandClass: "test", succeeded: false, exitCode: 1 },
        }),
      ],
      cutPoints: [
        { id: "before-failure", eventIndex: 0, expectedKind: "none", description: "The failure has not happened yet." },
      ],
    };

    const report = await evaluateScenarios([scenario], new HeuristicPredictor());

    expect(report.results[0]?.candidateKinds).toEqual([]);
    expect(report.results[0]?.top1).toBe(true);
  });

  it("rejects an out-of-range cut point", async () => {
    const scenario: ReplayScenario = {
      id: "invalid",
      title: "Invalid cut point",
      events: [
        createActivityEvent({
          kind: "file_saved",
          eventId: "invalid-1",
          sequence: 0,
          occurredAt: "2026-08-18T11:20:00.000Z",
          payload: { path: "a.ts", applicationId: "editor" },
        }),
      ],
      cutPoints: [
        { id: "out-of-range", eventIndex: 5, expectedKind: "run_tests", description: "Beyond the timeline." },
      ],
    };

    await expect(evaluateScenarios([scenario], new HeuristicPredictor()))
      .rejects.toThrow("Scenario invalid has an invalid cut point index for out-of-range.");
  });
});
