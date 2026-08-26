import type { ToolSummary } from "./tool-catalog.js";
import type { ContextPolicy } from "./context-policy.js";
import { evaluateWithProvider } from "./evaluation.js";
import { runProviderGate, type ProviderGateResult, type ProviderGateThresholds } from "./provider-gate.js";
import type { PredictionProviderFactory, ReplayScenario } from "./evaluation.js";

/**
 * The gate a cognition path must clear before it can reach a real-time action.
 *
 * `runProviderGate` already answers "is this better than the heuristic on the
 * same corpus". That is necessary and, on measured evidence, not sufficient: the
 * documented reason `PiRuntime` fails today is that it gives *different answers
 * for the same world state*. A ranking score averages that away — a provider can
 * post an acceptable mean while being unusable, because a suggestion that appears
 * only half the time reads as a malfunction rather than as a feature.
 *
 * So this gate runs the ranking gate and then measures stability directly: the
 * same scenarios, several times, comparing the top candidate per cut point. A
 * provider whose top-1 answer moves between runs is refused however well it
 * scores on average.
 */
export interface SemanticGateThresholds extends ProviderGateThresholds {
  /**
   * Minimum fraction of cut points whose top-1 kind is identical across every
   * repetition. Default 1: a cognition layer that cannot reproduce its own answer
   * on unchanged input has nothing to offer over the heuristic, which is
   * deterministic by construction.
   */
  readonly minTop1Stability: number;
  /** How many times to replay the corpus for stability. Default 3. */
  readonly stabilityRuns: number;
}

export const defaultSemanticGateThresholds: SemanticGateThresholds = {
  top1Slack: 0.09,
  noneCorrectnessSlack: 0,
  maxFallbackRate: 0.09,
  // Exactly reproducible. Loosening this is a decision that needs its own
  // justification, because every point below 1 is a suggestion a user sees
  // sometimes and not other times on the same screen.
  minTop1Stability: 1,
  stabilityRuns: 3,
};

export type SemanticGateStatus = "passed" | "failed" | "skipped";

export interface StabilityReport {
  /** Cut points compared. Zero means stability could not be measured. */
  readonly cutPointCount: number;
  /** Cut points whose top-1 kind was identical in every run. */
  readonly stableCutPoints: number;
  readonly top1Stability: number;
  readonly runs: number;
  /** Cut point IDs that disagreed, for a human to look at. Capped. */
  readonly unstableCutPointIds: readonly string[];
}

export interface SemanticGateResult {
  readonly status: SemanticGateStatus;
  readonly skipReason?: string;
  readonly failures: readonly string[];
  /** The underlying ranking verdict, or null when it was never run. */
  readonly ranking: ProviderGateResult | null;
  /** Null when the ranking gate did not pass, since stability is not reached. */
  readonly stability: StabilityReport | null;
}

export interface SemanticGateOptions {
  readonly scenarios: readonly ReplayScenario[];
  readonly createProvider: PredictionProviderFactory;
  readonly probeAvailability?: () => Promise<string | null>;
  readonly thresholds?: Partial<SemanticGateThresholds>;
  readonly timeoutMs?: number;
  /**
   * The policy the live run projects state through, so this gate scores the
   * provider *as configured*. Pass the same instance the caller hands to
   * `selectPredictionProvider`.
   *
   * This matters most for the layer this gate was built to admit. A belief
   * producer reasoning over window titles, full paths, or URL query strings would,
   * under a passthrough gate, be measured on signal a redacting live run never
   * gives it — pass, earn `trusted`, and then degrade. The belief contract's own
   * `contextPolicyId` check cannot catch that: a cooperative producer echoes back
   * whatever id it was handed, so request and batch agree either way.
   */
  readonly contextPolicy?: ContextPolicy;
  /**
   * The tool catalog the live run sends, forwarded to both halves of this
   * gate. Ranking and stability must score the prompt being authorized, and
   * the live prompt carries the catalog.
   */
  readonly tools?: readonly ToolSummary[];
}

const MAX_REPORTED_UNSTABLE = 8;

export async function runSemanticGate(
  options: SemanticGateOptions,
): Promise<SemanticGateResult> {
  const thresholds: SemanticGateThresholds = {
    ...defaultSemanticGateThresholds,
    ...options.thresholds,
  };

  const ranking = await runProviderGate({
    scenarios: options.scenarios,
    createProvider: options.createProvider,
    ...(options.probeAvailability === undefined
      ? {}
      : { probeAvailability: options.probeAvailability }),
    thresholds,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.contextPolicy === undefined ? {} : { contextPolicy: options.contextPolicy }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  });

  // A skip is not a pass and not a failure: an unreachable provider is not
  // evidence about the provider. Propagated rather than reinterpreted.
  if (ranking.status === "skipped") {
    return {
      status: "skipped",
      ...(ranking.skipReason === undefined ? {} : { skipReason: ranking.skipReason }),
      failures: [],
      ranking,
      stability: null,
    };
  }
  if (ranking.status === "failed") {
    return { status: "failed", failures: ranking.failures, ranking, stability: null };
  }

  // Stability is measured only after ranking passes. Repeating the corpus is the
  // expensive part of this gate, and a provider that already lost on ranking
  // gains nothing from knowing whether it lost consistently.
  const stability = await measureStability(options, thresholds.stabilityRuns);
  const failures: string[] = [];
  if (stability.cutPointCount === 0) {
    failures.push("stability_unmeasurable");
  } else if (stability.top1Stability < thresholds.minTop1Stability) {
    failures.push(
      `top1_stability ${stability.top1Stability.toFixed(3)} < ${thresholds.minTop1Stability}`,
    );
  }

  return {
    status: failures.length === 0 ? "passed" : "failed",
    failures,
    ranking,
    stability,
  };
}

/**
 * Replays the corpus `runs` times and compares the top-1 kind per cut point.
 *
 * Compares the *kind* rather than the whole candidate: parameters legitimately
 * carry text that varies, and a rationale is prose. What has to be reproducible
 * is which action gets proposed.
 */
async function measureStability(
  options: SemanticGateOptions,
  runs: number,
): Promise<StabilityReport> {
  const perRun: Map<string, string>[] = [];
  for (let run = 0; run < Math.max(1, runs); run += 1) {
    const report = await evaluateWithProvider(options.scenarios, options.createProvider, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      // The same policy the ranking half used. Measuring stability under a
      // different projection than ranking would let a provider pass two halves of
      // a gate that never agreed on what it was scoring.
      ...(options.contextPolicy === undefined ? {} : { contextPolicy: options.contextPolicy }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    });
    const topByCutPoint = new Map<string, string>();
    for (const result of report.results) {
      // `candidateKinds` is the ranked list, so its head is the top-1 answer.
      // An empty list is itself an answer — "propose nothing" — and must be
      // reproducible too, so it is recorded rather than skipped.
      topByCutPoint.set(
        `${result.scenarioId}:${result.cutPointId}`,
        result.candidateKinds[0] ?? "<none>",
      );
    }
    perRun.push(topByCutPoint);
  }

  const first = perRun[0];
  if (first === undefined || first.size === 0) {
    return {
      cutPointCount: 0,
      stableCutPoints: 0,
      top1Stability: 0,
      runs: perRun.length,
      unstableCutPointIds: [],
    };
  }

  const unstable: string[] = [];
  for (const [cutPointId, top] of first) {
    const agrees = perRun.every((run) => run.get(cutPointId) === top);
    if (!agrees) unstable.push(cutPointId);
  }
  const stableCutPoints = first.size - unstable.length;
  return {
    cutPointCount: first.size,
    stableCutPoints,
    top1Stability: stableCutPoints / first.size,
    runs: perRun.length,
    unstableCutPointIds: unstable.slice(0, MAX_REPORTED_UNSTABLE),
  };
}
