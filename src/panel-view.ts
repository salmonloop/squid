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

export interface PanelConfirmationPrompt {
  readonly type: "prompt";
  readonly promptId: number;
  readonly kind: string;
  readonly summary: string;
  readonly why: string;
  readonly denyConsequence: string;
  readonly expiresAt: string;
}

export interface PanelConfirmationCancel {
  readonly type: "cancel";
  readonly promptId: number;
}

export interface PanelServiceLine {
  readonly type: "service";
  readonly agentState: "ready" | "needs_config";
}

export interface PanelAgentThinking {
  readonly type: "agent_thinking";
  readonly thinking: 0 | 1;
}

/**
 * Announces that the resident agent started or finished thinking — the one
 * fact this line carries. `thinking: 1` when a turn opens, `0` when it closes.
 *
 * The word is deliberate: this is not "working" or "busy", because the panel
 * has no basis for those claims — a turn may be a long read that acts on
 * nothing, and the answer to "is it doing anything" belongs to the agent line
 * that follows. What this line answers is the narrower question it can answer
 * truthfully: is a thought in progress right now.
 *
 * Reuses Pi's own `turn_start`/`turn_end` events via `heartbeatExtension`;
 * the count and the watchdog know things this boolean does not, but for the
 * question "is it alive" the turn's own edges are the most honest source.
 */
export function panelAgentThinking(thinking: boolean): PanelAgentThinking {
  return { type: "agent_thinking", thinking: thinking ? 1 : 0 };
}

/** The kinds a settings form can render; `secret` renders masked and never echoes. */
export type PanelConfigKind = "text" | "int" | "enum" | "secret";

/**
 * One settings entry as the form needs it, structurally what `config-service`
 * dumps. Declared here rather than imported so this module keeps its two
 * dependencies (sanitizer, projection type) and stays pure.
 *
 * `group` and `description` are optional here while the dump makes them
 * required, and the asymmetry is deliberate: the dump is the one producer that
 * must always have decided them, whereas this builder is written against the
 * *wire* contract, where an absent field is a legal state a receiver has to
 * survive. A test replaying an older entry, or a caller that has only the five
 * fields a row needs to be editable, still gets a wire-legal line out.
 */
export interface PanelConfigEntryInput {
  readonly id: string;
  readonly label: string;
  readonly kind: PanelConfigKind;
  readonly value: string;
  readonly applies: "now" | "restart";
  readonly overridden: boolean;
  readonly values?: readonly string[];
  readonly group?: string;
  readonly description?: string;
  readonly secretPresent?: boolean;
}

export interface PanelConfigLine {
  readonly type: "config";
  readonly id: string;
  readonly label: string;
  readonly kind: PanelConfigKind;
  readonly value: string;
  readonly applies: "now" | "restart";
  readonly overridden?: 0 | 1;
  readonly values?: string;
  /**
   * Display metadata: the capability heading this row belongs under, and one
   * sentence about it. Scalars on the same flat line as everything else — the
   * grouping the panel draws is bucketed from these strings, never sent as a
   * nested shape, because a tree here would mean growing the hand parser a
   * second half-tested JSON implementation for no rendering it cannot already
   * do. Optional so an older brain's dump still parses: the Rust side reads
   * them with the same tolerant helper as every other optional text field, so
   * their absence costs a heading, never the row.
   */
  readonly group?: string;
  readonly description?: string;
  /**
   * A credential is stored behind an always-empty `secret` field. `1` only,
   * omitted otherwise, exactly like `overridden` — a disclosure spelled the way
   * the wire already spells disclosures, and the narrowest thing that can be
   * said about a stored key without saying any of it.
   */
  readonly secretPresent?: 0 | 1;
}

export interface PanelConfigEnd {
  readonly type: "config_end";
  readonly count: number;
}

export interface PanelConfigResult {
  readonly type: "config_result";
  readonly id?: string;
  readonly requestId?: string;
  readonly ok: 0 | 1;
  readonly applies?: "now" | "restart";
  readonly error?: string;
}

export interface PanelSourceLine {
  readonly type: "source";
  readonly id: string;
  readonly label: string;
  readonly state: "running" | "stopped" | "unsupported";
  /** The newest diagnostic a running source has recorded, when it has one. */
  readonly detail?: string;
}

/**
 * Why a source is in the state it is, and what would repair it.
 *
 * V2 only, and `repair` is the reason: it is a nested object, which the flat
 * `source` line cannot carry — the hand parser drops a whole line containing one
 * rather than ignoring the field. So this shape never appears on `PanelSourceLine`,
 * and a builder for the flat line does not accept it. Accepting an input and
 * discarding it is worse than refusing it, because the caller is told nothing.
 */
export interface PanelSourceDetail {
  readonly id: string;
  readonly label: string;
  readonly state: "running" | "stopped" | "unsupported";
  readonly reason?: string;
  readonly repair?: { readonly configId?: string; readonly label?: string };
}

export interface PanelSourceEnd {
  readonly type: "source_end";
  readonly count: number;
}

export interface PanelSourceResult {
  readonly type: "source_result";
  readonly id?: string;
  readonly requestId?: string;
  readonly ok: 0 | 1;
  readonly error?: string;
}

export type PanelMessage =
  | PanelWorldState
  | PanelAgentLine
  | PanelServiceLine
  | PanelAgentThinking
  | PanelConfirmationPrompt
  | PanelConfirmationCancel
  | PanelConfigLine
  | PanelConfigEnd
  | PanelConfigResult
  | PanelSourceLine
  | PanelSourceEnd
  | PanelSourceResult;

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
 * Builds the deliberately payload-free confirmation prompt for the panel.
 * The request type has no arguments or selection fields; sanitization prevents
 * untrusted prose from smuggling controls or credentials over the flat wire.
 */
export function panelConfirmationPrompt(input: Omit<PanelConfirmationPrompt, "type">): PanelConfirmationPrompt {
  return {
    type: "prompt",
    promptId: input.promptId,
    kind: sanitizeAuditText(input.kind, "diagnostic").text,
    summary: sanitizeAuditText(input.summary, "diagnostic").text,
    why: sanitizeAuditText(input.why, "diagnostic").text,
    denyConsequence: sanitizeAuditText(input.denyConsequence, "diagnostic").text,
    expiresAt: input.expiresAt,
  };
}

export function panelConfirmationCancel(promptId: number): PanelConfirmationCancel {
  return { type: "cancel", promptId };
}

/**
 * The brain's own state line, announced to every panel as it connects.
 *
 * This is not an event — it is a standing fact, and the wire treats it like one:
 * the session re-sends it on each connect rather than broadcasting it once at
 * startup, because broadcast is a one-shot pass over whoever is registered at
 * that moment and the panel connects after the session, not before. A panel that
 * never hears this line infers nothing; `agentState: "needs_config"` is the
 * signal that the session is running configuration-less and the settings form is
 * the way out.
 */
export function panelServiceLine(input: {
  readonly agentState: "ready" | "needs_config";
}): PanelServiceLine {
  return { type: "service", agentState: input.agentState };
}

/**
 * One settings row for the form. Sanitizes id, label, and value as diagnostics,
 * which is what makes this line wire-legal even when the value came from a file
 * the user hand-edited. The secret's value is already empty upstream — the dump
 * structurally never carries one — so sanitizing it is a no-op kept for
 * uniformity: one rule for every value that rides the wire.
 *
 * `overridden` is the env-wins disclosure, sent only when true so the flat line
 * stays minimal. `values` (enum choices) joins with `;` like every list here.
 *
 * `group` and `description` are display text and take the same sanitizer as the
 * label, on the same grounds: both are authored strings today, and a choke point
 * that trusted *some* of its display fields would be one edit away from carrying
 * a control character onto a line the panel parses by hand. They are omitted
 * when absent rather than sent as `""`, because empty is a value the panel would
 * have to render — a heading with no name — while absence is the state it already
 * knows how to skip.
 *
 * `secretPresent` is the one field here that is a claim rather than a rendering:
 * it says a credential is stored, so the form can distinguish an empty field
 * that may be left alone from one that must be filled. It carries no part of the
 * key, which is why it is a flag and not text — there is no string here for a
 * sanitizer to have missed.
 */
export function panelConfigLine(entry: PanelConfigEntryInput): PanelConfigLine {
  return {
    type: "config",
    id: sanitizeAuditText(entry.id, "diagnostic").text,
    label: sanitizeAuditText(entry.label, "diagnostic").text,
    kind: entry.kind,
    value: sanitizeAuditText(entry.value, "diagnostic").text,
    applies: entry.applies,
    ...(entry.overridden ? { overridden: 1 } : {}),
    ...(entry.values === undefined ? {} : { values: entry.values.join(";") }),
    ...(entry.group === undefined
      ? {}
      : { group: sanitizeAuditText(entry.group, "diagnostic").text }),
    ...(entry.description === undefined
      ? {}
      : { description: sanitizeAuditText(entry.description, "diagnostic").text }),
    // Not sanitized, because there is no text here to sanitize: a bit says a
    // credential exists and carries none of it. Sent only when true, so the
    // absence of the field is the "nothing stored" answer rather than a second
    // spelling of it.
    ...(entry.secretPresent ? { secretPresent: 1 } : {}),
  };
}

/** Closes a dump: the count lets the panel size its list before rendering. */
export function panelConfigEnd(count: number): PanelConfigEnd {
  return { type: "config_end", count };
}

/**
 * The verdict on one set — or on the dump itself when `id` is omitted. `error`
 * is prose for the panel's status area, sanitized here like every other
 * diagnostic, so a filesystem refusal quoting a path cannot smuggle control
 * characters or a credential onto the wire.
 */
export function panelConfigResult(result: {
  readonly id?: string;
  readonly ok: boolean;
  readonly applies?: "now" | "restart";
  readonly error?: string;
  readonly requestId?: string;
}): PanelConfigResult {
  return {
    type: "config_result",
    ...(result.id === undefined ? {} : { id: sanitizeAuditText(result.id, "diagnostic").text }),
    ...(result.requestId === undefined ? {} : { requestId: sanitizeAuditText(result.requestId, "diagnostic").text }),
    ok: result.ok ? 1 : 0,
    ...(result.applies === undefined ? {} : { applies: result.applies }),
    ...(result.error === undefined ? {} : { error: sanitizeAuditText(result.error, "diagnostic").text }),
  };
}

/**
 * One row of the source dump. The panel gets every declared entry — running,
 * stopped, or unsupported — so the form shows the whole truth about this run;
 * a capability this process cannot start must be visible as un-toggleable, not
 * hidden. Id and label sanitize as diagnostics like every wire string.
 *
 * `detail`, when present, is the newest diagnostic a *running* source has
 * recorded — the sentence that separates "watching" from "running but blind".
 * A screen reader whose accessibility permission is missing keeps polling and
 * keeps refusing; without this field the card reads "Watching" in calm green
 * while nothing is being observed, and the only person who could learn why is
 * the one reading the session's stderr — which in the panel-first flow has no
 * reader at all. The state still says `running`, because it does: the source
 * is up, its reader is looping, only its observations are refused. Absent
 * for `stopped` and `unsupported`, whose reasons the card already carries.
 */
export function panelSourceLine(input: {
  readonly id: string;
  readonly label: string;
  readonly state: "running" | "stopped" | "unsupported";
  readonly detail?: string;
}): PanelSourceLine {
  return {
    type: "source",
    id: sanitizeAuditText(input.id, "diagnostic").text,
    label: sanitizeAuditText(input.label, "diagnostic").text,
    state: input.state,
    ...(input.detail === undefined ? {} : { detail: sanitizeAuditText(input.detail, "diagnostic").text }),
  };
}

/** Closes a source dump, mirroring `config_end`'s count-for-sizing contract. */
export function panelSourceEnd(count: number): PanelSourceEnd {
  return { type: "source_end", count };
}

/**
 * The verdict on one toggle. Same shape discipline as `config_result`: id and
 * error sanitize as diagnostics, ok is 0|1, omission where nothing to say.
 */
export function panelSourceResult(result: {
  readonly id?: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly requestId?: string;
}): PanelSourceResult {
  return {
    type: "source_result",
    ...(result.id === undefined ? {} : { id: sanitizeAuditText(result.id, "diagnostic").text }),
    ...(result.requestId === undefined ? {} : { requestId: sanitizeAuditText(result.requestId, "diagnostic").text }),
    ok: result.ok ? 1 : 0,
    ...(result.error === undefined ? {} : { error: sanitizeAuditText(result.error, "diagnostic").text }),
  };
}

/** Version 2 is deliberately nested; it is never sent to a legacy subscriber. */
export interface PanelV2Snapshot {
  readonly type: "snapshot";
  readonly protocolVersion: 2;
  readonly state: {
    readonly connection: { readonly status: "connected" };
    readonly session: { readonly status?: "ready" | "needs_config"; readonly capture?: { readonly status: "open" | "paused" } };
    readonly activity: Record<string, unknown>;
    readonly sources: readonly Record<string, unknown>[];
    readonly config: readonly Record<string, unknown>[];
    readonly prompts: readonly Record<string, unknown>[];
  };
}
export interface PanelV2Event {
  readonly type: "event";
  readonly protocolVersion: 2;
  readonly event: { readonly type: string; readonly data: Record<string, unknown> };
}
export type PanelV2Message = PanelV2Snapshot | PanelV2Event;

/** Converts only display-safe legacy projections into a nested V2 event. */
export function panelV2Event(message: PanelMessage): PanelV2Event {
  const { type, ...data } = message as PanelMessage & Record<string, unknown>;
  return { type: "event", protocolVersion: 2, event: { type, data: sanitizedRecord(data) } };
}

/** V2 metadata is sanitized at the same boundary as legacy display text. */
export function panelV2Config(entry: PanelConfigEntryInput): Record<string, unknown> {
  return sanitizedRecord({ id: entry.id, label: entry.label, kind: entry.kind, value: entry.kind === "secret" ? undefined : entry.value,
    applies: entry.applies, overridden: entry.overridden, values: entry.values, group: entry.group,
    description: entry.description, secretPresent: entry.kind === "secret" ? Boolean(entry.secretPresent) : undefined });
}
export function panelV2Source(entry: PanelSourceDetail): Record<string, unknown> {
  return sanitizedRecord({ id: entry.id, label: entry.label, state: entry.state, reason: entry.reason, repair: entry.repair });
}

/**
 * Sanitizes every string anywhere in a V2 payload, however deeply nested.
 *
 * Recursive rather than field-by-field because the V2 shape is nested and a
 * per-field call is a list somebody has to remember to extend. This module is the
 * privacy choke point — everything the panel renders passes through here — so the
 * safe default has to be structural: a new field is sanitized because it is a
 * string, not because a maintainer noticed it.
 *
 * An `undefined` value drops its key rather than becoming `null`. "Not observed"
 * is a real state the panel renders in words, and the Rust parser refuses a line
 * carrying `null` outright.
 */
function sanitizeV2Data(value: unknown): unknown {
  if (typeof value === "string") return sanitizeAuditText(value, "diagnostic").text;
  if (Array.isArray(value)) return value.map(sanitizeV2Data);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) =>
        child === undefined ? [] : [[key, sanitizeV2Data(child)]],
      ),
    );
  }
  return value;
}

/** Narrows a sanitized payload back to the object shape its caller declared. */
function sanitizedRecord(value: unknown): Record<string, unknown> {
  return sanitizeV2Data(value) as Record<string, unknown>;
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
