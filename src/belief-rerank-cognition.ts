import { HeuristicPredictor, type Predictor } from "./baseline-predictor.js";
import type { BeliefValue } from "./belief-state.js";
import type { CognitionProvider, CognitionRequest } from "./cognition-provider.js";
import type { PredictionCandidate, PredictionKind } from "./protocol.js";

/**
 * A cognition provider that ranks candidate actions by what the belief layer says
 * is going on.
 *
 * The split it embodies is the point of the belief seam: *which* actions are even
 * available is a fact about the world, and the projection already answers it; *which
 * one matters now* is a judgement, and that is what a belief supplies. So this
 * provider proposes nothing the state does not already support, and reorders what it
 * does support according to the intent the beliefs assert.
 *
 * It cannot invent a candidate. A belief carries no command, no tool name, and no
 * parameters — by contract — so it has nothing to build an action out of, and a
 * layer that could synthesize one from an intent label would be asserting
 * parameters no event ever observed. Re-ranking is the whole of the authority this
 * layer has, which is also why its output is safe to score: every candidate it
 * emits was already admissible before it ran.
 *
 * Deterministic by construction — pure arithmetic over the batch, a stable sort,
 * and an explicit tie-break. That is not incidental: `runSemanticGate` refuses a
 * provider whose top-1 answer moves between runs on identical state, and the
 * documented reason `PiRuntime` fails that gate today is exactly this
 * nondeterminism. A cognition layer that reorders suggestions unpredictably reads
 * as a malfunction rather than as a feature, however good its average score.
 */

/**
 * Which action each intent supports.
 *
 * A total map over `BeliefValue`, so adding a belief value is a compile error here
 * rather than a silently unsupported intent. `unknown` supports nothing: it is the
 * value a producer uses when it cannot tell what is going on, and an intent that
 * says nothing must not move a ranking.
 */
const SUPPORTED_KIND: Readonly<Record<BeliefValue, PredictionKind | null>> = {
  debug_failure: "inspect_error",
  validate_change: "run_tests",
  draft_text: "draft_completion",
  research_selection: "search_selection",
  unknown: null,
};

/**
 * How much a fully-confident belief may move a candidate.
 *
 * Bounded well below 1 on purpose. A belief is evidence that an action is relevant,
 * not evidence that it will work, and the heuristic's own confidence still carries
 * information the belief layer does not have — whether the concrete parameters an
 * action needs are actually present. At this weight a belief reorders candidates
 * the heuristic scored closely and cannot overturn a wide gap, which is the
 * intended authority: enough to be measurable, not enough to be reckless.
 */
const DEFAULT_BELIEF_WEIGHT = 0.25;

export interface BeliefRerankCognitionOptions {
  /** Source of candidate actions. Defaults to the shipped heuristic. */
  readonly predictor?: Predictor;
  /** Maximum confidence a belief may add. Defaults to 0.25. */
  readonly beliefWeight?: number;
}

export class BeliefRerankCognition implements CognitionProvider {
  public readonly name = "belief-rerank";

  private readonly predictor: Predictor;
  private readonly beliefWeight: number;

  public constructor(options: BeliefRerankCognitionOptions = {}) {
    this.predictor = options.predictor ?? new HeuristicPredictor();
    // Clamped rather than validated: a caller asking for an out-of-range weight
    // gets the nearest sane behavior instead of a startup crash on the prediction
    // path, and a negative weight — which would rank *away* from the evidence —
    // is refused outright.
    this.beliefWeight = Math.min(1, Math.max(0, options.beliefWeight ?? DEFAULT_BELIEF_WEIGHT));
  }

  public async predict(
    request: CognitionRequest,
    signal: AbortSignal,
  ): Promise<readonly PredictionCandidate[]> {
    // Checked before doing work, and again by the coordinator's own race. A
    // provider that ignores its signal is treated as a failure by the gate's
    // health observer, so honouring it is part of being scoreable.
    if (signal.aborted) throw new Error("Cognition request was aborted before it ran.");

    const candidates = this.predictor.predict(request.worldState, new Date(request.triggeredAt));
    const beliefs = request.beliefs;
    if (beliefs === null || candidates.length === 0) {
      // The belief layer is allowed to be unavailable, so cognition-from-state is
      // a correct answer rather than a degraded one. Returning the candidates
      // unchanged is exactly that: the ranking the projection alone supports.
      return candidates;
    }

    // Strongest assertion per action wins. Two beliefs can support the same
    // action — a batch may assert `draft_text` twice from different evidence —
    // and summing them would let a provider inflate a rank by repeating itself.
    const supportByKind = new Map<PredictionKind, number>();
    for (const belief of beliefs.beliefs) {
      const kind = SUPPORTED_KIND[belief.value];
      if (kind === null) continue;
      const current = supportByKind.get(kind);
      if (current === undefined || belief.confidence > current) {
        supportByKind.set(kind, belief.confidence);
      }
    }
    if (supportByKind.size === 0) return candidates;

    const ranked = candidates.map((candidate, ordinal) => ({
      ordinal,
      candidate,
      // Everything but the ranking is passed through untouched. `sourceEventIds`
      // in particular: admission and the ledger read them to decide whether the
      // world has moved since a candidate was formed, so a cognition layer that
      // rewrote them would be editing the audit trail rather than the ranking.
      score: Math.min(
        1,
        candidate.confidence + (supportByKind.get(candidate.kind) ?? 0) * this.beliefWeight,
      ),
    }));

    ranked.sort((left, right) =>
      // Original ordinal breaks ties explicitly rather than relying on sort
      // stability. Both are stable in practice; only one of them says so in a way
      // the stability gate can hold us to.
      right.score - left.score || left.ordinal - right.ordinal
    );

    return ranked.map((entry) => ({ ...entry.candidate, confidence: entry.score }));
  }
}
