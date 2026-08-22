import type { WorldState } from "./protocol.js";
import { cloneWorldState } from "./world-state.js";

/**
 * Projects world state into the view a prediction provider is allowed to see.
 *
 * This is an egress boundary, not a storage rule: the event store and the
 * ledger keep full fidelity, and the local heuristic fallback keeps reading raw
 * state. Only what crosses into an out-of-process provider passes through here.
 */
export interface ContextPolicy {
  readonly id: string;
  project(state: WorldState): WorldState;
}

/**
 * Sends state through unchanged. This is the coordinator default so that
 * attaching a provider never silently changes what it already received;
 * choosing a policy is an explicit decision at the call site.
 */
export class PassthroughContextPolicy implements ContextPolicy {
  public readonly id = "passthrough";

  public project(state: WorldState): WorldState {
    return cloneWorldState(state);
  }
}

/**
 * Fields the redacting policy narrows. Naming them makes an allow-list entry a
 * compile-time choice rather than a string that can quietly stop matching.
 */
export type RedactableContextField =
  | "windowTitle"
  | "browserUrl"
  | "filePaths"
  | "focusText"
  | "actionTargets";

export interface RedactingContextPolicyOptions {
  /** Fields to send unredacted. Everything else is narrowed. */
  readonly allow?: readonly RedactableContextField[];
  /** Max characters kept from each focus text field. Default 512. */
  readonly maxTextLength?: number;
}

const REDACTED = "[redacted]";

/**
 * Narrows the fields that carry raw user content while keeping the structured
 * signal a predictor actually reasons over.
 *
 * The distinction throughout is content vs. shape. A window title is content
 * and is dropped; the fact that a window is focused is shape and is kept. A URL
 * query string can carry a session token and is dropped; the origin and path
 * identify the page and are kept. Focus text is the entire input to a
 * completion, so it is capped rather than removed — and capped from the cursor
 * outward, because the characters nearest the caret are the ones that matter.
 */
export class RedactingContextPolicy implements ContextPolicy {
  public readonly id = "redacting";
  private readonly allow: ReadonlySet<RedactableContextField>;
  private readonly maxTextLength: number;

  public constructor(options: RedactingContextPolicyOptions = {}) {
    this.allow = new Set(options.allow ?? []);
    this.maxTextLength = options.maxTextLength ?? 512;
  }

  public project(state: WorldState): WorldState {
    const projected = cloneWorldState(state);

    if (!this.allow.has("windowTitle")) {
      if (projected.activeWindow !== null) {
        projected.activeWindow.title = REDACTED;
      }
      if (projected.focus !== null) {
        projected.focus.windowTitle = REDACTED;
      }
      if (projected.textContext?.owner !== null && projected.textContext?.owner !== undefined) {
        projected.textContext.owner.windowTitle = REDACTED;
      }
      if (projected.currentBrowserPage?.owner !== null && projected.currentBrowserPage?.owner !== undefined) {
        projected.currentBrowserPage.owner.windowTitle = REDACTED;
      }
    }

    if (!this.allow.has("browserUrl") && projected.currentBrowserPage !== null) {
      const page = projected.currentBrowserPage;
      page.url = stripUrlSecrets(page.url, page.host);
      page.title = REDACTED;
    }

    if (!this.allow.has("filePaths")) {
      projected.recentFiles = projected.recentFiles.map(basename);
    }

    if (!this.allow.has("focusText")) {
      if (projected.focus !== null) {
        projected.focus.label = REDACTED;
      }
      const textContext = projected.textContext;
      if (textContext !== null) {
        // Keep the end of the prefix and the start of the suffix: those bracket
        // the cursor, which is where a completion is generated.
        textContext.prefix = keepTail(textContext.prefix, this.maxTextLength);
        textContext.suffix = keepHead(textContext.suffix, this.maxTextLength);
        textContext.selection = keepHead(textContext.selection, this.maxTextLength);
      }
    }

    if (!this.allow.has("actionTargets")) {
      projected.recentActions = projected.recentActions.map((action) =>
        action.target === null ? action : { ...action, target: basename(action.target) },
      );
    }

    return projected;
  }
}

/**
 * Drops the query string and fragment, which is where credentials and session
 * tokens ride, and userinfo along with them.
 *
 * Only `http`/`https` keep a path. Other schemes are parseable but put their
 * payload where a path would be — `data:` inlines the document, `blob:` carries
 * an opaque capability token, `file:` an absolute local path — so keeping their
 * "path" would leak exactly what this policy exists to withhold. Anything that
 * is not a recognized web page degrades to the already-structured host, which
 * is also the fallback for a value that does not parse at all.
 */
function stripUrlSecrets(url: string, host: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return host;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return host;
  }
}

/** Last path segment, preserving both separator conventions. */
function basename(path: string): string {
  const segments = path.split(/[/\\]/);
  return segments[segments.length - 1] ?? path;
}

function keepTail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

function keepHead(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}
