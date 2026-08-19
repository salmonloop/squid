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

  it("uses the production fallback when a provider fails", async () => {
    const failingFactory = (): PredictionProvider => ({
      name: "failing",
      predict: async (request: PredictionRequest, _signal: AbortSignal) => {
        throw new Error(`Provider failure at ${request.id}`);
      },
    });

    const expected = await evaluateScenarios(
      heuristicEvaluationScenarios,
      () => new HeuristicPredictor(),
    );
    const report = await evaluateWithProvider(
      heuristicEvaluationScenarios,
      failingFactory,
    );

    expect(report).toEqual(expected);
  });

  it("applies a hard timeout to a provider that never settles", async () => {
    let signalAborted = false;
    const hangingFactory = (): PredictionProvider => ({
      name: "hanging",
      predict: async (_request, signal) => {
        signal.addEventListener("abort", () => {
          signalAborted = true;
        }, { once: true });
        return new Promise<readonly PredictionCandidate[]>(() => undefined);
      },
    });
    const failedCommand = heuristicEvaluationScenarios.filter(
      (scenario) => scenario.id === "failed-command-inspection",
    );

    const report = await evaluateWithProvider(
      failedCommand,
      hangingFactory,
      { timeoutMs: 5 },
    );

    expect(report.cutPointCount).toBe(1);
    expect(report.results[0]?.candidateKinds).toEqual(["inspect_error"]);
    expect(report.top1.rate).toBe(1);
    expect(signalAborted).toBe(true);
  });
});
