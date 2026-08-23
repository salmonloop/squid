import { orderActivityEvents } from "./chronicle-ordering.js";
import { InMemoryEventStore } from "./event-store.js";
import type { Predictor } from "./baseline-predictor.js";
import type { ActivityEvent, PredictionCandidate, PredictionKind } from "./protocol.js";
import { SquidCore } from "./squid-core.js";
import {
  SyncPredictorProvider,
  type PredictionProvider,
} from "./prediction-provider.js";
import { PredictionCoordinator } from "./prediction-coordinator.js";

export interface PredictionCutPoint {
  id: string;
  eventIndex: number;
  expectedKind: PredictionKind;
  description: string;
}

export interface ReplayScenario {
  id: string;
  title: string;
  events: readonly ActivityEvent[];
  cutPoints: readonly PredictionCutPoint[];
}

export interface PredictionEvaluation {
  scenarioId: string;
  cutPointId: string;
  expectedKind: PredictionKind;
  candidateKinds: PredictionKind[];
  rank: number | null;
  covered: boolean;
  top1: boolean;
  top3: boolean;
  top5: boolean;
  reciprocalRank: number;
}

export interface EvaluationReport {
  scenarioCount: number;
  cutPointCount: number;
  top1: Metric;
  top3: Metric;
  top5: Metric;
  meanReciprocalRank: number;
  coverage: Metric;
  noneCorrectness: Metric;
  results: PredictionEvaluation[];
}

export interface Metric {
  hits: number;
  total: number;
  rate: number;
}

export type PredictorFactory = () => Predictor;
export type PredictionProviderFactory = () => PredictionProvider;

export interface ProviderEvaluationOptions {
  /** Hard timeout per prediction request. Defaults to the coordinator timeout. */
  readonly timeoutMs?: number;
}

export async function evaluateScenarios(
  scenarios: readonly ReplayScenario[],
  createPredictor: PredictorFactory,
): Promise<EvaluationReport> {
  const createProvider: PredictionProviderFactory = () =>
    new SyncPredictorProvider(createPredictor(), "sync-eval");
  return evaluateWithProvider(scenarios, createProvider);
}

/**
 * Async evaluation variant: each scenario gets an independent provider instance,
 * and predictions go through the PredictionCoordinator with a fallback heuristic.
 * This lets Pi-backed predictors be evaluated through the same replay runner offline.
 */
export async function evaluateWithProvider(
  scenarios: readonly ReplayScenario[],
  createProvider: PredictionProviderFactory,
  options: ProviderEvaluationOptions = {},
): Promise<EvaluationReport> {
  validateScenarioIds(scenarios);
  const results: PredictionEvaluation[] = [];

  for (const scenario of [...scenarios].sort(compareScenario)) {
    const events = orderActivityEvents(scenario.events);
    validateScenario(scenario, events);
    const cutPointsByIndex = new Map(scenario.cutPoints.map((cutPoint) => [cutPoint.eventIndex, cutPoint]));
    const core = new SquidCore(new InMemoryEventStore());
    const provider = createProvider();
    let nextRequestId: string | null = null;
    const coordinator = new PredictionCoordinator({
      provider,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      random: () => {
        if (nextRequestId === null) {
          throw new Error("Evaluation coordinator requested an ID outside a cut point.");
        }
        const requestId = nextRequestId;
        nextRequestId = null;
        return requestId;
      },
    });

    try {
      for (const [eventIndex, event] of events.entries()) {
        const ingestResult = await core.ingest(event);
        const cutPoint = cutPointsByIndex.get(eventIndex);
        if (!cutPoint) continue;

        nextRequestId = JSON.stringify(["eval", scenario.id, cutPoint.id]);
        // The projection identity travels with the request so a belief-backed
        // provider can be evaluated through this same runner. Without it the
        // belief layer would have nothing to validate against and every batch
        // would be refused — the gate would then measure a provider that never
        // saw a belief, which is not the provider being admitted.
        const outcome = await coordinator.request(ingestResult.state, {
          stateDigest: ingestResult.stateDigest,
          projectionGeneration: ingestResult.projectionGeneration,
        });
        results.push(evaluateCutPoint(scenario.id, cutPoint, outcome.candidates));
      }
    } finally {
      coordinator.dispose();
    }
  }

  const sortedResults = results.sort(compareResult);
  return buildReport(scenarios.length, sortedResults);
}

function evaluateCutPoint(
  scenarioId: string,
  cutPoint: PredictionCutPoint,
  candidates: readonly PredictionCandidate[],
): PredictionEvaluation {
  const candidateKinds = uniqueKinds(candidates);
  const actionableKinds = candidateKinds.filter((kind) => kind !== "none");
  const rank = cutPoint.expectedKind === "none"
    ? null
    : actionableKinds.indexOf(cutPoint.expectedKind) + 1 || null;
  const noneCorrect = cutPoint.expectedKind === "none" && actionableKinds.length === 0;

  return {
    scenarioId,
    cutPointId: cutPoint.id,
    expectedKind: cutPoint.expectedKind,
    candidateKinds,
    rank,
    covered: actionableKinds.length > 0,
    top1: cutPoint.expectedKind === "none" ? noneCorrect : rank === 1,
    top3: cutPoint.expectedKind === "none" ? noneCorrect : rank !== null && rank <= 3,
    top5: cutPoint.expectedKind === "none" ? noneCorrect : rank !== null && rank <= 5,
    reciprocalRank: rank === null ? 0 : 1 / rank,
  };
}

function buildReport(scenarioCount: number, results: readonly PredictionEvaluation[]): EvaluationReport {
  const total = results.length;
  const noneResults = results.filter((result) => result.expectedKind === "none");
  const actionableResults = results.filter((result) => result.expectedKind !== "none");

  return {
    scenarioCount,
    cutPointCount: total,
    top1: metric(results.filter((result) => result.top1).length, total),
    top3: metric(results.filter((result) => result.top3).length, total),
    top5: metric(results.filter((result) => result.top5).length, total),
    meanReciprocalRank: total === 0 ? 0 : sum(results.map((result) => result.reciprocalRank)) / total,
    coverage: metric(actionableResults.filter((result) => result.covered).length, actionableResults.length),
    noneCorrectness: metric(noneResults.filter((result) => result.top1).length, noneResults.length),
    results: [...results],
  };
}

function uniqueKinds(candidates: readonly PredictionCandidate[]): PredictionKind[] {
  return [...new Set(candidates.map((candidate) => candidate.kind))];
}

function metric(hits: number, total: number): Metric {
  return { hits, total, rate: total === 0 ? 0 : hits / total };
}

function validateScenario(scenario: ReplayScenario, events: readonly ActivityEvent[]): void {
  const seenCutPointIds = new Set<string>();
  const seenCutPointIndexes = new Set<number>();
  for (const cutPoint of scenario.cutPoints) {
    if (seenCutPointIds.has(cutPoint.id)) {
      throw new Error(`Scenario ${scenario.id} has duplicate cut point ID ${cutPoint.id}.`);
    }
    seenCutPointIds.add(cutPoint.id);
    if (!Number.isInteger(cutPoint.eventIndex) || cutPoint.eventIndex < 0 || cutPoint.eventIndex >= events.length) {
      throw new Error(`Scenario ${scenario.id} has an invalid cut point index for ${cutPoint.id}.`);
    }
    if (seenCutPointIndexes.has(cutPoint.eventIndex)) {
      throw new Error(`Scenario ${scenario.id} has duplicate cut point index ${cutPoint.eventIndex}.`);
    }
    seenCutPointIndexes.add(cutPoint.eventIndex);
  }
}

function validateScenarioIds(scenarios: readonly ReplayScenario[]): void {
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    if (seen.has(scenario.id)) {
      throw new Error(`Evaluation has duplicate scenario ID ${scenario.id}.`);
    }
    seen.add(scenario.id);
  }
}

function compareScenario(left: ReplayScenario, right: ReplayScenario): number {
  return left.id.localeCompare(right.id);
}

function compareResult(left: PredictionEvaluation, right: PredictionEvaluation): number {
  return left.scenarioId.localeCompare(right.scenarioId) || left.cutPointId.localeCompare(right.cutPointId);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
