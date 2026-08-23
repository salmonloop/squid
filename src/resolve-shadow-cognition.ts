/**
 * Resolves `SQUID_SHADOW_COGNITION` into whether a run scores the cognition path
 * beside the live one.
 *
 * Shadow mode is the counterpart to the gate, not a substitute for it. A gate
 * scores a fixed corpus; shadow mode scores the user's actual days, which is
 * where the corpus is wrong. What makes it safe to leave on is that the shadow
 * path has no dispatcher and no claimable ledger record — it can be measured
 * without being able to cause anything.
 *
 * Same three outcomes as every other capability variable: unset means off,
 * exactly `on` enables it, and anything else is a startup configuration error
 * rather than a silent fallback. The strictness matters more here than it looks:
 * a typo that quietly disabled shadow mode would leave an operator reading a
 * ledger with no shadow attempts in it and concluding the cognition path agrees
 * with the heuristic everywhere, when in fact it never ran.
 */
export type ShadowCognitionResolution =
  | { readonly enabled: false }
  | { readonly enabled: true }
  | { readonly configError: string };

export interface ResolveShadowCognitionOptions {
  readonly env?: Record<string, string | undefined>;
}

export function resolveShadowCognition(
  options: ResolveShadowCognitionOptions = {},
): ShadowCognitionResolution {
  const raw = (options.env ?? process.env).SQUID_SHADOW_COGNITION;
  if (raw === undefined) return { enabled: false };
  if (raw !== "on") {
    return {
      configError: 'SQUID_SHADOW_COGNITION must be unset (off) or exactly "on".',
    };
  }
  return { enabled: true };
}
