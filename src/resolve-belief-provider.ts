import type { BeliefProvider } from "./belief-provider.js";

/**
 * Resolves `SQUID_BELIEF_PROVIDER` into which producer sits behind the belief seam.
 *
 * Off by default like every other capability, and for a sharper reason than most: the
 * model-backed producer cannot repeat itself. A hosted endpoint is nondeterministic
 * because of the serving kernels rather than the caller, so a run gets a model belief
 * layer only by asking for one, and the default stays the deterministic rules that
 * `runSemanticGate` can actually admit.
 *
 * Same three outcomes as the other resolvers: unset means the heuristic, an exact
 * recognized value selects a producer, and anything else is a startup configuration
 * error rather than a silent fallback. The strictness earns its keep here — a typo that
 * quietly selected the heuristic would leave an operator reading a shadow report of
 * deterministic rules and concluding the model agrees with them everywhere, when in
 * fact it never ran.
 *
 * `createProvider` is async and the pi module graph is imported inside its branch only.
 * Loading it costs real startup time the default path has no reason to pay, and a static
 * import would make "the default touches no model" true of execution but not of startup.
 */
export type BeliefProviderKind = "heuristic" | "pi";

export type BeliefProviderResolution =
  | {
    readonly kind: BeliefProviderKind;
    /** Built on demand. Call once per provider instance the caller needs. */
    readonly createProvider: () => Promise<BeliefProvider>;
    /**
     * Reports whether the producer's model is reachable, or null when reachability is
     * not a question worth asking. The heuristic is in-process and cannot be
     * unavailable, so it answers null rather than supplying a probe that always
     * succeeds — a probe that cannot fail only adds a way for a gate to skip, which
     * reads as "not evaluated", the one verdict that must not admit.
     */
    readonly probeAvailability: (() => Promise<string | null>) | null;
  }
  | { readonly configError: string };

export interface ResolveBeliefProviderOptions {
  readonly env?: Record<string, string | undefined>;
}

export function resolveBeliefProvider(
  options: ResolveBeliefProviderOptions = {},
): BeliefProviderResolution {
  const raw = (options.env ?? process.env).SQUID_BELIEF_PROVIDER;
  if (raw === undefined || raw === "heuristic") {
    return {
      kind: "heuristic",
      createProvider: async () => {
        const { HeuristicBeliefProvider } = await import("./heuristic-belief-provider.js");
        return new HeuristicBeliefProvider();
      },
      probeAvailability: null,
    };
  }
  if (raw !== "pi") {
    return {
      configError: 'SQUID_BELIEF_PROVIDER must be unset (heuristic), "heuristic", or "pi".',
    };
  }

  return {
    kind: "pi",
    createProvider: async () => {
      const { PiBeliefProvider } = await import("./pi-belief-provider.js");
      return new PiBeliefProvider();
    },
    // Resolved once up front by the caller, so an outage declines with a stated reason
    // instead of surfacing as a refused batch on every event.
    probeAvailability: async () => {
      const { PiBeliefProvider } = await import("./pi-belief-provider.js");
      return new PiBeliefProvider().checkAvailability();
    },
  };
}
