import { sanitizeAuditText } from "./audit-text.js";
import type { WorldState } from "./protocol.js";

/**
 * What the control panel is allowed to see.
 *
 * The panel is a second display for what the sensors just read, which makes this
 * module the same kind of choke point `audit-text.ts` is: everything the panel
 * renders passes through here first, so there is one place to read to know what
 * can leave the process.
 *
 * Pure, like `agent-senses.ts` — projection in, wire objects out, no I/O — so the
 * privacy rules are testable without a socket.
 *
 * Two shape rules come from the Rust parser (`ui/src/protocol.rs`) and are not
 * stylistic. Objects are flat: no nesting, no arrays, because supporting them
 * would grow a second half-tested JSON implementation inside the panel. And an
 * absent field is omitted rather than sent as `null`: "no foreground application
 * observed yet" is a real state the panel renders as `—`, whereas a `null` makes
 * the whole line unparseable and the panel drops it.
 */
export interface PanelWorldState {
  readonly type: "world_state";
  readonly updatedAt: string;
  readonly lastEvent?: string;
  readonly application?: string;
  readonly window?: string;
  readonly gate?: "open" | "paused";
  readonly selectionLength?: number;
  readonly recentActions?: string;
  readonly episodeEvents?: number;
}

export interface PanelAgentLine {
  readonly type: "agent";
  readonly at: string;
  readonly status: "replied" | "failed";
  readonly text?: string;
}

export interface PanelServiceLine {
  readonly type: "service";
  readonly agentState: "ready" | "needs_config";
}

export type PanelMessage = PanelWorldState | PanelAgentLine | PanelServiceLine;

/**
 * Projects the world state into the panel's view of it.
 *
 * Returns `null` when the projection has no `updatedAt`: nothing has been
 * observed yet, and stamping the message with `now` would misdate the first
 * observation — the panel would show a reading that never happened.
 *
 * Reads the projection only, never a raw event payload. The projection is built
 * from the captured event, so whatever the capture policy redacted stays
 * redacted; an application excluded by `SQUID_EXCLUDE` never reached history and
 * so can never reach the panel.
 */
export function panelWorldState(state: WorldState): PanelWorldState | null {
  if (state.updatedAt === null) return null;

  return {
    type: "world_state",
    updatedAt: state.updatedAt,
    ...(state.lastEventKind === null ? {} : { lastEvent: state.lastEventKind }),
    // The application *name*, not its id. The id is a bundle identifier the
    // panel has no use for, and it is the more machine-identifying of the two.
    ...(state.activeApplication === null ? {} : { application: state.activeApplication.name }),
    // A window title is untrusted prose that routinely holds a path or a
    // credential, so it goes through the same sanitizer as any diagnostic.
    ...(state.activeWindow === null
      ? {}
      : { window: sanitizeAuditText(state.activeWindow.title, "diagnostic").text }),
    ...(state.captureGate === null ? {} : { gate: state.captureGate.paused ? "paused" : "open" }),
    // The selection's *length*, never the selection. `sanitizeAuditText(…,
    // "selection")` returns a `MeasuredAuditText`, which has no `text` field by
    // design: the selection is the one piece of text that needs explicit consent
    // to leave the machine, so reaching for a preview fails to compile.
    ...(state.textContext === null
      ? {}
      : {
          selectionLength: sanitizeAuditText(state.textContext.selection, "selection")
            .originalLength,
        }),
    ...(state.recentActions.length === 0 ? {} : { recentActions: joinActionKinds(state) }),
    ...(state.episode === null ? {} : { episodeEvents: state.episode.eventCount }),
  };
}

/**
 * The projection keeps recent actions newest-first (`world-state.ts` prepends);
 * the wire wants newest-last so the panel reads them in the order they happened.
 * Joined with `;` into one string rather than sent as an array, deliberately, to
 * keep the Rust parser flat — do not "improve" this into a JSON array.
 */
function joinActionKinds(state: WorldState): string {
  return [...state.recentActions]
    .reverse()
    .map((action) => action.kind)
    .join(";");
}

/**
 * Announces the end of an agent turn.
 *
 * `at` is a parameter rather than always `now` so a caller replaying a recorded
 * turn reports when it happened, not when it was replayed.
 */
export function panelAgentLine(input: {
  readonly status: "replied" | "failed";
  readonly text?: string;
  readonly at?: string;
}): PanelAgentLine {
  return {
    type: "agent",
    at: input.at ?? new Date().toISOString(),
    status: input.status,
    // Assistant text and error messages are both model- or machine-authored
    // prose that can quote what the sensors read, so both take the rationale
    // sanitizer: control characters stripped, credentials redacted, length
    // capped. An empty string is still a real answer, so only `undefined` omits.
    ...(input.text === undefined
      ? {}
      : { text: sanitizeAuditText(input.text, "rationale").text }),
  };
}

/**
 * The brain's own state line, announced to every panel as it connects.
 *
 * This is not an event — it is a standing fact, and the wire treats it like one:
 * the session re-sends it on each connect rather than broadcasting it once at
 * startup, because broadcast is a one-shot pass over whoever is registered at
 * that moment and the panel connects after the session, not before. A panel that
 * never hears this line infers nothing; `agentState: "needs_config"` is the
 * signal that the session is running headless-配置-less and the settings form is
 * the way out.
 */
export function panelServiceLine(input: {
  readonly agentState: "ready" | "needs_config";
}): PanelServiceLine {
  return { type: "service", agentState: input.agentState };
}

/**
 * Frames one message for the wire: a single JSON object, newline-terminated.
 * The only sanctioned framing. `JSON.stringify` drops `undefined`-valued keys,
 * but the builders above never create them in the first place — the omission is
 * intentional and tested, not a side effect of the serializer we happen to use.
 */
export function panelLine(message: PanelMessage): string {
  return `${JSON.stringify(message)}\n`;
}
