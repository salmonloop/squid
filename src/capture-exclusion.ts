import type { CapturePolicy } from "./capture-policy.js";
import { RedactingCapturePolicy } from "./capture-policy.js";
import type { ActivityEvent } from "./protocol.js";

/**
 * Resolves `SQUID_EXCLUDE` into a capture policy, failing closed.
 *
 * Unset means redaction only — the current behavior, unchanged. Set means
 * exclusion *on top of* redaction: the returned policy wraps a fresh
 * `RedactingCapturePolicy`, so exclusion can narrow what is captured but never
 * widen it. A malformed list is a configuration error that must refuse to
 * start the run rather than fall back to capturing everything — the one
 * failure this boundary can never take back.
 */
export function resolveCaptureExclusion(
  value: string | undefined,
): CapturePolicy | { readonly configError: string } {
  if (value === undefined) return new RedactingCapturePolicy();
  const parsed = parseExclusionList(value);
  if (typeof parsed === "string") return { configError: parsed };
  return new ExcludingCapturePolicy(parsed, new RedactingCapturePolicy());
}

/**
 * Per-application exclusion, evaluated at the capture boundary.
 *
 * Composition, not replacement: this wraps an inner `CapturePolicy` (in
 * practice `RedactingCapturePolicy`) and only ever narrows — a matched event is
 * dropped outright, so anything that survives still went through the inner
 * policy's redaction. A bypass of redaction cannot appear by construction,
 * because the inner policy sees every event this one does not drop.
 *
 * Matching is on the application **name**. The id is whatever the platform
 * reports it as — on macOS a bare unix pid — and no user can write an exclude
 * rule against a number that changes every launch; the name ("1Password",
 * "Banking") is the field that describes what an application is, which is why
 * admission's coding-application check reads names too.
 *
 * A matched event leaves nothing: not a stub, not a marker. The event *is* the
 * fact that something happened in that application, and the user asked for the
 * application to be absent from history — recording "excluded app X at time T"
 * would recreate the very record being hidden. That cost is deliberate: the
 * timeline shows a plain gap where excluded activity was. Diagnostics name
 * counts only.
 */
export interface ExclusionRule {
  readonly applicationNamePattern: RegExp;
}

/**
 * Parses `SQUID_EXCLUDE` into rules, failing closed.
 *
 * Value shape: comma-separated substrings, matched case-insensitively against
 * the application name — "1password,banking" excludes both. An empty segment
 * (`"a,,b"`, a trailing comma) is a configuration error rather than silently
 * dropped input: a typo'd list must fail startup, because a policy that quietly
 * captures what the user meant to hide is the one failure this boundary can
 * never take back. Whitespace around entries is trimmed.
 */
export function parseExclusionList(value: string): readonly ExclusionRule[] | string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "SQUID_EXCLUDE must name at least one application when set.";
  }
  const names = trimmed.split(",").map((entry) => entry.trim());
  for (const name of names) {
    if (name.length === 0) {
      return "SQUID_EXCLUDE contains an empty entry; name applications as a comma-separated list.";
    }
  }
  return names.map((name) => ({
    // Escaped so a name containing regex syntax matches literally.
    applicationNamePattern: new RegExp(escapeRegExp(name), "iu"),
  }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export class ExcludingCapturePolicy implements CapturePolicy {
  public readonly id: string;

  public constructor(
    private readonly rules: readonly ExclusionRule[],
    private readonly inner: CapturePolicy,
    private readonly onExcluded?: (count: number) => void,
  ) {
    if (rules.length === 0) {
      throw new TypeError("ExcludingCapturePolicy needs at least one exclusion rule.");
    }
    this.id = `excluding(${inner.id})`;
  }

  /**
   * Returns null when the event is excluded — the caller drops it before the
   * store. Returning the event means "keep", already redacted by the inner
   * policy.
   */
  public capture(event: ActivityEvent): ActivityEvent | null {
    const name = applicationNameOf(event);
    if (name !== null && this.rules.some((rule) => rule.applicationNamePattern.test(name))) {
      // Counted, never named: the diagnostic channel must not become a record
      // of exactly what the user asked to hide.
      this.onExcluded?.(1);
      return null;
    }
    return this.inner.capture(event);
  }
}

/**
 * The application a capture decision can even be about. Only events that carry
 * an application identity are excludable; a filesystem save with a null owner
 * belongs to no application and passes through to the inner policy.
 */
function applicationNameOf(event: ActivityEvent): string | null {
  switch (event.kind) {
    case "application_activated":
      return (event.payload as { applicationName: string }).applicationName;
    case "window_changed":
    case "focus_changed": {
      // Neither payload carries a name, only the id. The projection pairs them;
      // capture-time exclusion can only see what the event itself says, so an
      // id-only event is not excludable here — the activated event that named
      // the application is.
      return null;
    }
    default:
      return null;
  }
}
