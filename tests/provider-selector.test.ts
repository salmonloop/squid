import { describe, expect, it } from "bun:test";
import { HeuristicPredictor } from "../src/baseline-predictor.js";
import type { PredictionCandidate } from "../src/protocol.js";
import type { PredictionProvider } from "../src/prediction-provider.js";
import type { ProviderGateResult } from "../src/provider-gate.js";
import {
  parseProviderGateMode,
  parseProviderMode,
  selectPredictionProvider,
  type ModelProviderOptions,
} from "../src/provider-selector.js";

/**
 * Every seam is stubbed, so these tests never reach a model, the network, or the
 * replay corpus. The real Pi path stays behind `bun run gate:pi` and manual runs.
 */
const stubPi: PredictionProvider = {
  name: "pi",
  predict: async (): Promise<readonly PredictionCandidate[]> => [],
};

interface Calls {
  createPi: number;
  probePi: number;
  runGate: number;
}

function harness(overrides: {
  probePi?: () => Promise<string | null>;
  runGate?: () => Promise<ProviderGateResult>;
}) {
  const calls: Calls = { createPi: 0, probePi: 0, runGate: 0 };
  const seams: Omit<ModelProviderOptions, "mode" | "gate"> = {
    heuristic: new HeuristicPredictor(),
    createPi: () => {
      calls.createPi += 1;
      return stubPi;
    },
    probePi: async () => {
      calls.probePi += 1;
      return overrides.probePi === undefined ? null : overrides.probePi();
    },
    runGate: async () => {
      calls.runGate += 1;
      if (overrides.runGate === undefined) throw new Error("runGate not stubbed");
      return overrides.runGate();
    },
  };
  return { calls, seams };
}

function gateResult(
  status: ProviderGateResult["status"],
  extra: Partial<ProviderGateResult> = {},
): ProviderGateResult {
  return {
    status,
    failures: [],
    baseline: null,
    candidate: null,
    health: null,
    ...extra,
  };
}

describe("parseProviderMode", () => {
  it("defaults to heuristic when unset and rejects an unrecognized value", () => {
    expect(parseProviderMode(undefined)).toBe("heuristic");
    expect(parseProviderMode("heuristic")).toBe("heuristic");
    expect(parseProviderMode("pi")).toBe("pi");
    expect(parseProviderMode("PI")).toBeNull();
    expect(parseProviderMode("")).toBeNull();
  });
});

describe("parseProviderGateMode", () => {
  it("defaults to the probe path when unset and rejects an unrecognized value", () => {
    expect(parseProviderGateMode(undefined)).toBe("probe");
    expect(parseProviderGateMode("probe")).toBe("probe");
    expect(parseProviderGateMode("replay")).toBe("replay");
    expect(parseProviderGateMode("gate")).toBeNull();
  });
});

describe("selectPredictionProvider in heuristic mode", () => {
  it("answers locally from options that carry no way to reach a model", async () => {
    // The heuristic branch of the options union has no `createPi`, `probePi`, or
    // `runGate` field at all, so "the default path never touches a model" is a
    // property of the type rather than of a code path a future edit could break.
    const selection = await selectPredictionProvider({
      mode: "heuristic",
      heuristic: new HeuristicPredictor(),
    });

    expect(selection.provider.name).toBe("heuristic");
    expect(selection.declineReason).toBeNull();
    expect(selection.actionTrust).toBe("trusted");
    expect(selection.contextPolicy.id).toBe("passthrough");
  });
});

describe("selectPredictionProvider behind the availability probe", () => {
  it("selects the model when the probe reports it reachable", async () => {
    const { calls, seams } = harness({ probePi: async () => null });
    const selection = await selectPredictionProvider({ ...seams, mode: "pi", gate: "probe" });

    expect(selection.provider.name).toBe("pi");
    expect(selection.declineReason).toBeNull();
    expect(selection.actionTrust).toBe("suggestion_only");
    expect(selection.contextPolicy.id).toBe("redacting");
    expect(calls).toEqual({ createPi: 1, probePi: 1, runGate: 0 });
  });

  it("declines with the probe's reason when the model is unreachable", async () => {
    const { calls, seams } = harness({ probePi: async () => "Pi model is unavailable: bifrost/x" });
    const selection = await selectPredictionProvider({ ...seams, mode: "pi", gate: "probe" });

    expect(selection.provider.name).toBe("heuristic");
    expect(selection.declineReason).toBe("Pi model is unavailable: bifrost/x");
    expect(calls.createPi).toBe(0);
  });

  it("declines when the probe itself rejects", async () => {
    // A broken probe is evidence about the probe, not about the model — but it is
    // not evidence the model is usable either.
    const { calls, seams } = harness({
      probePi: () => Promise.reject(new Error("runtime did not start")),
    });
    const selection = await selectPredictionProvider({ ...seams, mode: "pi", gate: "probe" });

    expect(selection.provider.name).toBe("heuristic");
    expect(selection.declineReason).toBe("availability probe failed: runtime did not start");
    expect(calls.createPi).toBe(0);
  });
});

describe("selectPredictionProvider behind the replay gate", () => {
  it("selects the model when the gate passes, without a separate probe", async () => {
    const { calls, seams } = harness({ runGate: async () => gateResult("passed") });
    const selection = await selectPredictionProvider({ ...seams, mode: "pi", gate: "replay" });

    expect(selection.provider.name).toBe("pi");
    expect(selection.declineReason).toBeNull();
    expect(selection.actionTrust).toBe("trusted");
    expect(selection.contextPolicy.id).toBe("redacting");
    // The gate probes availability itself, so the selector must not probe twice.
    expect(calls).toEqual({ createPi: 1, probePi: 0, runGate: 1 });
  });

  it("declines with the measured failures when the gate fails", async () => {
    const { calls, seams } = harness({
      runGate: async () => gateResult("failed", {
        failures: ["top1 regressed", "fallback rate too high"],
      }),
    });
    const selection = await selectPredictionProvider({ ...seams, mode: "pi", gate: "replay" });

    expect(selection.provider.name).toBe("heuristic");
    expect(selection.declineReason)
      .toBe("replay gate failed: top1 regressed; fallback rate too high");
    expect(calls.createPi).toBe(0);
  });

  it("declines when the gate skips, because a skip is not a pass", async () => {
    // An unreachable or unevaluated model must not reach the real-time path just
    // because nothing measured a regression against it.
    const { calls, seams } = harness({
      runGate: async () => gateResult("skipped", {
        skipReason: "provider unavailable: no model",
      }),
    });
    const selection = await selectPredictionProvider({ ...seams, mode: "pi", gate: "replay" });

    expect(selection.provider.name).toBe("heuristic");
    expect(selection.declineReason)
      .toBe("replay gate skipped: provider unavailable: no model");
    expect(calls.createPi).toBe(0);
  });

  it("declines when the gate itself rejects", async () => {
    const { calls, seams } = harness({
      runGate: () => Promise.reject(new Error("fixture corpus missing")),
    });
    const selection = await selectPredictionProvider({ ...seams, mode: "pi", gate: "replay" });

    expect(selection.provider.name).toBe("heuristic");
    expect(selection.declineReason).toBe("replay gate could not run: fixture corpus missing");
    expect(calls.createPi).toBe(0);
  });
});
