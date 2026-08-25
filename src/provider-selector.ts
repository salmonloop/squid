import { describeErrorForAudit } from "./action-egress.js";
import type { Predictor } from "./baseline-predictor.js";
import type { PredictionProvider } from "./prediction-provider.js";
import { SyncPredictorProvider } from "./prediction-provider.js";
import type { ProviderGateResult } from "./provider-gate.js";
import type { SemanticGateResult } from "./semantic-gate.js";
import { PassthroughContextPolicy, RedactingContextPolicy, type ContextPolicy } from "./context-policy.js";

export const providerModes = ["heuristic", "pi", "cognition"] as const;
export type ProviderMode = (typeof providerModes)[number];

export const providerGateModes = ["probe", "replay", "off"] as const;
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

/**
 * Reads `SQUID_PROVIDER_GATE`. Absent means the fast `"probe"` path.
 *
 * `"off"` is the explicit bypass: no gate runs and the provider is admitted as
 * trusted. It exists because both real gates are measured walls for the current
 * model — the replay gate on ranking nondeterminism, the semantic gate on
 * stability — so without it every model path is either unable to speak or
 * unable to act, and no MVP can ship. Off is opt-in by spelling, never by
 * absence; the default stays probe, which admits a reachable model to speak
 * but withholds dispatch trust.
 */
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
 * The belief-backed cognition path.
 *
 * Admitted only by the semantic gate, never by a probe. The distinction from `pi`
 * is not politeness about a second model: a cognition provider *reorders what a
 * user is offered*, so the question "is it reachable" is not the question that
 * matters. What matters is whether it answers the same way twice on the same
 * screen, and only a replay can establish that — see `runSemanticGate`, which
 * refuses a provider whose top-1 answer moves between runs however well it scores
 * on average.
 */
export interface CognitionProviderOptions {
  readonly mode: "cognition";
  readonly gate: ProviderGateMode;
  /** Basis for the heuristic provider, used whenever cognition is not admitted. */
  readonly heuristic: Predictor;
  readonly createCognition: () => PredictionProvider;
  readonly runSemanticGate: () => Promise<SemanticGateResult>;
  /**
   * The policy this provider's state is projected through, supplied by the caller
   * rather than constructed here.
   *
   * Required, and required for a specific reason: the belief layer behind a
   * cognition provider must be told the id of the policy that actually ran, and
   * the gate must apply that same policy. Three separate `new
   * RedactingContextPolicy()` calls — one for the resolver's claimed id, one for
   * the gate, one for the returned selection — agree only by the coincidence of a
   * shared literal. Threading one instance makes the agreement structural.
   */
  readonly contextPolicy: ContextPolicy;
}

/**
 * A union rather than one shape with optional model seams: the heuristic mode
 * needs no way to reach a model, so it must not be handed one. That is what lets
 * a caller in the default mode avoid even importing a model runtime — see
 * `watch-provider.ts`, where the Pi module graph is loaded lazily.
 */
export type SelectPredictionProviderOptions =
  | HeuristicProviderOptions
  | ModelProviderOptions
  | CognitionProviderOptions;

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

  const declineReason = options.mode === "pi"
    ? await admitModelProvider(options)
    : await admitCognitionProvider(options);
  if (declineReason !== null) {
    return {
      provider: heuristic,
      contextPolicy: new PassthroughContextPolicy(),
      actionTrust: "trusted",
      declineReason,
    };
  }
  return {
    // Both admitted paths get a redacting policy, and for the same reason: a
    // provider that reasons about the projection is an egress boundary whether it
    // runs out of process or not. Cognition is in-process today, but the belief
    // producer behind it is a seam a model is meant to fill — and a policy chosen
    // by where the code happens to run would silently widen the moment it does.
    //
    // Cognition brings its own instance because its belief layer names the policy
    // and its gate has to apply it; the two must be the same object, not two
    // constructions that share a literal id. Pi constructs one here because
    // nothing downstream of it reads a policy id — see the note on
    // `CognitionProviderOptions.contextPolicy`.
    provider: options.mode === "pi" ? options.createPi() : options.createCognition(),
    contextPolicy: options.mode === "pi"
      ? new RedactingContextPolicy()
      : options.contextPolicy,
    // Trust follows the gate spelling, and each of the three means something
    // distinct. `replay` earns trust by measurement — "it answers as well as
    // the heuristic, and answers the same way twice". `off` claims it by
    // declaration: the operator spelled the bypass, so the model's word alone
    // authorizes dispatch, and admission still runs every world-state check on
    // top. `probe` stays untrusted — "it answers" is not grounds for action,
    // which is the constraint issue #4 names; `action-admission.ts` refuses a
    // claim unless both the attempt and the runtime are trusted, so no provider
    // can grant itself what this line withholds.
    actionTrust: options.gate === "probe" ? "suggestion_only" : "trusted",
    declineReason: null,
  };
}

/** Returns `null` to admit the model provider, or the reason to decline it. */
async function admitModelProvider(options: ModelProviderOptions): Promise<string | null> {
  // Off admits without measuring. The trust decision below is what makes that
  // deliberate rather than accidental: this spelling, and only this one, hands
  // the model dispatch authority nobody verified.
  if (options.gate === "off") return null;
  if (options.gate === "probe") {
    try {
      return await options.probePi();
    } catch (error) {
      // A probe that throws is evidence about the probe, not about the model —
      // but it is not evidence the model is usable either. Decline, matching the
      // replay gate, which skips rather than passes when it cannot reach one.
      return `availability probe failed: ${describeErrorForAudit(error)}`;
    }
  }

  let result: ProviderGateResult;
  try {
    result = await options.runGate();
  } catch (error) {
    return `replay gate could not run: ${describeErrorForAudit(error)}`;
  }
  return readGateVerdict(result, "replay gate");
}

/**
 * Returns `null` to admit the cognition provider, or the reason to decline it.
 *
 * There is no probe branch, and that asymmetry is deliberate. Reachability is the
 * question worth asking about an out-of-process model, because the alternative to
 * reaching it is silence. A cognition provider is *always* reachable — it reorders
 * candidates the heuristic already produced — so a probe would admit every one of
 * them while measuring nothing. The gate runs in both modes; what `gate` decides is
 * only whether a pass earns dispatch trust.
 */
async function admitCognitionProvider(options: CognitionProviderOptions): Promise<string | null> {
  // Same bypass as the model path, same reason: the semantic gate's stability
  // floor is a measured wall for the current producer, and `off` is the one
  // spelling that says "admit anyway". The gate callback stays wired in
  // watch-provider so flipping back to replay needs no reassembly.
  if (options.gate === "off") return null;
  let result: SemanticGateResult;
  try {
    result = await options.runSemanticGate();
  } catch (error) {
    return `semantic gate could not run: ${describeErrorForAudit(error)}`;
  }
  return readGateVerdict(result, "semantic gate");
}

/**
 * The one reading of a gate result both paths share.
 *
 * Shared because the rule is the same rule, and stating it twice is how the two
 * would drift: a skip is not a pass. An unreachable or unevaluated provider must
 * not reach the real-time path just because nothing measured a regression against
 * it — that is precisely how an unevaluated predictor gets to production.
 */
function readGateVerdict(
  result: {
    readonly status: "passed" | "failed" | "skipped";
    readonly skipReason?: string;
    readonly failures: readonly string[];
  },
  label: string,
): string | null {
  if (result.status === "passed") return null;
  return result.status === "skipped"
    ? `${label} skipped: ${result.skipReason ?? "no reason given"}`
    : `${label} failed: ${result.failures.join("; ") || "no failures reported"}`;
}