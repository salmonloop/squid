import { orderActivityEvents } from "./chronicle-ordering.js";
import { InMemoryEventStore } from "./event-store.js";
import type { Predictor } from "./baseline-predictor.js";
import type { ActivityEvent, PredictionCandidate, PredictionKind } from "./protocol.js";
import { SquidCore } from "./squid-core.js";

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

export async function evaluateScenarios(
  scenarios: readonly ReplayScenario[],
  predictor: Predictor,
): Promise<EvaluationReport> {
  const results: PredictionEvaluation[] = [];

  for (const scenario of [...scenarios].sort(compareScenario)) {
    const events = orderActivityEvents(scenario.events);
    validateScenario(scenario, events);
    const cutPointsByIndex = new Map(scenario.cutPoints.map((cutPoint) => [cutPoint.eventIndex, cutPoint]));
    const core = new SquidCore(new InMemoryEventStore());

    for (const [eventIndex, event] of events.entries()) {
      const result = await core.ingest(event);
      const cutPoint = cutPointsByIndex.get(eventIndex);
      if (!cutPoint) continue;

      const candidates = predictor.predict(result.state, new Date(event.occurredAt));
      results.push(evaluateCutPoint(scenario.id, cutPoint, candidates));
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

  return {
    scenarioCount,
    cutPointCount: total,
    top1: metric(results.filter((result) => result.top1).length, total),
    top3: metric(results.filter((result) => result.top3).length, total),
    top5: metric(results.filter((result) => result.top5).length, total),
    meanReciprocalRank: total === 0 ? 0 : sum(results.map((result) => result.reciprocalRank)) / total,
    coverage: metric(results.filter((result) => result.covered).length, total),
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
  for (const cutPoint of scenario.cutPoints) {
    if (seenCutPointIds.has(cutPoint.id)) {
      throw new Error(`Scenario ${scenario.id} has duplicate cut point ID ${cutPoint.id}.`);
    }
    seenCutPointIds.add(cutPoint.id);
    if (!Number.isInteger(cutPoint.eventIndex) || cutPoint.eventIndex < 0 || cutPoint.eventIndex >= events.length) {
      throw new Error(`Scenario ${scenario.id} has an invalid cut point index for ${cutPoint.id}.`);
    }
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
