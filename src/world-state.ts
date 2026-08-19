import { orderActivityEvents } from "./chronicle-ordering.js";
import {
  assertEpisodeGap,
  DEFAULT_EPISODE_GAP_MS,
  elapsedMs,
  episodeIdForEvent,
} from "./episode.js";
import {
  emptyWorldState,
  parseActivityEvent,
  type ActivityEvent,
  type ApplicationActivatedPayload,
  type BrowserNavigatedPayload,
  type FocusChangedPayload,
  type SemanticAction,
  type TerminalCommandCompletedPayload,
  type TextContextChangedPayload,
  type WindowChangedPayload,
  type WorldState,
} from "./protocol.js";

const MAX_RECENT_ITEMS = 20;

export function reduceWorldState(
  state: WorldState,
  input: ActivityEvent,
  gapMs = DEFAULT_EPISODE_GAP_MS,
): WorldState {
  assertEpisodeGap(gapMs);
  const event = parseActivityEvent(input);
  const opensEpisode = state.episode === null
    || (state.updatedAt !== null && elapsedMs(state.updatedAt, event.occurredAt) >= gapMs);

  // All inferred interaction context is episode-scoped. The boundary event's
  // reducer branch can immediately re-establish fields it authoritatively carries.
  const episodeBase = opensEpisode
    ? {
        ...state,
        activeApplication: null,
        activeWindow: null,
        focus: null,
        currentBrowserPage: null,
        recentFiles: [],
        recentActions: [],
        lastCommandOutcome: null,
      }
    : state;
  const next: WorldState = {
    ...episodeBase,
    updatedAt: event.occurredAt,
    lastEventKind: event.kind,
    episode: opensEpisode
      ? { id: episodeIdForEvent(event), startedAt: event.occurredAt, eventCount: 1 }
      : { ...state.episode!, eventCount: state.episode!.eventCount + 1 },
    recentFiles: [...episodeBase.recentFiles],
    recentActions: [...episodeBase.recentActions],
  };

  switch (event.kind) {
    case "application_activated": {
      const payload = event.payload as ApplicationActivatedPayload;
      next.activeApplication = { id: payload.applicationId, name: payload.applicationName };
      break;
    }
    case "window_changed":
      next.activeWindow = structuredClone(event.payload as WindowChangedPayload);
      break;
    case "focus_changed": {
      const payload = event.payload as FocusChangedPayload;
      next.focus = {
        applicationId: payload.applicationId,
        windowTitle: payload.windowTitle,
        role: payload.role,
        label: payload.label,
        prefix: next.focus?.prefix ?? "",
        suffix: next.focus?.suffix ?? "",
        selection: next.focus?.selection ?? "",
        language: next.focus?.language ?? null,
      };
      break;
    }
    case "text_context_changed": {
      const payload = event.payload as TextContextChangedPayload;
      next.focus = {
        applicationId: next.focus?.applicationId ?? "unknown",
        windowTitle: next.focus?.windowTitle ?? "",
        role: next.focus?.role ?? "unknown",
        label: next.focus?.label ?? null,
        prefix: payload.prefix,
        suffix: payload.suffix,
        selection: payload.selection,
        language: payload.language,
      };
      break;
    }
    case "file_opened":
    case "file_saved": {
      const payload = event.payload as { path: string };
      next.recentFiles = [payload.path, ...next.recentFiles.filter((path) => path !== payload.path)].slice(
        0,
        MAX_RECENT_ITEMS,
      );
      recordAction(next, {
        kind: event.kind,
        occurredAt: event.occurredAt,
        sourceEventId: event.eventId,
        target: payload.path,
        outcome: event.kind === "file_saved" ? "succeeded" : "unknown",
      });
      break;
    }
    case "terminal_command_completed": {
      const payload = event.payload as TerminalCommandCompletedPayload;
      next.lastCommandOutcome = structuredClone(payload);
      recordAction(next, {
        kind: "terminal_command",
        occurredAt: event.occurredAt,
        sourceEventId: event.eventId,
        target: payload.commandClass,
        outcome: payload.succeeded ? "succeeded" : "failed",
      });
      break;
    }
    case "browser_navigated":
      next.currentBrowserPage = structuredClone(event.payload as BrowserNavigatedPayload);
      break;
    default:
      break;
  }

  return next;
}

export function buildWorldState(
  events: readonly ActivityEvent[],
  gapMs = DEFAULT_EPISODE_GAP_MS,
): WorldState {
  assertEpisodeGap(gapMs);
  return orderActivityEvents(events.map(parseActivityEvent)).reduce(
    (state, event) => reduceWorldState(state, event, gapMs),
    emptyWorldState(),
  );
}

export function cloneWorldState(state: WorldState): WorldState {
  return structuredClone(state);
}

function recordAction(state: WorldState, action: SemanticAction): void {
  state.recentActions = [action, ...state.recentActions].slice(0, MAX_RECENT_ITEMS);
}
