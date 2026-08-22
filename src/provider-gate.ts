import { describeErrorForAudit } from "./action-egress.js";
import { HeuristicPredictor } from "./baseline-predictor.js";
import type { EvaluationReport, PredictionProviderFactory, ReplayScenario } from "./evaluation.js";
import { evaluateScenarios, evaluateWithProvider } from "./evaluation.js";
import type { PredictionProvider } from "./prediction-provider.js";

/**
 * Minimum a model-backed provider must reach before it may enter a real-time
 * path. These are floors relative to the heuristic baseline on the same fixture
 * version, not absolute quality claims: the corpus is small and synthetic, so
 * the only defensible question it can answer is "is this at least as good as
 * what we already ship".
 */
export interface ProviderGateThresholds {
  /** Top-1 rate must be at least the baseline's, minus this slack. */
  readonly top1Slack: number;
  /** `none` correctness must be at least the baseline's, minus this slack. */
  readonly noneCorrectnessSlack: number;
  /**
   * Maximum share of requests the provider may lose to the heuristic fallback.
   *
   * Without this, a provider that fails every request would post baseline
   * scores and pass: the coordinator substitutes the heuristic, and the ranking
   * report deliberately says nothing about provider health. Ranking alone
   * cannot distinguish "as good as the baseline" from "never actually ran".
   */
  readonly maxFallbackRate: number;
}

export const defaultGateThresholds: ProviderGateThresholds = {
  // Kept deliberately tight: 0.09 was roughly one cut point on the original
  // twelve-point corpus and remains a sub-two-cut-point allowance at fifteen.
  top1Slack: 0.09,
  noneCorrectnessSlack: 0,
  // The same bound keeps one transient timeout tolerable without admitting a
  // provider that regularly fails to answer.
  maxFallbackRate: 0.09,
};

export const DEFAULT_PROVIDER_GATE_TIMEOUT_MS = 90_000;

export type GateStatus = "passed" | "failed" | "skipped";

export interface ProviderGateResult {
  readonly status: GateStatus;
  /** Why the gate was skipped. Present only when status is "skipped". */
  readonly skipReason?: string;
  /** Every threshold that was not met. Empty when status is "passed". */
  readonly failures: readonly string[];
  readonly baseline: EvaluationReport | null;
  readonly candidate: EvaluationReport | null;
  /** Provider health, which the ranking report deliberately omits. */
  readonly health: ProviderHealth | null;
}

export interface ProviderHealth {
  readonly requests: number;
  /** Requests the provider answered itself. */
  readonly answered: number;
  /** Requests that fell back to the heuristic, with a reason each. */
  readonly fallbacks: readonly string[];
  readonly fallbackRate: number;
}

export interface ProviderGateOptions {
  readonly scenarios: readonly ReplayScenario[];
  /** Builds the provider under test, once per scenario. */
  readonly createProvider: PredictionProviderFactory;
  /**
   * Answers whether the provider can be reached at all, before any scoring.
   * Rejecting or returning a reason skips the gate rather than failing it: an
   * unavailable provider is not evidence of a bad provider.
   *
   * This has to be a separate hook rather than a construction probe. A provider
   * that resolves its model lazily — as `PiRuntime` does, holding a promise
   * built in its constructor — cannot signal unreachability by throwing from a
   * constructor, so probing construction would report every outage as a
   * ranking regression.
   *
   * Omit only for a provider that cannot be unavailable, such as an in-process
   * one.
   */
  readonly probeAvailability?: () => Promise<string | null>;
  readonly thresholds?: ProviderGateThresholds;
  readonly timeoutMs?: number;
}

/**
 * Scores a candidate provider against the heuristic baseline on one fixture
 * version and reports whether it may enter a real-time path.
 *
 * Skipped and failed are deliberately distinct. A provider that cannot be
 * reached tells us nothing, so it must not be reported as either a pass or a
 * regression — silently treating an unreachable model as a pass is how an
 * unevaluated predictor reaches production.
 */
export async function runProviderGate(
  options: ProviderGateOptions,
): Promise<ProviderGateResult> {
  const { scenarios, createProvider } = options;
  const thresholds = options.thresholds ?? defaultGateThresholds;

  // Establish reachability before spending a baseline run, so an outage is
  // reported as "we learned nothing" rather than as a regression.
  const unavailable = await probeAvailability(options);
  if (unavailable !== null) {
    return {
      status: "skipped",
      skipReason: `provider unavailable: ${unavailable}`,
      failures: [],
      baseline: null,
      candidate: null,
      health: null,
    };
  }

  const baseline = await evaluateScenarios(scenarios, () => new HeuristicPredictor());

  // Count what the provider actually answered. The ranking report cannot show
  // this, because a fallback is indistinguishable from a good prediction once
  // only candidates remain.
  const observer = new ProviderHealthObserver();
  let candidate: EvaluationReport;
  try {
    candidate = await evaluateWithProvider(scenarios, () => observer.wrap(createProvider()), {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  } catch (error) {
    return {
      status: "skipped",
      skipReason: `provider evaluation could not run: ${describeErrorForAudit(error)}`,
      failures: [],
      baseline,
      candidate: null,
      health: observer.snapshot(),
    };
  }

  const health = observer.snapshot();
  const failures = [
    ...compareToBaseline(baseline, candidate, thresholds),
    ...checkHealth(health, thresholds),
  ];
  return {
    status: failures.length === 0 ? "passed" : "failed",
    failures,
    baseline,
    candidate,
    health,
  };
}

/**
 * Returns a reason when the provider is unavailable, or null when it can be
 * scored. Construction is also attempted, since a factory that throws is
 * unavailable by any definition.
 */
async function probeAvailability(options: ProviderGateOptions): Promise<string | null> {
  try {
    options.createProvider();
  } catch (error) {
    return describeErrorForAudit(error);
  }
  if (options.probeAvailability === undefined) {
    return null;
  }
  try {
    return await options.probeAvailability();
  } catch (error) {
    return describeErrorForAudit(error);
  }
}

/**
 * Wraps a provider to record whether each request was answered or failed.
 *
 * This sits outside the coordinator on purpose: by the time the coordinator has
 * applied its fallback, the failure is no longer visible in the outcome the
 * evaluation runner keeps.
 *
 * The observer races the provider's `predict` against the `AbortSignal` so that
 * a provider which ignores its signal and never settles is still counted as a
 * failure when the coordinator aborts. Without this race, `this.requests` would
 * be incremented but the pending `await` would never enter the catch block,
 * leaving `failures` empty and `fallbackRate` at zero — a hung provider would
 * pass the gate.
 */
class ProviderHealthObserver {
  private requests = 0;
  private readonly failures: string[] = [];

  public wrap(provider: PredictionProvider): PredictionProvider {
    return {
      name: provider.name,
      predict: async (request, signal) => {
        this.requests += 1;
        try {
          return await Promise.race([
            provider.predict(request, signal),
            abortNeverSettles(signal),
          ]);
        } catch (error) {
          this.failures.push(describeErrorForAudit(error));
          throw error;
        }
      },
    };
  }

  public snapshot(): ProviderHealth {
    return {
      requests: this.requests,
      answered: this.requests - this.failures.length,
      fallbacks: [...this.failures],
      fallbackRate: this.requests === 0 ? 0 : this.failures.length / this.requests,
    };
  }
}

function checkHealth(health: ProviderHealth, thresholds: ProviderGateThresholds): string[] {
  if (health.requests === 0) {
    return ["provider received no requests, so nothing was measured"];
  }
  if (health.fallbackRate > thresholds.maxFallbackRate) {
    return [
      `fallback rate ${format(health.fallbackRate)} exceeds ${format(thresholds.maxFallbackRate)}` +
        ` (${health.fallbacks.length}/${health.requests} requests did not reach the provider)`,
    ];
  }
  return [];
}

function compareToBaseline(
  baseline: EvaluationReport,
  candidate: EvaluationReport,
  thresholds: ProviderGateThresholds,
): string[] {
  const failures: string[] = [];

  // The two reports must describe the same corpus, or the comparison is
  // meaningless regardless of the rates.
  if (candidate.cutPointCount !== baseline.cutPointCount) {
    failures.push(
      `cut point count ${candidate.cutPointCount} does not match baseline ${baseline.cutPointCount}`,
    );
    return failures;
  }

  const top1Floor = baseline.top1.rate - thresholds.top1Slack;
  if (candidate.top1.rate < top1Floor) {
    failures.push(
      `top1 ${format(candidate.top1.rate)} is below the baseline floor ${format(top1Floor)}`,
    );
  }

  const noneFloor = baseline.noneCorrectness.rate - thresholds.noneCorrectnessSlack;
  if (candidate.noneCorrectness.rate < noneFloor) {
    failures.push(
      `noneCorrectness ${format(candidate.noneCorrectness.rate)} is below the baseline floor ${format(noneFloor)}`,
    );
  }

  return failures;
}

function format(rate: number): string {
  return rate.toFixed(4);
}

/**
 * Rejects when the signal aborts, so a provider that ignores its `AbortSignal`
 * and never settles is surfaced as a failure rather than hanging forever.
 * Resolves only if the signal never aborts (the provider settled first).
 */
function abortNeverSettles(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error("provider was already aborted"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error("provider did not settle before abort")),
      { once: true },
    );
  });
}