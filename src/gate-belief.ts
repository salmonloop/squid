import { BeliefRerankCognition } from "./belief-rerank-cognition.js";
import { createBeliefResolver } from "./belief-resolver.js";
import { evidenceTimeline } from "./belief-evidence.js";
import { BeliefBackedPredictionProvider } from "./cognition-provider.js";
import { RedactingContextPolicy } from "./context-policy.js";
import { heuristicEvaluationScenarios } from "./evaluation-fixtures.js";
import { InMemoryEventStore } from "./event-store.js";
import { PiBeliefProvider } from "./pi-belief-provider.js";
import { runSemanticGate } from "./semantic-gate.js";
import { SquidCore } from "./squid-core.js";
import type { BeliefStateBatch } from "./belief-state.js";
import type { PredictionRequest } from "./prediction-provider.js";

/**
 * Semantic gate for the model-backed belief producer, plus the number the gate
 * cannot see.
 *
 * A separate entry point from `bun run evaluate` for the same reason as `gate:pi`: it
 * needs a reachable model and spends 7–15s per cut point, so it must never sit inside
 * the offline suite. One run is roughly sixty model calls for the ranking half and three
 * times that again for stability.
 *
 * Exit 1 means a measured refusal. A skip exits 0 with a stated reason, because an
 * unreachable model is not evidence about the model.
 *
 * Two verdicts are reported, and the second is the point. `runSemanticGate` observes a
 * `PredictionProvider`, and `BeliefRerankCognition` bounds a belief's authority at 0.25 —
 * so belief instability is invisible to the gate wherever it cannot overturn a ranking. A
 * top-1-stable verdict over an internally unstable belief layer would read as success.
 * Measuring the belief layer directly is what keeps that from happening, and it is
 * measured here rather than by extending `SemanticGateThresholds`, so the gate's own
 * contract stays untouched.
 */

/** Matches the live wiring's ceiling: well above the endpoint's observed latency. */
const TIMEOUT_MS = 90_000;
/** Same count the gate uses, so the two numbers describe the same many replays. */
const BELIEF_RUNS = 3;

const contextPolicy = new RedactingContextPolicy();
// One producer, shared by both halves. A `BeliefProvider` holds no per-request state and
// opens a model runtime in its constructor, so building one per scenario per replay would
// open that runtime 57 times to ask 57 questions.
const beliefProvider = new PiBeliefProvider();

const unavailable = await beliefProvider.checkAvailability();
if (unavailable !== null) {
  console.error(`Belief gate SKIPPED — ${unavailable}`);
  process.exit(0);
}

const createProvider = () => new BeliefBackedPredictionProvider(
  new BeliefRerankCognition(),
  createBeliefResolver({ beliefProvider, contextPolicyId: contextPolicy.id }),
);

const gate = await runSemanticGate({
  scenarios: heuristicEvaluationScenarios,
  createProvider,
  // The same policy the live cognition run applies. A passthrough policy here would score
  // the producer on window titles and full paths it can never have in production, and the
  // belief contract's `contextPolicyId` echo cannot catch that — a cooperative producer
  // repeats back whatever id it was handed.
  contextPolicy,
  // Reachability is a real question about a hosted endpoint, so an outage skips rather
  // than fails.
  probeAvailability: () => beliefProvider.checkAvailability(),
  timeoutMs: TIMEOUT_MS,
});

const beliefs = await measureBeliefLayer();

console.log(JSON.stringify({ gate, beliefs }, null, 2));

if (gate.status === "skipped") {
  console.error(`Belief gate SKIPPED — ${gate.skipReason ?? "unavailable"}`);
  process.exit(0);
}
if (gate.status === "failed") {
  console.error("Belief gate FAILED — not eligible for a real-time path:");
  for (const failure of gate.failures) console.error(`  - ${failure}`);
  console.error(
    `Belief layer: ${beliefs.stableCutPoints}/${beliefs.cutPointCount} cut points stable, `
    + `coverage ${(beliefs.coverage * 100).toFixed(0)}%.`,
  );
  process.exit(1);
}

console.error(
  `Belief gate PASSED. Belief layer: ${beliefs.stableCutPoints}/${beliefs.cutPointCount} `
  + `cut points stable, coverage ${(beliefs.coverage * 100).toFixed(0)}%.`,
);
if (beliefs.cutPointCount > 0 && beliefs.stableCutPoints < beliefs.cutPointCount) {
  // Not a failure, and not silent either. A ranking can be reproducible while the layer
  // feeding it is not — the weight cap absorbs the difference — and an operator reading
  // "passed" deserves to know which of the two they are looking at.
  console.error(
    "Note: the ranking was reproducible but the belief layer was not. The 0.25 weight cap "
    + "absorbed the difference; a corpus where beliefs decide more would not.",
  );
}

interface BeliefLayerReport {
  /** Cut points where a belief request was made at all. */
  readonly cutPointCount: number;
  /** Cut points whose admitted batch was byte-identical across every run. */
  readonly stableCutPoints: number;
  readonly stability: number;
  /** Fraction of cut points where a batch was admitted in every run. */
  readonly coverage: number;
  readonly runs: number;
  /** Cut points that disagreed with themselves, for a human to look at. Capped. */
  readonly unstableCutPointIds: readonly string[];
}

/**
 * Replays the corpus asking only the belief question, and compares the admitted batch.
 *
 * Compares the *whole* admitted batch rather than a summary: the batch is what a ranking
 * reads, so anything that differs between runs is a difference the ranking could see. The
 * projection identity is excluded, since it is echoed from the request and identical by
 * construction.
 */
async function measureBeliefLayer(): Promise<BeliefLayerReport> {
  const resolve = createBeliefResolver({ beliefProvider, contextPolicyId: contextPolicy.id });
  const perRun: Map<string, string>[] = [];

  for (let run = 0; run < BELIEF_RUNS; run += 1) {
    const answers = new Map<string, string>();
    for (const scenario of heuristicEvaluationScenarios) {
      const core = new SquidCore(new InMemoryEventStore());
      const cutPointsByIndex = new Map(
        scenario.cutPoints.map((cutPoint) => [cutPoint.eventIndex, cutPoint]),
      );
      for (const [eventIndex, event] of scenario.events.entries()) {
        const ingested = await core.ingest(event);
        const cutPoint = cutPointsByIndex.get(eventIndex);
        if (cutPoint === undefined) continue;

        // Projected exactly as the live coordinator projects, so the producer sees what a
        // real run would give it.
        const projected = contextPolicy.project(ingested.state);
        const request: PredictionRequest = {
          id: `belief-gate:${scenario.id}:${cutPoint.id}:${run}`,
          worldState: projected,
          episodeId: ingested.state.episode?.id ?? null,
          triggeredAt: ingested.state.updatedAt ?? new Date().toISOString(),
          projection: {
            stateDigest: ingested.stateDigest,
            projectionGeneration: ingested.projectionGeneration,
          },
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let batch: BeliefStateBatch | null;
        try {
          batch = await resolve(request, controller.signal);
        } finally {
          clearTimeout(timer);
        }
        answers.set(`${scenario.id}:${cutPoint.id}`, describeBatch(batch, evidenceTimeline(projected)));
      }
    }
    perRun.push(answers);
  }

  const first = perRun[0];
  if (first === undefined || first.size === 0) {
    return {
      cutPointCount: 0,
      stableCutPoints: 0,
      stability: 0,
      coverage: 0,
      runs: perRun.length,
      unstableCutPointIds: [],
    };
  }

  const unstable: string[] = [];
  let covered = 0;
  for (const [cutPointId, answer] of first) {
    if (!perRun.every((run) => run.get(cutPointId) === answer)) unstable.push(cutPointId);
    if (perRun.every((run) => run.get(cutPointId) !== "<none>")) covered += 1;
  }
  const stableCutPoints = first.size - unstable.length;
  return {
    cutPointCount: first.size,
    stableCutPoints,
    stability: stableCutPoints / first.size,
    coverage: covered / first.size,
    runs: perRun.length,
    unstableCutPointIds: unstable.slice(0, 8),
  };
}

/**
 * A batch reduced to what a ranking can read from it: intent, band, and cited evidence.
 *
 * Event ids are replaced by their position in the citable timeline. An id is stable
 * within one replay but the *fact* being cited is what has to be reproducible, and a
 * corpus replayed from scratch can legitimately mint different ids for the same event.
 */
function describeBatch(
  batch: BeliefStateBatch | null,
  citable: ReadonlyMap<string, string>,
): string {
  if (batch === null) return "<none>";
  const positionOf = new Map([...citable.keys()].map((eventId, index) => [eventId, index]));
  return JSON.stringify(batch.beliefs.map((belief) => [
    belief.value,
    belief.confidence,
    belief.evidenceEventIds.map((eventId) => positionOf.get(eventId) ?? -1),
  ]));
}
