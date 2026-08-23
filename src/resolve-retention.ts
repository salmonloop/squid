/**
 * Resolves `SQUID_RETENTION_HOURS` into a retention bound, failing closed.
 *
 * Retention is the third capture-policy control, after exclusion and pause:
 * exclusion keeps an application out of the timeline going forward, pause
 * marks a deliberate gap, and retention bounds how long anything stays. All
 * three share one posture — unset means off (capture exactly as before), a
 * valid value means the stated bound, and anything malformed is a startup
 * configuration error rather than a silent fallback. A policy that quietly
 * keeps history the user asked to delete is the one failure this boundary
 * cannot take back.
 *
 * The value is whole hours because that is what a user types ("keep three
 * days" = 72), not milliseconds; sub-hour bounds are not offered because
 * nothing in this system needs them and a smaller unit invites typos that
 * parse to something surprising.
 */
export type RetentionResolution =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly hours: number }
  | { readonly configError: string };

export interface ResolveRetentionOptions {
  readonly env?: Record<string, string | undefined>;
}

export function resolveRetention(
  options: ResolveRetentionOptions = {},
): RetentionResolution {
  const raw = (options.env ?? process.env).SQUID_RETENTION_HOURS;
  if (raw === undefined) return { enabled: false };
  if (raw.length === 0) {
    return { configError: "SQUID_RETENTION_HOURS must be a positive integer number of hours." };
  }
  // Strict spelling, not Number(): the latter accepts "1e3", " 24", "0x18" —
  // spellings a user did not type. A retention bound that silently means
  // something else than what was written is worse than refusing.
  if (!/^\d+$/.test(raw)) {
    return { configError: "SQUID_RETENTION_HOURS must be a positive integer number of hours." };
  }
  const hours = Number(raw);
  if (!Number.isSafeInteger(hours) || hours <= 0) {
    return { configError: "SQUID_RETENTION_HOURS must be a positive integer number of hours." };
  }
  return { enabled: true, hours };
}

/**
 * The epoch-millisecond cutoff for events at or before `nowMs - hours`.
 *
 * Pure arithmetic so the boundary is testable without a clock. Deletion is
 * inclusive of the cutoff on both ends downstream (`deleteRange` semantics),
 * which is also why the bound is expressed as "events strictly older than
 * this instant go": `nowMs - hours * HOUR_MS` is the youngest event retained,
 * and everything at or below it is deleted by the caller's range.
 */
export const HOUR_MS = 3_600_000;

export function retentionCutoffMs(hours: number, nowMs: number): number {
  return nowMs - hours * HOUR_MS;
}
