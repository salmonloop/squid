import { describe, expect, it } from "bun:test";
import { HeuristicPredictor } from "../src/baseline-predictor.js";
import { heuristicEvaluationScenarios } from "../src/evaluation-fixtures.js";
import { SyncPredictorProvider, type PredictionProvider } from "../src/prediction-provider.js";
import type { PredictionCandidate, WorldState } from "../src/protocol.js";
import { defaultGateThresholds, runProviderGate } from "../src/provider-gate.js";

/** A provider that always declines to predict — worst case for top1 coverage. */
const silentProvider = (): PredictionProvider => ({
  name: "silent",
  predict: async () => [],
});

/** Mirrors the baseline exactly, so the gate must accept it. */
const baselineEquivalentProvider = (): PredictionProvider =>
  new SyncPredictorProvider(new HeuristicPredictor(), "baseline-equivalent");

describe("runProviderGate", () => {
  it("passes a provider that matches the baseline", async () => {
    const result = await runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: baselineEquivalentProvider,
    });

    expect(result.status).toBe("passed");
    expect(result.failures).toEqual([]);
    expect(result.candidate!.top1.rate).toBe(result.baseline!.top1.rate);
  });

  it("fails a provider that regresses below the baseline floor", async () => {
    const result = await runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: silentProvider,
    });

    expect(result.status).toBe("failed");
    expect(result.failures.join(" ")).toContain("top1");
    // A failure must still carry both reports, so the regression is inspectable.
    expect(result.baseline).not.toBeNull();
    expect(result.candidate).not.toBeNull();
  });

  it("skips rather than fails when the provider cannot be constructed", async () => {
    const result = await runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: () => {
        throw new Error("PI_MODEL_ID is not configured");
      },
    });

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toContain("PI_MODEL_ID is not configured");
    expect(result.failures).toEqual([]);
    // No baseline was spent, because the candidate could never be scored.
    expect(result.baseline).toBeNull();
    expect(result.candidate).toBeNull();
  });

  it("skips a lazily-resolved provider that reports itself unavailable", async () => {
    // This is the shape that actually matters. PiRuntime constructs fine and
    // only discovers an unreachable model later, so a construction probe alone
    // would report an outage as a ranking regression.
    let scored = false;
    const result = await runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: () => ({
        name: "lazy-pi",
        predict: async () => {
          scored = true;
          throw new Error("Pi model is unavailable: bifrost/some-model");
        },
      }),
      probeAvailability: async () => "Pi model is unavailable: bifrost/some-model",
    });

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toContain("bifrost/some-model");
    expect(scored).toBe(false);
    expect(result.baseline).toBeNull();
  });

  it("skips when the availability probe itself rejects", async () => {
    const result = await runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: baselineEquivalentProvider,
      probeAvailability: async () => {
        throw new Error("model runtime failed to start");
      },
    });

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toContain("model runtime failed to start");
  });

  it("scores the provider when the probe reports it available", async () => {
    const result = await runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: baselineEquivalentProvider,
      probeAvailability: async () => null,
    });

    expect(result.status).toBe("passed");
    expect(result.skipReason).toBeUndefined();
    expect(result.health!.answered).toBeGreaterThan(0);
  });

  it("fails a provider that never answers, despite baseline-equal ranking", async () => {
    // The trap this closes: the coordinator substitutes the heuristic on every
    // failure, so a permanently broken model posts baseline scores. Ranking
    // alone would call that a pass.
    const result = await runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: () => ({
        name: "exploding",
        predict: () => {
          throw new Error("model endpoint unreachable");
        },
      }),
    });

    expect(result.candidate!.top1.rate).toBe(result.baseline!.top1.rate);
    expect(result.status).toBe("failed");
    expect(result.failures.join(" ")).toContain("fallback rate");
    expect(result.health!.answered).toBe(0);
    expect(result.health!.fallbacks[0]).toBe("model endpoint unreachable");
  });

  it("counts a timeout as a fallback, not an answer", async () => {
    const result = await runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: () => ({
        name: "slow",
        predict: (_request, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      }),
      timeoutMs: 20,
    });

    expect(result.status).toBe("failed");
    expect(result.health!.answered).toBe(0);
    expect(result.health!.fallbackRate).toBe(1);
  });

  it("reports full health for a provider that answers every request", async () => {
    const result = await runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: baselineEquivalentProvider,
    });

    expect(result.health!.requests).toBe(result.candidate!.cutPointCount);
    expect(result.health!.answered).toBe(result.health!.requests);
    expect(result.health!.fallbacks).toEqual([]);
    expect(result.health!.fallbackRate).toBe(0);
  });

  it("does not treat an unreachable provider as a pass", async () => {
    const skipped = await runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: () => {
        throw new Error("unreachable");
      },
    });

    expect(skipped.status).not.toBe("passed");
    expect(skipped.status).not.toBe("failed");
  });

  it("compares each run against a baseline on the same corpus", async () => {
    // Both reports must come from one fixture set, or a candidate could post a
    // high rate on a handful of easy cut points.
    const partial = await runProviderGate({
      scenarios: heuristicEvaluationScenarios.slice(0, 1),
      createProvider: baselineEquivalentProvider,
    });
    const full = await runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: baselineEquivalentProvider,
    });

    expect(partial.candidate!.cutPointCount).toBeLessThan(full.candidate!.cutPointCount);
    expect(partial.candidate!.cutPointCount).toBe(partial.baseline!.cutPointCount);
    expect(full.candidate!.cutPointCount).toBe(full.baseline!.cutPointCount);
  });

  it("honors a custom slack that admits a regression", async () => {
    const strict = await runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: silentProvider,
      thresholds: { top1Slack: 0, noneCorrectnessSlack: 0, maxFallbackRate: 0 },
    });
    const permissive = await runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: silentProvider,
      thresholds: { top1Slack: 1, noneCorrectnessSlack: 1, maxFallbackRate: 1 },
    });

    expect(strict.status).toBe("failed");
    // A silent provider answers its requests — it just answers with nothing —
    // so relaxing the ranking floors is enough to admit it.
    expect(permissive.status).toBe("passed");
    expect(permissive.health!.answered).toBe(permissive.health!.requests);
  });

  it("keeps default slack tight enough to catch a two-cut-point regression", () => {
    // Twelve cut points: one is ~0.083, two are ~0.167. The defaults must sit
    // between them, or the gate either flaps or stops catching regressions.
    expect(defaultGateThresholds.top1Slack).toBeGreaterThan(1 / 12);
    expect(defaultGateThresholds.top1Slack).toBeLessThan(2 / 12);
    expect(defaultGateThresholds.maxFallbackRate).toBeGreaterThan(1 / 12);
    expect(defaultGateThresholds.maxFallbackRate).toBeLessThan(2 / 12);
    expect(defaultGateThresholds.noneCorrectnessSlack).toBe(0);
  });

  it("fails a provider that suggests an action where none is correct", async () => {
    // noneCorrectness has zero slack: firing on a stale-context negative is
    // the failure mode that makes an assistant feel broken.
    const alwaysActs = (): PredictionProvider => ({
      name: "always-acts",
      predict: async (): Promise<readonly PredictionCandidate[]> => [
        {
          kind: "run_tests",
          rationale: "always",
          confidence: 1,
          expiresAt: "2099-01-01T00:00:00.000Z",
          sourceEventIds: [],
          parameters: {},
        },
      ],
    });

    const result = await runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: alwaysActs,
    });

    expect(result.status).toBe("failed");
    expect(result.failures.join(" ")).toContain("noneCorrectness");
  });

  it("counts a provider that ignores its abort signal as a fallback, not an answer", async () => {
    // The failure this guards against: a provider whose predict never settles
    // and which ignores its AbortSignal. The coordinator times out and
    // substitutes the heuristic, so the ranking report shows baseline scores.
    // If the health observer only counted rejections, `failures` would stay
    // empty, fallbackRate would be 0, and a provider that never actually ran
    // would be reported as "passed".
    const hungProvider = (): PredictionProvider => ({
      name: "hung",
      predict: () => new Promise<readonly PredictionCandidate[]>(() => {}),
    });

    const result = await runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: hungProvider,
      timeoutMs: 20,
    });

    expect(result.status).toBe("failed");
    expect(result.health!.answered).toBe(0);
    expect(result.health!.fallbackRate).toBe(1);
    expect(result.failures.join(" ")).toContain("fallback rate");
  });

  it("still credits a conforming provider as having answered", async () => {
    // The complement of the test above: the abort race must not turn a provider
    // that settles normally into a spurious fallback.
    const result = await runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: baselineEquivalentProvider,
    });

    expect(result.health!.fallbacks).toEqual([]);
    expect(result.health!.answered).toBe(result.health!.requests);
    expect(result.health!.requests).toBeGreaterThan(0);
  });
});

describe("provider gate corpus assumptions", () => {
  it("scores the heuristic baseline on every fixture cut point", async () => {
    const result = await runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: baselineEquivalentProvider,
    });

    expect(result.baseline!.cutPointCount).toBe(result.candidate!.cutPointCount);
    expect(result.baseline!.cutPointCount).toBeGreaterThan(0);
  });

  it("passes the provider projected state, matching the real-time path", async () => {
    const seen: WorldState[] = [];
    const spy = (): PredictionProvider => ({
      name: "spy",
      predict: async (request) => {
        seen.push(request.worldState);
        return [];
      },
    });

    const result = await runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: spy,
      thresholds: { top1Slack: 1, noneCorrectnessSlack: 1, maxFallbackRate: 1 },
    });

    expect(seen).toHaveLength(result.candidate!.cutPointCount);
    // Every cut point must reach the provider with a real state snapshot.
    expect(seen.every((state) => state.updatedAt !== null)).toBe(true);
  });
});
