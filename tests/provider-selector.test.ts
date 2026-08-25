import { describe, expect, it } from "bun:test";
import { HeuristicPredictor } from "../src/baseline-predictor.js";
import type { PredictionCandidate } from "../src/protocol.js";
import type { PredictionProvider } from "../src/prediction-provider.js";
import { RedactingContextPolicy } from "../src/context-policy.js";
import type { ProviderGateResult } from "../src/provider-gate.js";
import type { SemanticGateResult } from "../src/semantic-gate.js";
import {
  parseProviderGateMode,
  parseProviderMode,
  selectPredictionProvider,
  type CognitionProviderOptions,
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

const stubCognition: PredictionProvider = {
  name: "belief-rerank",
  predict: async (): Promise<readonly PredictionCandidate[]> => [],
};

function cognitionHarness(result: () => Promise<SemanticGateResult>) {
  const calls = { createCognition: 0, runSemanticGate: 0 };
  // The caller supplies the policy so one instance can be shared by the gate,
  // the belief resolver's claimed id, and the returned selection. Asserting
  // identity below — not just a matching id — is what would catch a future edit
  // that reverted to constructing a second one here.
  const contextPolicy = new RedactingContextPolicy();
  const seams: Omit<CognitionProviderOptions, "mode" | "gate"> = {
    heuristic: new HeuristicPredictor(),
    contextPolicy,
    createCognition: () => {
      calls.createCognition += 1;
      return stubCognition;
    },
    runSemanticGate: async () => {
      calls.runSemanticGate += 1;
      return result();
    },
  };
  return { calls, seams, contextPolicy };
}

function semanticResult(
  status: SemanticGateResult["status"],
  extra: Partial<SemanticGateResult> = {},
): SemanticGateResult {
  return { status, failures: [], ranking: null, stability: null, ...extra };
}

describe("parseProviderMode", () => {
  it("defaults to heuristic when unset and rejects an unrecognized value", () => {
    expect(parseProviderMode(undefined)).toBe("heuristic");
    expect(parseProviderMode("heuristic")).toBe("heuristic");
    expect(parseProviderMode("pi")).toBe("pi");
    expect(parseProviderMode("cognition")).toBe("cognition");
    expect(parseProviderMode("PI")).toBeNull();
    expect(parseProviderMode("")).toBeNull();
  });
});

describe("parseProviderGateMode", () => {
  it("defaults to off when unset and rejects an unrecognized value", () => {
    // Open by default: the gates are measured walls for the current model, so
    // making measurement the default made every model path speak-only or
    // unadmittable. Restricting is spelled; absence is not a restriction.
    expect(parseProviderGateMode(undefined)).toBe("off");
    expect(parseProviderGateMode("off")).toBe("off");
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
    // No policy passed means passthrough — open by default; redaction is an
    // explicit SQUID_CONTEXT_POLICY=redacting decision at the call site.
    expect(selection.contextPolicy.id).toBe("passthrough");
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
    expect(selection.contextPolicy.id).toBe("passthrough");
    // The gate probes availability itself, so the selector must not probe twice.
    expect(calls).toEqual({ createPi: 1, probePi: 0, runGate: 1 });
  });

  it("applies a caller-supplied policy verbatim — redaction is the opt-in", async () => {
    const { seams } = harness({ runGate: async () => gateResult("passed") });
    const policy = new RedactingContextPolicy();
    const selection = await selectPredictionProvider({
      ...seams,
      mode: "pi",
      gate: "replay",
      contextPolicy: policy,
    });

    // Identity, not just id: the gate and the live run must project through
    // the same object.
    expect(selection.contextPolicy).toBe(policy);
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

/**
 * The cognition path has no probe branch, and that asymmetry is the point.
 * Reachability is the question worth asking about an out-of-process model; a
 * cognition provider reorders candidates the heuristic already produced, so it is
 * always reachable and a probe would admit every one of them while measuring
 * nothing. What `gate` decides here is only whether a pass earns dispatch trust.
 */
describe("selectPredictionProvider in cognition mode", () => {
  it("admits the cognition path when the semantic gate passes", async () => {
    const { calls, seams, contextPolicy } = cognitionHarness(async () => semanticResult("passed"));
    const selection = await selectPredictionProvider({ ...seams, mode: "cognition", gate: "replay" });

    expect(selection.provider.name).toBe("belief-rerank");
    expect(selection.declineReason).toBeNull();
    expect(selection.actionTrust).toBe("trusted");
    // The caller's own instance, not a second one that happens to share the id.
    // A matching id would pass while the gate scored a different projection than
    // the live coordinator applies — the defect this threading exists to close.
    expect(selection.contextPolicy).toBe(contextPolicy);
    expect(calls).toEqual({ createCognition: 1, runSemanticGate: 1 });
  });

  it("runs the gate even in probe mode, but withholds dispatch trust", async () => {
    // Issue #4's constraint: `actionTrust` stays `suggestion_only` for any
    // un-gated provider. A probe says only "it answers"; a replay says "it answers
    // as well as the heuristic, and answers the same way twice". Only the second
    // is grounds for trust, and `action-admission.ts` refuses a claim whose
    // runtime is not trusted — so a cognition provider cannot grant itself what
    // this withholds.
    const { calls, seams } = cognitionHarness(async () => semanticResult("passed"));
    const selection = await selectPredictionProvider({ ...seams, mode: "cognition", gate: "probe" });

    expect(selection.provider.name).toBe("belief-rerank");
    expect(selection.actionTrust).toBe("suggestion_only");
    expect(calls.runSemanticGate).toBe(1);
  });

  it("declines with the measured failures when the gate fails", async () => {
    const { calls, seams } = cognitionHarness(async () => semanticResult("failed", {
      failures: ["top1_stability 0.533 < 1"],
    }));
    const selection = await selectPredictionProvider({ ...seams, mode: "cognition", gate: "replay" });

    expect(selection.provider.name).toBe("heuristic");
    expect(selection.declineReason).toBe("semantic gate failed: top1_stability 0.533 < 1");
    expect(selection.actionTrust).toBe("trusted");
    expect(calls.createCognition).toBe(0);
  });

  it("declines when the gate skips, because a skip is not a pass", async () => {
    const { calls, seams } = cognitionHarness(async () => semanticResult("skipped", {
      skipReason: "provider unavailable: belief service down",
    }));
    const selection = await selectPredictionProvider({ ...seams, mode: "cognition", gate: "replay" });

    expect(selection.provider.name).toBe("heuristic");
    expect(selection.declineReason)
      .toBe("semantic gate skipped: provider unavailable: belief service down");
    expect(calls.createCognition).toBe(0);
  });

  it("declines when the gate itself rejects", async () => {
    const { calls, seams } = cognitionHarness(() =>
      Promise.reject(new Error("fixture corpus missing")));
    const selection = await selectPredictionProvider({ ...seams, mode: "cognition", gate: "replay" });

    expect(selection.provider.name).toBe("heuristic");
    expect(selection.declineReason).toBe("semantic gate could not run: fixture corpus missing");
    expect(calls.createCognition).toBe(0);
  });
});

describe("selectPredictionProvider with the gate off", () => {
  it("admits the model unmeasured and grants dispatch trust, running no check", async () => {
    // The explicit bypass. Both real gates are measured walls for the current
    // model (ranking nondeterminism; stability), so `off` is the one spelling
    // that lets a model both speak and act today. Nothing runs — not even the
    // cheap reachability probe — because off means the operator takes the
    // measurement's place.
    const { calls, seams } = harness({
      probePi: async () => "should never be asked",
      runGate: async () => { throw new Error("no gate may run when off"); },
    });
    const selection = await selectPredictionProvider({ ...seams, mode: "pi", gate: "off" });

    expect(selection.provider.name).toBe("pi");
    expect(selection.declineReason).toBeNull();
    expect(selection.actionTrust).toBe("trusted");
    expect(selection.contextPolicy.id).toBe("passthrough");
    expect(calls).toEqual({ createPi: 1, probePi: 0, runGate: 0 });
  });

  it("skips the semantic gate for cognition and still grants dispatch trust", async () => {
    const { calls, seams, contextPolicy } = cognitionHarness(async () => semanticResult("failed"));
    const selection = await selectPredictionProvider({ ...seams, mode: "cognition", gate: "off" });

    expect(selection.provider.name).toBe("belief-rerank");
    expect(selection.declineReason).toBeNull();
    expect(selection.actionTrust).toBe("trusted");
    expect(selection.contextPolicy).toBe(contextPolicy);
    // The gate would have failed on this stub; that it was never called is the
    // bypass working as spelled.
    expect(calls.runSemanticGate).toBe(0);
  });
});
