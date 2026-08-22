import type { Predictor } from "./baseline-predictor.js";
import type { PredictionProvider } from "./prediction-provider.js";
import { SyncPredictorProvider } from "./prediction-provider.js";
import type { ProviderGateResult } from "./provider-gate.js";
import { PassthroughContextPolicy, RedactingContextPolicy, type ContextPolicy } from "./context-policy.js";

export const providerModes = ["heuristic", "pi"] as const;
export type ProviderMode = (typeof providerModes)[number];

export const providerGateModes = ["probe", "replay"] as const;
export type ProviderGateMode = (typeof providerGateModes)[number];

/**
 * Reads `SQUID_PROVIDER`. Absent means `"heuristic"` — the opt-in posture
 * `SQUID_DB` already uses, so not setting anything is exactly current behavior.
 * Returns `null` for a value that is set but not recognized, which the caller
 * reports rather than silently coercing to a default.
 */
export function parseProviderMode(value: string | undefined): ProviderMode | null {
  if (value === undefined) return "heuristic";
  return (providerModes as readonly string[]).includes(value) ? (value as ProviderMode) : null;
}

/** Reads `SQUID_PROVIDER_GATE`. Absent means the fast `"probe"` path. */
export function parseProviderGateMode(value: string | undefined): ProviderGateMode | null {
  if (value === undefined) return "probe";
  return (providerGateModes as readonly string[]).includes(value) ? (value as ProviderGateMode) : null;
}

export interface HeuristicProviderOptions {
  readonly mode: "heuristic";
  readonly heuristic: Predictor;
}

export interface ModelProviderOptions {
  readonly mode: "pi";
  readonly gate: ProviderGateMode;
  /** Basis for the heuristic provider, used whenever the model is not admitted. */
  readonly heuristic: Predictor;
  readonly createPi: () => PredictionProvider;
  /** Resolves `null` when the model is reachable, or a reason when it is not. */
  readonly probePi: () => Promise<string | null>;
  readonly runGate: () => Promise<ProviderGateResult>;
}

/**
 * A union rather than one shape with optional model seams: the heuristic mode
 * needs no way to reach a model, so it must not be handed one. That is what lets
 * a caller in the default mode avoid even importing a model runtime — see
 * `watch-provider.ts`, where the Pi module graph is loaded lazily.
 */
export type SelectPredictionProviderOptions = HeuristicProviderOptions | ModelProviderOptions;

export interface ProviderSelection {
  readonly provider: PredictionProvider;
  readonly contextPolicy: ContextPolicy;
  readonly actionTrust: "trusted" | "suggestion_only";
  /**
   * Why the model-backed provider was not selected, or `null` when it was.
   *
   * The reason is part of the result rather than a side channel because a silent
   * fallback is the exact failure this admission check exists to prevent: a run
   * started with `SQUID_PROVIDER=pi` that quietly predicts with the heuristic
   * looks identical to one where the model is working.
   */
  readonly declineReason: string | null;
}

/**
 * Chooses the primary prediction provider for a live run.
 *
 * Only the primary is chosen here. `PredictionCoordinator` keeps its own
 * heuristic fallback, so a model that is admitted at startup and then fails,
 * times out, or is cancelled mid-run still lands somewhere.
 */
export async function selectPredictionProvider(
  options: SelectPredictionProviderOptions,
): Promise<ProviderSelection> {
  const heuristic = new SyncPredictorProvider(options.heuristic);
  if (options.mode === "heuristic") {
    // The default path: no probe, no gate, no network, no model.
    return {
      provider: heuristic,
      contextPolicy: new PassthroughContextPolicy(),
      actionTrust: "trusted",
      declineReason: null,
    };
  }

  const declineReason = await admitModelProvider(options);
  if (declineReason !== null) {
    return {
      provider: heuristic,
      contextPolicy: new PassthroughContextPolicy(),
      actionTrust: "trusted",
      declineReason,
    };
  }
  return {
    provider: options.createPi(),
    contextPolicy: new RedactingContextPolicy(),
    actionTrust: options.gate === "replay" ? "trusted" : "suggestion_only",
    declineReason: null,
  };
}

/** Returns `null` to admit the model provider, or the reason to decline it. */
async function admitModelProvider(options: ModelProviderOptions): Promise<string | null> {
  if (options.gate === "probe") {
    try {
      return await options.probePi();
    } catch (error) {
      // A probe that throws is evidence about the probe, not about the model —
      // but it is not evidence the model is usable either. Decline, matching the
      // replay gate, which skips rather than passes when it cannot reach one.
      return `availability probe failed: ${errorMessage(error)}`;
    }
  }

  let result: ProviderGateResult;
  try {
    result = await options.runGate();
  } catch (error) {
    return `replay gate could not run: ${errorMessage(error)}`;
  }

  if (result.status === "passed") return null;
  // A skip is not a pass. An unreachable or unevaluated model must not reach the
  // real-time path just because nothing measured a regression against it.
  return result.status === "skipped"
    ? `replay gate skipped: ${result.skipReason ?? "no reason given"}`
    : `replay gate failed: ${result.failures.join("; ") || "no failures reported"}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
