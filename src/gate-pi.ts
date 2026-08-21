import { heuristicEvaluationScenarios } from "./evaluation-fixtures.js";
import { PiRuntime } from "./pi-runtime.js";
import { runProviderGate } from "./provider-gate.js";

/**
 * Replay gate for the Pi-backed predictor.
 *
 * This is a separate entry point from `bun run evaluate` on purpose: it needs a
 * reachable model and takes seconds per cut point, so it must not sit inside
 * the offline test suite. Exit code 1 means a measured regression; a skip exits
 * 0 with a stated reason, because an unreachable model is not evidence about
 * the model.
 */
const result = await runProviderGate({
  scenarios: heuristicEvaluationScenarios,
  createProvider: () => new PiRuntime(),
  // Resolve the model once up front. A missing model or unreachable runtime
  // must skip, not fail — otherwise a config outage is indistinguishable from
  // a ranking regression.
  probeAvailability: () => new PiRuntime().checkAvailability(),
  // Well above the observed 10–35s single-call latency of the bifrost
  // endpoint (time-to-first-byte varies widely), below the point where a
  // hung provider would stall the whole gate. The gate measures ranking
  // quality; endpoint slowness must not read as a wrong answer.
  timeoutMs: 90_000,
});

console.log(JSON.stringify(result, null, 2));

if (result.status === "failed") {
  console.error("Pi provider gate FAILED — not eligible for a real-time path:");
  for (const failure of result.failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

if (result.status === "skipped") {
  console.error(`Pi provider gate SKIPPED — ${result.skipReason}`);
}
