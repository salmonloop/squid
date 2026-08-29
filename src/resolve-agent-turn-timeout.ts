/**
 * Resolves `SQUID_AGENT_TURN_TIMEOUT_MS` into the turn watchdog's bound.
 *
 * The watchdog exists because the live E2E caught a model that never settles:
 * one turn spent its whole life calling a tool in a loop, `waitForIdle` never
 * returned, the serialized turn chain wedged behind it, and the closed loop
 * died with events still arriving. A bound turns that wedge into one failed
 * turn — the loop's own philosophy already holds that a turn which fails must
 * advance the tail, so the next observation gets a fresh attempt.
 *
 * Unset means the default bound, not off: a watchdog that only exists when
 * someone remembers to ask for it is not a watchdog. The default is generous
 * because a legitimate tool-using turn can take minutes; the failure this
 * guards is the turn that never ends, not the one that is slow. Zero and
 * negative values are refused — "no bound" is spelled by leaving the variable
 * unset, and a caller who wrote 0 meant something else than infinity.
 *
 * The shape deliberately mirrors `resolveRetention`: unset means the default,
 * a valid value means the stated bound, malformed is a startup configuration
 * error rather than a silent fallback.
 */
export type AgentTurnTimeoutResolution =
  | { readonly timeoutMs: number }
  | { readonly configError: string };

export function resolveAgentTurnTimeout(
  env: Record<string, string | undefined> = process.env,
): AgentTurnTimeoutResolution {
  const raw = env.SQUID_AGENT_TURN_TIMEOUT_MS;
  const bound = raw === undefined || raw.length === 0
    ? String(DEFAULT_AGENT_TURN_TIMEOUT_MS)
    : raw;
  // Strict spelling, not Number(): the latter accepts "1e3", " 5000", "0x14" —
  // spellings a user did not type.
  if (!/^\d+$/.test(bound)) {
    return { configError: "SQUID_AGENT_TURN_TIMEOUT_MS must be a positive integer number of milliseconds." };
  }
  const timeoutMs = Number(bound);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return { configError: "SQUID_AGENT_TURN_TIMEOUT_MS must be a positive integer number of milliseconds." };
  }
  return { timeoutMs };
}

/**
 * Ten minutes: slower than any turn a working model produces even with tools,
 * short enough that a wedged one costs the session minutes rather than days.
 */
export const DEFAULT_AGENT_TURN_TIMEOUT_MS = 600_000;
