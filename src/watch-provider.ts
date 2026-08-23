import { HeuristicPredictor } from "./baseline-predictor.js";
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

export async function resolveWatchProvider(
  env: Record<string, string | undefined> = process.env,
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
    return { ok: true, selection: await resolveCognitionProvider(gate) };
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
 * The subtle requirement is that the gate must score *the provider the live run
 * would use*, which means the belief resolver inside it has to be told the same
 * `contextPolicyId` the coordinator will apply. Get that wrong and every belief
 * batch fails `context_policy_mismatch` during the replay: the gate would then
 * measure a cognition layer that never once saw a belief, pass it for being
 * indistinguishable from the heuristic, and admit it — after which the live run,
 * with beliefs flowing, behaves like something the gate never tested.
 *
 * `selectPredictionProvider` decides the policy, so its id is read from the class
 * rather than repeated as a literal here.
 */
async function resolveCognitionProvider(
  gate: ProviderGateMode,
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

  const contextPolicyId = new RedactingContextPolicy().id;
  const createProvider = () => new BeliefBackedPredictionProvider(
    new BeliefRerankCognition(),
    createBeliefResolver({
      beliefProvider: new HeuristicBeliefProvider(),
      contextPolicyId,
    }),
  );

  return selectPredictionProvider({
    mode: "cognition",
    gate,
    heuristic: new HeuristicPredictor(),
    createCognition: createProvider,
    // No `probeAvailability`: an in-process provider cannot be unavailable, and
    // supplying a probe that always succeeds would only add a way for the gate to
    // skip — which reads as "not evaluated", the one verdict that must not admit.
    runSemanticGate: () => runSemanticGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider,
    }),
  });
}
