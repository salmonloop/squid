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
}

export interface SemanticAction {
  kind: string;
  occurredAt: string;
  sourceEventId: string;
  target: string | null;
  outcome: "unknown" | "succeeded" | "failed";
}

export interface FocusState {
  applicationId: string;
  windowTitle: string;
  role: FocusChangedPayload["role"];
  label: string | null;
  prefix: string;
  suffix: string;
  selection: string;
  language: string | null;
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
  currentBrowserPage: BrowserNavigatedPayload | null;
  recentFiles: string[];
  recentActions: SemanticAction[];
  lastCommandOutcome: TerminalCommandCompletedPayload | null;
}

export type PredictionKind =
  | "draft_completion"
  | "run_tests"
  | "inspect_error"
  | "search_selection"
  | "none";

export interface PredictionCandidate {
  kind: PredictionKind;
  rationale: string;
  confidence: number;
  expiresAt: string;
  sourceEventIds: string[];
  parameters: Record<string, string | number | boolean | null>;
}

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
]);

const activityEventValidator = Compile(ActivityEventSchema);
const nextSequenceBySource = new Map<string, number>();

export class ActivityEventValidationError extends Error {
  public constructor(public readonly issues: readonly string[]) {
    super("Activity event failed protocol validation.");
    this.name = "ActivityEventValidationError";
  }
}

export function parseActivityEvent(value: unknown): ActivityEvent {
  if (!activityEventValidator.Check(value)) {
    throw new ActivityEventValidationError(
      activityEventValidator.Errors(value).map((issue) => issue.message),
    );
  }

  const event = activityEventValidator.Parse(value) as ActivityEvent;
  if (!isFiniteTimestamp(event.occurredAt) || !isFiniteTimestamp(event.ingestedAt)) {
    throw new ActivityEventValidationError(["occurredAt and ingestedAt must be finite ISO date-time values."]);
  }

  return structuredClone(event);
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
}): ActivityEvent<TPayload> {
  const now = new Date().toISOString();
  const source = input.source ?? { kind: "synthetic", instanceId: "local" };
  const sessionId = input.sessionId ?? "default";
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
  };
  return parseActivityEvent(event) as ActivityEvent<TPayload>;
}

export function emptyWorldState(): WorldState {
  return {
    updatedAt: null,
    lastEventKind: null,
    episode: null,
    activeApplication: null,
    activeWindow: null,
    focus: null,
    currentBrowserPage: null,
    recentFiles: [],
    recentActions: [],
    lastCommandOutcome: null,
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
