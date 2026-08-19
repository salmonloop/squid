import { describe, expect, it } from "bun:test";
import { heuristicEvaluationScenarios } from "../src/evaluation-fixtures.js";
import { evaluateScenarios, evaluateWithProvider } from "../src/evaluation.js";
import {
  FakePredictionProvider,
  candidate,
} from "../src/fake-prediction-provider.js";
import { SyncPredictorProvider } from "../src/prediction-provider.js";
import { HeuristicPredictor } from "../src/baseline-predictor.js";
import type { PredictionProvider, PredictionRequest } from "../src/prediction-provider.js";
import type { PredictionCandidate, PredictionKind } from "../src/protocol.js";

describe("Async evaluation", () => {
  it("produces identical results via SyncPredictorProvider and sync evaluateScenarios", async () => {
    const syncReport = await evaluateScenarios(heuristicEvaluationScenarios, () => new HeuristicPredictor());
    const asyncReport = await evaluateWithProvider(
      heuristicEvaluationScenarios,
      () => new SyncPredictorProvider(new HeuristicPredictor(), "heuristic"),
    );
    // Same metrics and per-cut-point results
    expect(asyncReport.scenarioCount).toBe(syncReport.scenarioCount);
    expect(asyncReport.cutPointCount).toBe(syncReport.cutPointCount);
    expect(asyncReport.top1).toEqual(syncReport.top1);
    expect(asyncReport.top3).toEqual(syncReport.top3);
    expect(asyncReport.noneCorrectness).toEqual(syncReport.noneCorrectness);
    expect(asyncReport.results.map((r) => r.top1)).toEqual(syncReport.results.map((r) => r.top1));
  });

  it("evaluates a fake provider with canned candidates", async () => {
    // Provider that always returns a single candidate matching expected kind
    const cannedByScenario: Record<string, readonly PredictionCandidate[]> = {
      "stale-save-no-tests": [candidate("none")],
      "stale-text-no-completion": [candidate("none")],
      "resumed-work-still-predicts": [candidate("run_tests")],
    };

    const factory = (): PredictionProvider => ({
      name: "canned",
      predict: async (request: PredictionRequest, _signal: AbortSignal) => {
        // Find which scenario by matching the request id prefix
        for (const scenarioId of Object.keys(cannedByScenario)) {
          if (request.id.includes(scenarioId)) {
            return cannedByScenario[scenarioId];
          }
        }
        return [candidate("none")];
      },
    });

    const report = await evaluateWithProvider(heuristicEvaluationScenarios, factory);
    // At least the none scenarios should be correctly predicted
    expect(report.cutPointCount).toBeGreaterThan(0);
    expect(report.noneCorrectness.hits).toBeGreaterThan(0);
  });

  it("treats provider timeout as failed predictions", async () => {
    // Provider that always times out (never resolves, signal ignored)
    const factory = (): PredictionProvider => ({
      name: "hanging",
      predict: async () => new Promise<readonly PredictionCandidate[]>( () => undefined),
    });

    // We can't actually wait for a hanging provider in a test, so we use
    // a provider that rejects immediately to simulate timeout behaviour.
    const failingFactory = (): PredictionProvider => ({
      name: "failing",
      predict: async (request: PredictionRequest, _signal: AbortSignal) => {
        throw new Error(`Provider failure at ${request.id}`);
      },
    });

    const report = await evaluateWithProvider(
      heuristicEvaluationScenarios,
      failingFactory,
    );
    // No candidates → coverage is 0
    expect(report.coverage.hits).toBe(0);
    expect(report.coverage.rate).toBe(0);
  });
});
