/**
 * Resolves `SQUID_ATTENTION_WINDOW_MINUTES` into the resident agent's attention
 * window, failing closed.
 *
 * The agent sees one breadcrumb per observed event, and the store keeps every
 * one of them forever. This bound is the view onto that store, not the store
 * itself: it decides how far back in time the breadcrumbs the *model* reads
 * reach, while capture stays whole. That is the same posture the decision
 * curator has — narrow what the model sees, never what was recorded — except
 * this one is a wall-clock cut rather than a model's judgement, so it holds
 * even when no decision endpoint is reachable and no assistant turn has yet
 * reported a token count.
 *
 * Unlike retention, unset does **not** mean off: an unbounded view is the exact
 * failure this exists to prevent (a session that grows a breadcrumb per event
 * until the request no longer fits any window), so a run that configures
 * nothing still gets the default bound. A value means the stated bound; anything
 * malformed is a startup configuration error rather than a silent fallback,
 * mirroring `resolveRetention`.
 *
 * Whole minutes because that is the unit a person reasons about an attention
 * span in ("the last quarter hour" = 15), the same reason retention is whole
 * hours; the extension converts to milliseconds once, here.
 */
export type AttentionWindowResolution =
  | { readonly minutes: number; readonly windowMs: number }
  | { readonly configError: string };

export interface ResolveAttentionWindowOptions {
  readonly env?: Record<string, string | undefined>;
}

export function resolveAttentionWindow(
  options: ResolveAttentionWindowOptions = {},
): AttentionWindowResolution {
  const raw = (options.env ?? process.env).SQUID_ATTENTION_WINDOW_MINUTES;
  // Unset is the default bound, not off: see the module comment. Every other
  // spelling — including the empty string an exported-but-blank variable
  // carries — is judged, because "" is a value the env layer passes verbatim,
  // not the absence the config file writes for an empty field.
  if (raw === undefined) {
    return { minutes: DEFAULT_ATTENTION_WINDOW_MINUTES, windowMs: DEFAULT_ATTENTION_WINDOW_MINUTES * MINUTE_MS };
  }
  // Strict spelling, not Number(): the latter accepts "1e3", " 15", "0x0f" —
  // spellings a user did not type. A window that silently means something else
  // than what was written is worse than refusing it at startup.
  if (!/^\d+$/.test(raw)) {
    return { configError: "SQUID_ATTENTION_WINDOW_MINUTES must be a positive integer number of minutes." };
  }
  const minutes = Number(raw);
  if (!Number.isSafeInteger(minutes) || minutes <= 0) {
    return { configError: "SQUID_ATTENTION_WINDOW_MINUTES must be a positive integer number of minutes." };
  }
  return { minutes, windowMs: minutes * MINUTE_MS };
}

export const MINUTE_MS = 60_000;

/**
 * Fifteen minutes: long enough to cover the working episode the agent is
 * reasoning about (episodes segment on a five-minute gap, so this spans several)
 * and short enough that even a busy tree's breadcrumbs stay a few hundred
 * messages rather than the hundreds of thousands an unbounded view accrues. The
 * current world is injected fresh on every call regardless, so a window this
 * size bounds the *history* the agent carries, never its view of now.
 */
export const DEFAULT_ATTENTION_WINDOW_MINUTES = 15;
