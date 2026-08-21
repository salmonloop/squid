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
    const report = await evaluateScenarios(heuristicEvaluationScenarios, () => new HeuristicPredictor());

    expect(report.scenarioCount).toBe(heuristicEvaluationScenarios.length);
    expect(report.cutPointCount).toBe(
      heuristicEvaluationScenarios.reduce((count, scenario) => count + scenario.cutPoints.length, 0),
    );
    expect(report.top1.rate).toBe(1);
    expect(report.noneCorrectness.rate).toBe(1);
    expect(report.results.map((result) => result.expectedKind)).toEqual([
      "search_selection",
      "run_tests",
      "draft_completion",
      "inspect_error",
      "run_tests",
      "none",
      "run_tests",
      "none",
      "run_tests",
      // The three screen-text scenarios, in scenario-ID order.
      "run_tests",
      "search_selection",
      "none",
      // The three stale scenarios.
      "none",
      "none",
      "none",
    ]);
  });

  it("expires stale context without suppressing resumed work", async () => {
    const scenarioIds = new Set([
      "resumed-work-still-predicts",
      "stale-application-no-tests",
      "stale-save-no-tests",
      "stale-text-no-completion",
    ]);
    const scenarios = heuristicEvaluationScenarios.filter((scenario) => scenarioIds.has(scenario.id));

    const report = await evaluateScenarios(scenarios, () => new HeuristicPredictor());
    const kindsByScenario = Object.fromEntries(
      report.results.map((result) => [result.scenarioId, result.candidateKinds]),
    );

    expect(kindsByScenario).toEqual({
      "resumed-work-still-predicts": ["run_tests"],
      "stale-application-no-tests": [],
      "stale-save-no-tests": [],
      "stale-text-no-completion": [],
    });
  });

  it("scores a filesystem-sourced save through the same projection", async () => {
    const scenario = heuristicEvaluationScenarios
      .find((candidate) => candidate.id === "filesystem-save-run-tests");
    if (scenario === undefined) throw new Error("Missing filesystem evaluation scenario.");

    const report = await evaluateScenarios([scenario], () => new HeuristicPredictor());

    expect(scenario.events.some((event) => event.source.kind === "filesystem")).toBe(true);
    expect(report.results[0]?.rank).toBe(1);
    expect(report.results[0]?.candidateKinds).toEqual(["run_tests"]);
  });

  it("produces identical reports across runs", async () => {
    const first = await evaluateScenarios(heuristicEvaluationScenarios, () => new HeuristicPredictor());
    const second = await evaluateScenarios(heuristicEvaluationScenarios, () => new HeuristicPredictor());

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

    const report = await evaluateScenarios([scenario], () => stubPredictor([
      ["draft_completion", "run_tests"],
      ["draft_completion", "inspect_error", "search_selection"],
      [],
    ]));

    expect(report.results.map((result) => result.rank)).toEqual([2, null, null]);
    expect(report.top1.hits).toBe(1);
    expect(report.top3.hits).toBe(2);
    expect(report.meanReciprocalRank).toBeCloseTo(0.5 / 3, 10);
    // Coverage counts only the actionable cut points: "c-empty" expects "none",
    // so producing no candidate there is correct behaviour, not a coverage miss.
    // Folding it into the denominator would penalise a provider for being right.
    expect(report.coverage).toEqual({ hits: 2, total: 2, rate: 1 });
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

    const report = await evaluateScenarios([scenario], () => new HeuristicPredictor());

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

    await expect(evaluateScenarios([scenario], () => new HeuristicPredictor()))
      .rejects.toThrow("Scenario invalid has an invalid cut point index for out-of-range.");
  });

  it("rejects duplicate cut point indexes instead of silently dropping a label", async () => {
    const scenario: ReplayScenario = {
      id: "duplicate-index",
      title: "Duplicate index",
      events: [createActivityEvent({
        kind: "application_activated",
        eventId: "duplicate-index-event",
        sequence: 0,
        occurredAt: "2026-08-18T11:30:00.000Z",
        payload: { applicationId: "clock", applicationName: "Clock" },
      })],
      cutPoints: [
        { id: "first", eventIndex: 0, expectedKind: "none", description: "First label." },
        { id: "second", eventIndex: 0, expectedKind: "none", description: "Second label." },
      ],
    };

    await expect(evaluateScenarios([scenario], () => new HeuristicPredictor()))
      .rejects.toThrow("Scenario duplicate-index has duplicate cut point index 0.");
  });

  it("creates an isolated predictor for each scenario", async () => {
    const scenarios: ReplayScenario[] = ["isolation-a", "isolation-b"].map((id, index) => ({
      id,
      title: id,
      events: [createActivityEvent({
        kind: "application_activated",
        eventId: `${id}-event`,
        sequence: index,
        occurredAt: `2026-08-18T11:4${index}:00.000Z`,
        payload: { applicationId: "clock", applicationName: "Clock" },
      })],
      cutPoints: [{ id: `${id}-cut`, eventIndex: 0, expectedKind: "none", description: "No action." }],
    }));
    let instanceCount = 0;

    const report = await evaluateScenarios(scenarios, () => {
      instanceCount += 1;
      let called = false;
      return {
        predict(_state, now = new Date()) {
          if (!called) {
            called = true;
            return [];
          }
          return [{
            kind: "run_tests" as const,
            rationale: "State leaked from another scenario.",
            confidence: 1,
            expiresAt: new Date(now.getTime() + 20_000).toISOString(),
            sourceEventIds: [],
            parameters: {},
          }];
        },
      };
    });

    expect(instanceCount).toBe(2);
    expect(report.top1.rate).toBe(1);
  });
});
