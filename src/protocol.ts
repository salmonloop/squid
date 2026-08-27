import { Type, type TSchema } from "typebox";
import { Compile } from "typebox/compile";

export const activityKinds = [
  "application_activated",
  "window_changed",
  "focus_changed",
  "text_context_changed",
  "pointer_action",
  "keyboard_action",
  "clipboard_changed",
  "browser_navigated",
  "dom_changed",
  "file_opened",
  "file_saved",
  "terminal_command_completed",
  "screen_keyframe_created",
  "idle_state_changed",
  "capture_gate_changed",
] as const;

export type ActivityKind = (typeof activityKinds)[number];
export type ActivitySourceKind = "host" | "browser" | "ide" | "filesystem" | "synthetic";

export interface ActivityEvent<TPayload = unknown> {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
  ingestedAt: string;
  source: {
    kind: ActivitySourceKind;
    instanceId: string;
  };
  sessionId: string;
  sequence: number;
  correlationId: string | null;
  kind: ActivityKind;
  payload: TPayload;
  /**
   * Present and true only when a `CapturePolicy` redacted credential content
   * from this event before it entered the store. Absent means the event was not
   * filtered. Lets a replay or projection distinguish a window title that was
   * "[redacted]" from one that literally read "[redacted]".
   */
  readonly redacted?: boolean;
}

export interface ApplicationActivatedPayload {
  applicationId: string;
  applicationName: string;
}

export interface WindowChangedPayload {
  applicationId: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
}

export interface FocusChangedPayload {
  applicationId: string;
  windowTitle: string;
  role: "text_input" | "editor" | "button" | "link" | "unknown";
  label: string | null;
}

export interface TextContextChangedPayload {
  prefix: string;
  suffix: string;
  selection: string;
  language: string | null;
}

export interface FilePayload {
  path: string;
  applicationId: string | null;
}

export interface TerminalCommandCompletedPayload {
  commandClass: string;
  succeeded: boolean;
  exitCode: number | null;
}

export interface BrowserNavigatedPayload {
  url: string;
  title: string;
  host: string;
  /** Canonical v1+ shape. Legacy persisted events may omit it; the parser normalizes that to null. */
  owner: ForegroundOwner | null;
}

/**
 * The capture gate moved. This event is what makes a paused interval
 * distinguishable from an idle one: without it, a silent stretch in the
 * timeline is ambiguous between "the user stepped away" and "the user asked
 * not to be observed", and any later analysis reads the wrong one.
 */
export interface CaptureGateChangedPayload {
  paused: boolean;
}

export interface SemanticAction {
  kind: string;
  occurredAt: string;
  sourceEventId: string;
  applicationId: string | null;
  target: string | null;
  outcome: "unknown" | "succeeded" | "failed";
}

export interface FocusState {
  applicationId: string;
  windowTitle: string;
  role: FocusChangedPayload["role"];
  label: string | null;
}

export interface ForegroundOwner {
  applicationId: string;
  windowTitle: string;
}

export interface TextContextState {
  owner: ForegroundOwner | null;
  prefix: string;
  suffix: string;
  selection: string;
  language: string | null;
  sourceEventId: string;
  observedAt: string;
  observationOrdinal: number;
}

export interface BrowserPageState extends BrowserNavigatedPayload {
  sourceEventId: string;
  observedAt: string;
  observationOrdinal: number;
}

export interface CaptureGateState {
  paused: boolean;
  sourceEventId: string;
  occurredAt: string;
}

export interface EpisodeState {
  id: string;
  startedAt: string;
  eventCount: number;
}

export interface WorldState {
  updatedAt: string | null;
  lastEventKind: ActivityKind | null;
  episode: EpisodeState | null;
  activeApplication: { id: string; name: string } | null;
  activeWindow: WindowChangedPayload | null;
  focus: FocusState | null;
  textContext: TextContextState | null;
  currentBrowserPage: BrowserPageState | null;
  recentFiles: string[];
  recentActions: SemanticAction[];
  lastCommandOutcome: TerminalCommandCompletedPayload | null;
  /** Last observed gate position; null until a gate event is seen. */
  captureGate: CaptureGateState | null;
}

/**
 * The semantic categories a capability can belong to.
 *
 * Survives the move to an agent-driven runtime because it is a vocabulary, not
 * a pipeline stage: a tool declares which kind of work it does, and the agent
 * reads that category in the catalog to tell "run the tests" from "look at the
 * error". What it no longer names is a ranked proposal — there are no
 * candidates now, only tools the agent may choose to call.
 */
export type PredictionKind =
  | "draft_completion"
  | "run_tests"
  | "inspect_error"
  | "search_selection"
  | "none";

const nonEmptyString = () => Type.String({ minLength: 1 });
const timestamp = () => Type.String({ format: "date-time", minLength: 1 });
const sourceSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("host"),
    Type.Literal("browser"),
    Type.Literal("ide"),
    Type.Literal("filesystem"),
    Type.Literal("synthetic"),
  ]),
  instanceId: nonEmptyString(),
}, { additionalProperties: false });
const boundsSchema = Type.Object({
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Number(),
  height: Type.Number(),
}, { additionalProperties: false });
const emptyPayloadSchema = Type.Object({}, { additionalProperties: false });
const applicationActivatedPayloadSchema = Type.Object({
  applicationId: nonEmptyString(),
  applicationName: nonEmptyString(),
}, { additionalProperties: false });
const windowChangedPayloadSchema = Type.Object({
  applicationId: nonEmptyString(),
  title: Type.String(),
  bounds: Type.Union([boundsSchema, Type.Null()]),
}, { additionalProperties: false });
const focusChangedPayloadSchema = Type.Object({
  applicationId: nonEmptyString(),
  windowTitle: Type.String(),
  role: Type.Union([
    Type.Literal("text_input"),
    Type.Literal("editor"),
    Type.Literal("button"),
    Type.Literal("link"),
    Type.Literal("unknown"),
  ]),
  label: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
const textContextChangedPayloadSchema = Type.Object({
  prefix: Type.String(),
  suffix: Type.String(),
  selection: Type.String(),
  language: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
const filePayloadSchema = Type.Object({
  path: nonEmptyString(),
  applicationId: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
const terminalCommandCompletedPayloadSchema = Type.Object({
  commandClass: nonEmptyString(),
  succeeded: Type.Boolean(),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
}, { additionalProperties: false });
const browserNavigatedPayloadSchema = Type.Object({
  url: Type.String({ format: "uri", minLength: 1 }),
  title: Type.String(),
  host: nonEmptyString(),
  owner: Type.Union([Type.Object({
    applicationId: nonEmptyString(),
    windowTitle: Type.String(),
  }, { additionalProperties: false }), Type.Null()]),
}, { additionalProperties: false });

function activityEventSchema(kind: ActivityKind, payload: TSchema) {
  return Type.Object({
    schemaVersion: Type.Literal(1),
    eventId: nonEmptyString(),
    occurredAt: timestamp(),
    ingestedAt: timestamp(),
    source: sourceSchema,
    sessionId: nonEmptyString(),
    sequence: Type.Integer({ minimum: 0 }),
    correlationId: Type.Union([Type.String(), Type.Null()]),
    kind: Type.Literal(kind),
    payload,
    redacted: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false });
}

export const ActivityEventSchema = Type.Union([
  activityEventSchema("application_activated", applicationActivatedPayloadSchema),
  activityEventSchema("window_changed", windowChangedPayloadSchema),
  activityEventSchema("focus_changed", focusChangedPayloadSchema),
  activityEventSchema("text_context_changed", textContextChangedPayloadSchema),
  activityEventSchema("pointer_action", emptyPayloadSchema),
  activityEventSchema("keyboard_action", emptyPayloadSchema),
  activityEventSchema("clipboard_changed", emptyPayloadSchema),
  activityEventSchema("browser_navigated", browserNavigatedPayloadSchema),
  activityEventSchema("dom_changed", emptyPayloadSchema),
  activityEventSchema("file_opened", filePayloadSchema),
  activityEventSchema("file_saved", filePayloadSchema),
  activityEventSchema("terminal_command_completed", terminalCommandCompletedPayloadSchema),
  activityEventSchema("screen_keyframe_created", emptyPayloadSchema),
  activityEventSchema("idle_state_changed", emptyPayloadSchema),
  activityEventSchema(
    "capture_gate_changed",
    Type.Object({ paused: Type.Boolean() }, { additionalProperties: false }),
  ),
]);

const activityEventValidator = Compile(ActivityEventSchema);
/**
 * Next auto-assigned sequence per `(source kind, instance, session)`. Process-
 * local by nature: the counter cannot know what a store already holds.
 *
 * That is why the default session below is unique per process. `sequence` is
 * part of an event's persisted identity, so a constant default session would
 * make a restarted process reserve 0, 1, 2 again and collide with its own
 * history — the same trap `FilesystemActivitySource` and
 * `ScreenTextActivitySource` avoid by defaulting to a fresh session each.
 * A caller that supplies its own `sessionId` and relies on auto-reservation
 * across restarts owns that reconciliation itself.
 */
const nextSequenceBySource = new Map<string, number>();
const defaultSessionId = `session-${crypto.randomUUID()}`;

export class ActivityEventValidationError extends Error {
  public constructor(public readonly issues: readonly string[]) {
    super("Activity event failed protocol validation.");
    this.name = "ActivityEventValidationError";
  }
}

export function parseActivityEvent(value: unknown): ActivityEvent {
  const normalized = normalizeLegacyActivityEvent(value);
  if (!activityEventValidator.Check(normalized)) {
    throw new ActivityEventValidationError(
      activityEventValidator.Errors(normalized).map((issue) => issue.message),
    );
  }

  const event = activityEventValidator.Parse(normalized) as ActivityEvent;
  if (!isFiniteTimestamp(event.occurredAt) || !isFiniteTimestamp(event.ingestedAt)) {
    throw new ActivityEventValidationError(["occurredAt and ingestedAt must be finite ISO date-time values."]);
  }

  return structuredClone(event);
}

function normalizeLegacyActivityEvent(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const event = value as Record<string, unknown>;
  if (event.schemaVersion !== 1 || event.kind !== "browser_navigated") return value;
  const payload = event.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return value;
  if (Object.prototype.hasOwnProperty.call(payload, "owner")) return value;
  return {
    ...event,
    payload: { ...(payload as Record<string, unknown>), owner: null },
  };
}

export function isActivityEvent(value: unknown): value is ActivityEvent {
  try {
    parseActivityEvent(value);
    return true;
  } catch {
    return false;
  }
}

export function createActivityEvent<TPayload>(input: {
  kind: ActivityKind;
  payload: TPayload;
  source?: ActivityEvent["source"];
  sessionId?: string;
  sequence?: number;
  occurredAt?: string;
  eventId?: string;
  correlationId?: string | null;
  redacted?: boolean;
}): ActivityEvent<TPayload> {
  assertCanonicalPayload(input.kind, input.payload);
  const now = new Date().toISOString();
  const source = input.source ?? { kind: "synthetic", instanceId: "local" };
  const sessionId = input.sessionId ?? defaultSessionId;
  const sequence = reserveSequence(source, sessionId, input.sequence);
  const event: ActivityEvent<TPayload> = {
    schemaVersion: 1,
    eventId: input.eventId ?? crypto.randomUUID(),
    occurredAt: input.occurredAt ?? now,
    ingestedAt: now,
    source,
    sessionId,
    sequence,
    correlationId: input.correlationId ?? null,
    kind: input.kind,
    payload: input.payload,
    ...(input.redacted === undefined ? {} : { redacted: input.redacted }),
  };
  return parseActivityEvent(event) as ActivityEvent<TPayload>;
}

function assertCanonicalPayload(kind: ActivityKind, payload: unknown): void {
  if (kind !== "browser_navigated") return;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)
    || !Object.prototype.hasOwnProperty.call(payload, "owner")) {
    throw new TypeError("New browser_navigated events must include an explicit owner (use null when unknown).");
  }
}

export function emptyWorldState(): WorldState {
  return {
    updatedAt: null,
    lastEventKind: null,
    episode: null,
    activeApplication: null,
    activeWindow: null,
    focus: null,
    textContext: null,
    currentBrowserPage: null,
    recentFiles: [],
    recentActions: [],
    lastCommandOutcome: null,
    captureGate: null,
  };
}

function reserveSequence(
  source: ActivityEvent["source"],
  sessionId: string,
  requestedSequence: number | undefined,
): number {
  const key = JSON.stringify([source.kind, source.instanceId, sessionId]);
  const sequence = requestedSequence ?? (nextSequenceBySource.get(key) ?? 0);
  nextSequenceBySource.set(key, Math.max(nextSequenceBySource.get(key) ?? 0, sequence + 1));
  return sequence;
}

function isFiniteTimestamp(value: string): boolean {
  return Number.isFinite(new Date(value).getTime());
}
