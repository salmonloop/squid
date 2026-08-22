import {
  parseActivityEvent,
  type ActivityEvent,
  type BrowserNavigatedPayload,
  type FocusChangedPayload,
  type TextContextChangedPayload,
  type WindowChangedPayload,
} from "./protocol.js";

/**
 * Ingress boundary for activity events, symmetric to `ContextPolicy` on the
 * egress side but narrower by default.
 *
 * `ContextPolicy` is reversible: the store keeps full fidelity and only the
 * projection sent to a provider is narrowed. Capture is not reversible — once an
 * event is ingested it is history, so a credential that crossed this boundary is
 * on disk for good. That asymmetry is why a capture policy redacts content a
 * context policy would merely narrow: there is no "un-redact later" once the
 * bytes are written.
 *
 * A policy never drops an event. The structural fact — that something of this
 * kind happened, when, from which source — is always preserved, so a replay
 * sees a complete timeline with no gaps. Only the credential-bearing content is
 * replaced.
 */
export interface CapturePolicy {
  readonly id: string;
  /**
   * Returns the event to ingest. Credential content is replaced with
   * `"[redacted]"` and the event is marked `redacted: true` so a replay can tell
   * a filtered value apart from a literal one. An event with no detected
   * credential content is returned unchanged (a clone, never the input by
   * reference).
   */
  capture(event: ActivityEvent): ActivityEvent;
}

const REDACTED = "[redacted]";

/**
 * Placeholder for a redacted URL. The `url` field carries a `format: "uri"`
 * constraint, so the plain `"[redacted]"` sentinel would fail schema validation
 * — capture must never produce an event `core.ingest` would reject. The
 * `.invalid` TLD (RFC 2606) is reserved so the placeholder can never resolve
 * to a real host, keeping it distinct from a genuine leaked URL.
 */
const REDACTED_URL = "https://redacted.invalid/";

/**
 * Passes events through unchanged. This is the runtime default so that wiring a
 * policy in never silently narrows what was already being captured; choosing to
 * filter is an explicit decision at the call site (e.g. the durable watch path
 * opts in, a test does not).
 */
export class PassthroughCapturePolicy implements CapturePolicy {
  public readonly id = "passthrough";

  public capture(event: ActivityEvent): ActivityEvent {
    return structuredClone(event);
  }
}

/**
 * Credential patterns that trigger redaction. Kept deliberately small and
 * high-confidence: a false positive removes real content for no safety gain, so
 * the list is the unambiguous markers of a secret rather than every conceivable
 * shape of one. A value is caught when any entry appears as a case-insensitive
 * substring.
 *
 * The entries split into three families:
 *  - words naming a secret field (`password`, `token`, …) — an editor buffer or
 *    window title that quotes one is almost certainly showing a credential;
 *  - PEM and provider-token prefixes (`-----BEGIN`, `AKIA`, `ghp_`, `gho_`,
 *    `Bearer `) — these match the literal start of a leaked key, so a hit is a
 *    key, not a coincidence.
 */
const CREDENTIAL_PATTERNS = [
  "password",
  "passwd",
  "secret",
  "api_key",
  "apikey",
  "token",
  "credential",
  "private_key",
  "-----begin",
  "akia",
  "ghp_",
  "gho_",
  "bearer ",
];

function looksLikeCredential(value: string): boolean {
  const lower = value.toLowerCase();
  return CREDENTIAL_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Redacts credential-bearing content fields before an event is ingested.
 *
 * Detection is per field: only a field that itself matches a credential pattern
 * is redacted, so an editor buffer whose `prefix` quotes a password but whose
 * `suffix` does not keeps the `suffix`. When any field on an event is redacted
 * the whole event is marked `redacted: true` — the marker says "this event was
 * filtered", not "this specific field was", which is the granularity a replay
 * needs to distinguish a stored `"[redacted]"` from a literal one.
 *
 * `FilePayload.path` is not touched. A path is structural, not credential
 * content (a file named `password.env` is not itself a secret), and the egress
 * policy treats paths the same way — keeping capture and egress aligned here
 * means the two boundaries never disagree about what a path is.
 */
export class RedactingCapturePolicy implements CapturePolicy {
  public readonly id = "redacting";

  public capture(event: ActivityEvent): ActivityEvent {
    const redactedPayload = this.redactPayload(event);
    if (redactedPayload === undefined) {
      return structuredClone(event);
    }
    // Build a fresh event rather than mutate the clone: `redacted` is readonly,
    // so the marker can only be set at construction. Re-validating through
    // `parseActivityEvent` keeps the same invariant `createActivityEvent`
    // upholds — a redacted event is never structurally invalid just because it
    // was filtered.
    return parseActivityEvent({
      ...event,
      payload: redactedPayload,
      redacted: true,
    });
  }

  /**
   * Every kind is listed explicitly rather than falling through a `default`, so
   * adding a kind to `activityKinds` fails to compile here until someone decides
   * whether its payload carries credential content. A silent `default` would let
   * a new free-text field reach the irreversible boundary unredacted.
   */
  private redactPayload(event: ActivityEvent): unknown {
    switch (event.kind) {
      case "window_changed":
        return this.redactWindow(event.payload as WindowChangedPayload);
      case "focus_changed":
        return this.redactFocus(event.payload as FocusChangedPayload);
      case "text_context_changed":
        return this.redactText(event.payload as TextContextChangedPayload);
      case "browser_navigated":
        return this.redactBrowser(event.payload as BrowserNavigatedPayload);
      // Structural only — no free-text content field a credential could ride in.
      // `file_opened`/`file_saved` paths are deliberately kept; see the class doc.
      case "application_activated":
      case "pointer_action":
      case "keyboard_action":
      case "clipboard_changed":
      case "dom_changed":
      case "file_opened":
      case "file_saved":
      case "terminal_command_completed":
      case "screen_keyframe_created":
      case "idle_state_changed":
        return undefined;
      default:
        return assertKindHandled(event.kind);
    }
  }

  private redactWindow(payload: WindowChangedPayload): WindowChangedPayload | undefined {
    if (!looksLikeCredential(payload.title)) return undefined;
    return { ...payload, title: REDACTED };
  }

  private redactFocus(payload: FocusChangedPayload): FocusChangedPayload | undefined {
    let changed = false;
    const result: FocusChangedPayload = { ...payload };
    if (looksLikeCredential(payload.windowTitle)) {
      result.windowTitle = REDACTED;
      changed = true;
    }
    if (payload.label !== null && looksLikeCredential(payload.label)) {
      result.label = REDACTED;
      changed = true;
    }
    return changed ? result : undefined;
  }

  private redactText(payload: TextContextChangedPayload): TextContextChangedPayload | undefined {
    let changed = false;
    const result: TextContextChangedPayload = { ...payload };
    if (looksLikeCredential(payload.prefix)) {
      result.prefix = REDACTED;
      changed = true;
    }
    if (looksLikeCredential(payload.suffix)) {
      result.suffix = REDACTED;
      changed = true;
    }
    if (looksLikeCredential(payload.selection)) {
      result.selection = REDACTED;
      changed = true;
    }
    return changed ? result : undefined;
  }

  private redactBrowser(payload: BrowserNavigatedPayload): BrowserNavigatedPayload | undefined {
    let changed = false;
    const result: BrowserNavigatedPayload = { ...payload };
    // The whole URL is redacted rather than only its query string: a token in a
    // URL can land in the path or fragment as well, and parsing to keep the
    // origin would be the egress policy's job — capture is the stricter
    // boundary that errs on the side of nothing.
    if (looksLikeCredential(payload.url)) {
      result.url = REDACTED_URL;
      changed = true;
    }
    // A page title is free text of the same class as a window title — a tab
    // named "token ghp_…" or "password vault" would otherwise reach the
    // store verbatim. Egress redacts the page title, so capture must too, or
    // egress would be withholding what the irreversible boundary already
    // wrote to disk.
    if (looksLikeCredential(payload.title)) {
      result.title = REDACTED;
      changed = true;
    }
    if (payload.owner !== undefined && payload.owner !== null && looksLikeCredential(payload.owner.windowTitle)) {
      result.owner = { ...payload.owner, windowTitle: REDACTED };
      changed = true;
    }
    // `host` is a domain — structural, not credential content — so it stays,
    // the same way `applicationId` does everywhere else.
    return changed ? result : undefined;
  }
}

/**
 * Compile-time exhaustiveness guard for `redactPayload`. Reachable only if a new
 * `ActivityKind` was added without deciding how capture treats its payload; the
 * `never` parameter makes that a type error at the call site.
 */
function assertKindHandled(kind: never): never {
  throw new Error(`Capture policy has no redaction decision for activity kind ${String(kind)}.`);
}
