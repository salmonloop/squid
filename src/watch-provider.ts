import { HeuristicPredictor } from "./baseline-predictor.js";
import {
  parseProviderGateMode,
  parseProviderMode,
  selectPredictionProvider,
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
    return { ok: false, configError: 'SQUID_PROVIDER must be "heuristic" or "pi".' };
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
