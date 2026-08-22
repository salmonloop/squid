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
        textContext: null,
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
      if (next.activeApplication?.id !== payload.applicationId) {
        clearForegroundContext(next);
      }
      next.activeApplication = { id: payload.applicationId, name: payload.applicationName };
      break;
    }
    case "window_changed": {
      const payload = event.payload as WindowChangedPayload;
      const applicationChanged = next.activeApplication !== null
        && next.activeApplication.id !== payload.applicationId;
      const windowChanged = next.activeWindow === null
        || next.activeWindow.applicationId !== payload.applicationId
        || next.activeWindow.title !== payload.title;
      if (applicationChanged) {
        next.activeApplication = null;
      }
      if (applicationChanged || windowChanged) {
        next.focus = null;
        next.textContext = null;
        next.currentBrowserPage = null;
      }
      next.activeWindow = structuredClone(payload);
      break;
    }
    case "focus_changed": {
      const payload = event.payload as FocusChangedPayload;
      const focusOwnerChanged = next.focus === null
        || next.focus.applicationId !== payload.applicationId
        || next.focus.windowTitle !== payload.windowTitle;
      if (next.activeApplication !== null && next.activeApplication.id !== payload.applicationId) {
        next.activeApplication = null;
        next.currentBrowserPage = null;
      }
      if (
        next.activeWindow !== null
        && (next.activeWindow.applicationId !== payload.applicationId
          || next.activeWindow.title !== payload.windowTitle)
      ) {
        next.activeWindow = null;
        next.currentBrowserPage = null;
      }
      if (focusOwnerChanged && next.currentBrowserPage !== null) {
        const pageOwner = next.currentBrowserPage.owner;
        if (pageOwner === null
          || pageOwner.applicationId !== payload.applicationId
          || pageOwner.windowTitle !== payload.windowTitle) {
          next.currentBrowserPage = null;
        }
      }
      next.focus = {
        applicationId: payload.applicationId,
        windowTitle: payload.windowTitle,
        role: payload.role,
        label: payload.label,
      };
      next.textContext = null;
      break;
    }
    case "text_context_changed": {
      const payload = event.payload as TextContextChangedPayload;
      next.textContext = {
        owner: next.focus === null
          ? null
          : { applicationId: next.focus.applicationId, windowTitle: next.focus.windowTitle },
        prefix: payload.prefix,
        suffix: payload.suffix,
        selection: payload.selection,
        language: payload.language,
        sourceEventId: event.eventId,
        observedAt: event.occurredAt,
        observationOrdinal: next.episode?.eventCount ?? 0,
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
        applicationId: (event.payload as { applicationId?: string | null }).applicationId ?? null,
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
        applicationId: null,
        target: payload.commandClass,
        outcome: payload.succeeded ? "succeeded" : "failed",
      });
      break;
    }
    case "browser_navigated": {
      const payload = structuredClone(event.payload as BrowserNavigatedPayload);
      const owner = payload.owner ?? null;
      const ownerMatches = owner !== null && foregroundOwnerMatches(next, owner);
      next.currentBrowserPage = {
        ...payload,
        owner: ownerMatches ? structuredClone(owner) : null,
        sourceEventId: event.eventId,
        observedAt: event.occurredAt,
        observationOrdinal: next.episode?.eventCount ?? 0,
      };
      break;
    }
    default:
      break;
  }

  return next;
}

/**
 * Projects a whole timeline in canonical order. Events must have distinct
 * `eventId`s, which is what makes that order total — see
 * `compareActivityEvents`. Events read back from a store satisfy this because
 * `SquidCore` rejects a colliding `eventId` at ingest.
 */
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

function clearForegroundContext(state: WorldState): void {
  state.activeWindow = null;
  state.focus = null;
  state.textContext = null;
  state.currentBrowserPage = null;
}

function foregroundOwnerMatches(state: WorldState, owner: { applicationId: string; windowTitle: string }): boolean {
  if (state.activeApplication === null || state.activeApplication.id !== owner.applicationId) return false;
  if (state.activeWindow === null) return false;
  return state.activeWindow.applicationId === owner.applicationId && state.activeWindow.title === owner.windowTitle;
}
