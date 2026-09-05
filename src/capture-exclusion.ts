import type { CapturePolicy } from "./capture-policy.js";
import { RedactingCapturePolicy } from "./capture-policy.js";
import type { ActivityEvent, ActivityKind, ApplicationActivatedPayload } from "./protocol.js";

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
 * The unit of exclusion is the **foreground**, not the single event. Only
 * `application_activated` carries a name; every event that carries the content a
 * user asked to hide — a window title, a focused control's label, a selection —
 * carries an id at most. Judging each event on its own was therefore the leak:
 * excluding "1Password" removed the line saying 1Password came forward and kept
 * every line saying what was inside it. So an activation latches whether the
 * foreground is excluded, and each later event that describes the foreground is
 * dropped until another activation says otherwise. The latch is one per policy
 * rather than one per source: a desktop has a single foreground, and a browser
 * reader reporting a page while a vault is in front is reporting a page nobody
 * is looking at.
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

/**
 * The activity kinds that survive an excluded foreground, because none of them
 * describes it.
 *
 * Stated as what passes rather than what is dropped, so the default for a kind
 * nobody has considered yet is exclusion. That is the same fail-closed posture
 * as the parser above: a future event kind that turns out to observe the
 * foreground must not start leaking an excluded application the day it is added,
 * and the cost of the opposite mistake is a gap in history rather than a
 * disclosure.
 *
 * What earns a place: facts produced by watching a path or a pipe instead of the
 * screen, and the two lifecycle signals whose whole job is to explain a gap.
 * Dropping `capture_gate_changed` in particular would erase the record of *why*
 * the timeline is silent, which is the ambiguity that event exists to remove.
 */
const KINDS_INDEPENDENT_OF_FOREGROUND: ReadonlySet<ActivityKind> = new Set([
  "file_opened",
  "file_saved",
  "terminal_command_completed",
  "idle_state_changed",
  "capture_gate_changed",
]);

export class ExcludingCapturePolicy implements CapturePolicy {
  public readonly id: string;
  /**
   * Whether the last application seen to activate is one the rules exclude.
   *
   * Starts false: a policy that has observed no activation has no grounds to
   * withhold anything, and a source that never reports one (a filesystem
   * watcher on its own) is unaffected by exclusion exactly as before.
   */
  private foregroundExcluded = false;

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
    // An activation is the only event that can change the answer, so the latch
    // moves here — and the activation is then judged by the value it just set,
    // which is what keeps an excluded application's arrival absent too.
    if (event.kind === "application_activated") {
      this.foregroundExcluded = this.excludes(activatedApplicationName(event));
    }
    if (this.foregroundExcluded && !KINDS_INDEPENDENT_OF_FOREGROUND.has(event.kind)) {
      // Counted, never named: the diagnostic channel must not become a record
      // of exactly what the user asked to hide.
      this.onExcluded?.(1);
      return null;
    }
    return this.inner.capture(event);
  }

  private excludes(applicationName: string | null): boolean {
    return applicationName !== null
      && this.rules.some((rule) => rule.applicationNamePattern.test(applicationName));
  }
}

/**
 * The name an activation reports, or null when the event is not an activation.
 *
 * Deliberately the only payload read in this module. Every other kind is judged
 * by the foreground latch rather than by its own fields, because no other kind
 * says which application it belongs to by name — and a policy that guessed from
 * an id would be matching a macOS pid against a rule a person wrote.
 */
function activatedApplicationName(event: ActivityEvent): string | null {
  if (event.kind !== "application_activated") return null;
  const { applicationName } = event.payload as ApplicationActivatedPayload;
  return applicationName.length > 0 ? applicationName : null;
}
