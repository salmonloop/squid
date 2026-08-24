import { HeuristicPredictor } from "./baseline-predictor.js";
import type { BeliefOutcome } from "./belief-provider.js";
import { RedactingContextPolicy } from "./context-policy.js";
import {
  parseProviderGateMode,
  parseProviderMode,
  selectPredictionProvider,
  type ProviderGateMode,
  type ProviderSelection,
} from "./provider-selector.js";
import { DEFAULT_PROVIDER_GATE_TIMEOUT_MS } from "./provider-gate.js";

/**
 * Wires the real Pi and replay-gate seams into `selectPredictionProvider` and
 * reads the two environment variables both watch entry points use.
 *
 * This file exists so `provider-selector.ts` stays a pure function of its
 * inputs: the selector is unit-tested with stubs and imports no model runtime,
 * while everything env-dependent and dependency-heavy lives here — the same
 * split as `provider-gate.ts` versus `gate-pi.ts`. Both entry points call this
 * rather than duplicating the wiring.
 *
 * The Pi module graph is imported lazily, inside the `pi` branch only. Loading
 * it costs roughly 650ms on this machine, which the default heuristic path has
 * no reason to pay — and a static import would make "the default touches no
 * model" true only of execution, not of startup.
 */
export type WatchProviderResolution =
  | { readonly ok: true; readonly selection: ProviderSelection }
  /** A recognized variable held an unrecognized value. The caller reports and exits. */
  | { readonly ok: false; readonly configError: string };

/** What a resolved provider reports about its own belief layer, per request. */
export interface WatchProviderDiagnostic {
  readonly kind: "belief_outcome";
  readonly requestId: string;
  readonly provider: string;
  readonly status: BeliefOutcome["status"];
  readonly latencyMs: number;
  /** Absent on success. Already sanitized where it carries provider text. */
  readonly reasonCode?: string;
}

export interface ResolveWatchProviderOptions {
  /**
   * Reports belief outcomes for a cognition run.
   *
   * Without it, a cognition provider silently predicting belief-free forever is
   * indistinguishable from one the belief layer is feeding — the two differ only
   * in the ranking, and a wrong ranking looks like a bad model rather than a
   * starved one. Optional so existing callers and tests are unchanged, but the
   * watch session supplies it.
   */
  readonly onDiagnostic?: (diagnostic: WatchProviderDiagnostic) => void;
}

export async function resolveWatchProvider(
  env: Record<string, string | undefined> = process.env,
  options: ResolveWatchProviderOptions = {},
): Promise<WatchProviderResolution> {
  const mode = parseProviderMode(env.SQUID_PROVIDER);
  if (mode === null) {
    return {
      ok: false,
      configError: 'SQUID_PROVIDER must be "heuristic", "pi", or "cognition".',
    };
  }

  const gate = parseProviderGateMode(env.SQUID_PROVIDER_GATE);
  if (gate === null) {
    return { ok: false, configError: 'SQUID_PROVIDER_GATE must be "probe" or "replay".' };
  }

  if (mode === "heuristic") {
    return {
      ok: true,
      selection: await selectPredictionProvider({
        mode,
        heuristic: new HeuristicPredictor(),
      }),
    };
  }

  if (mode === "cognition") {
    return {
      ok: true,
      selection: await resolveCognitionProvider(gate, options.onDiagnostic),
    };
  }

  const [{ PiRuntime }, { runProviderGate }, { heuristicEvaluationScenarios }] = await Promise.all([
    import("./pi-runtime.js"),
    import("./provider-gate.js"),
    import("./evaluation-fixtures.js"),
  ]);

  const selection = await selectPredictionProvider({
    mode,
    gate,
    heuristic: new HeuristicPredictor(),
    createPi: () => new PiRuntime(),
    // Resolve the model once up front, so an outage declines with a stated
    // reason instead of surfacing as a failed prediction on the first event.
    probePi: () => new PiRuntime().checkAvailability(),
    runGate: () => runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: () => new PiRuntime(),
      probeAvailability: () => new PiRuntime().checkAvailability(),
      // Matches `gate:pi`: well above the observed single-call latency, below
      // the point where a hung provider would stall startup indefinitely.
      timeoutMs: DEFAULT_PROVIDER_GATE_TIMEOUT_MS,
    }),
  });

  return { ok: true, selection };
}

/**
 * Assembles the belief-backed cognition provider and the gate that admits it.
 *
 * One `ContextPolicy` instance is built here and used three times: the gate
 * projects state through it, the belief resolver names it, and the selection
 * returns it so the live coordinator applies it. All three have to be the same
 * policy or the gate is not scoring the run it authorizes — and the failure is
 * quiet in both directions.
 *
 * Get the *id* wrong and every belief batch fails `context_policy_mismatch`
 * during the replay, so the gate measures a cognition layer that never saw a
 * belief and passes it for being indistinguishable from the heuristic. Get the
 * *policy* wrong — the original defect here — and the gate feeds the belief
 * producer full window titles and paths while the live run feeds it redacted
 * ones, so a producer earns `trusted` on evidence it can never reproduce. The
 * belief contract cannot catch the second case: a cooperative producer echoes
 * back whatever id it was handed, so request and batch agree either way.
 */
async function resolveCognitionProvider(
  gate: ProviderGateMode,
  onDiagnostic: ((diagnostic: WatchProviderDiagnostic) => void) | undefined,
): Promise<ProviderSelection> {
  const [
    { BeliefRerankCognition },
    { HeuristicBeliefProvider },
    { createBeliefResolver },
    { BeliefBackedPredictionProvider },
    { runSemanticGate },
    { heuristicEvaluationScenarios },
  ] = await Promise.all([
    import("./belief-rerank-cognition.js"),
    import("./heuristic-belief-provider.js"),
    import("./belief-resolver.js"),
    import("./cognition-provider.js"),
    import("./semantic-gate.js"),
    import("./evaluation-fixtures.js"),
  ]);

  const contextPolicy = new RedactingContextPolicy();
  const buildResolver = (observe: boolean) => createBeliefResolver({
    beliefProvider: new HeuristicBeliefProvider(),
    contextPolicyId: contextPolicy.id,
    // Only the live provider reports. The gate runs the corpus four times, so
    // wiring it there would emit sixty lines of startup noise describing a replay
    // rather than the user's session — and the gate already reports its own
    // verdict.
    ...(observe && onDiagnostic !== undefined
      ? {
        onOutcome: (outcome) => onDiagnostic({
          kind: "belief_outcome",
          requestId: outcome.requestId,
          provider: outcome.provider,
          status: outcome.status,
          latencyMs: outcome.latencyMs,
          // Never the batch. `status` and `reasonCode` are a closed vocabulary
          // plus already-sanitized provider text; the beliefs themselves stay
          // inside the prediction path.
          ...(outcome.reasonCode === undefined ? {} : { reasonCode: outcome.reasonCode }),
        }),
      }
      : {}),
  });

  const createGateProvider = () => new BeliefBackedPredictionProvider(
    new BeliefRerankCognition(),
    buildResolver(false),
  );

  return selectPredictionProvider({
    mode: "cognition",
    gate,
    heuristic: new HeuristicPredictor(),
    createCognition: () => new BeliefBackedPredictionProvider(
      new BeliefRerankCognition(),
      buildResolver(true),
    ),
    contextPolicy,
    // No `probeAvailability`: an in-process provider cannot be unavailable, and
    // supplying a probe that always succeeds would only add a way for the gate to
    // skip — which reads as "not evaluated", the one verdict that must not admit.
    runSemanticGate: () => runSemanticGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: createGateProvider,
      contextPolicy,
    }),
  });
}
