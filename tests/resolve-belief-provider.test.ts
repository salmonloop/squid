import { describe, expect, it } from "bun:test";
import { resolveBeliefProvider } from "../src/resolve-belief-provider.js";

/**
 * The seam that decides which producer sits behind the belief layer.
 *
 * Strict like every other capability variable, and for a sharper reason: a typo that
 * silently selected the heuristic would leave an operator reading a shadow report of
 * deterministic rules and concluding a model agrees with them everywhere, when in fact
 * it never ran.
 */
describe("resolveBeliefProvider", () => {
  it("defaults to the heuristic when the variable is unset", async () => {
    const resolved = resolveBeliefProvider({ env: {} });
    if ("configError" in resolved) throw new Error(resolved.configError);

    expect(resolved.kind).toBe("heuristic");
    expect((await resolved.createProvider()).name).toBe("heuristic-belief");
  });

  it("accepts the default spelled out", async () => {
    const resolved = resolveBeliefProvider({ env: { SQUID_BELIEF_PROVIDER: "heuristic" } });
    if ("configError" in resolved) throw new Error(resolved.configError);
    expect((await resolved.createProvider()).name).toBe("heuristic-belief");
  });

  it("the heuristic producer declares no availability check", async () => {
    // An in-process producer cannot be unavailable, and a probe that always succeeds
    // would only add a way for the gate to skip — which reads as "not evaluated", the
    // one verdict that must not admit.
    const resolved = resolveBeliefProvider({ env: {} });
    if ("configError" in resolved) throw new Error(resolved.configError);
    const producer = await resolved.createProvider();
    expect(producer.checkAvailability).toBeUndefined();
  });

  it("selects the model-backed producer on request, with its own check", () => {
    const resolved = resolveBeliefProvider({ env: { SQUID_BELIEF_PROVIDER: "pi" } });
    if ("configError" in resolved) throw new Error(resolved.configError);

    expect(resolved.kind).toBe("pi");
    // Reachability is declared on the producer instance, not on this resolution —
    // probing by fresh construction would start a second model runtime. Not invoked;
    // constructing the provider here would also contact nothing until checkAvailability,
    // but the constructor starts a runtime, so the offline suite never builds one.
  });

  it("refuses an unrecognized producer rather than falling back", () => {
    const resolved = resolveBeliefProvider({ env: { SQUID_BELIEF_PROVIDER: "gpt" } });
    expect("configError" in resolved).toBe(true);
    if (!("configError" in resolved)) return;
    expect(resolved.configError).toContain("SQUID_BELIEF_PROVIDER");
  });

  it("refuses an empty value", () => {
    // Unset and empty are different: unset is a default, empty is a variable someone
    // set and got wrong.
    expect("configError" in resolveBeliefProvider({ env: { SQUID_BELIEF_PROVIDER: "" } }))
      .toBe(true);
  });

  it("refuses a value that only differs in case or spacing", () => {
    for (const raw of ["Pi", "PI", " pi", "pi "]) {
      expect("configError" in resolveBeliefProvider({ env: { SQUID_BELIEF_PROVIDER: raw } }))
        .toBe(true);
    }
  });

  it("builds a distinct provider instance per call", async () => {
    // The gate constructs a provider per scenario per replay. Sharing one instance is a
    // caller's decision to make deliberately, not something this seam should force.
    const resolved = resolveBeliefProvider({ env: {} });
    if ("configError" in resolved) throw new Error(resolved.configError);
    expect(await resolved.createProvider()).not.toBe(await resolved.createProvider());
  });
});
