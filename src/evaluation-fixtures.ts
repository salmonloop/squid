import { createActivityEvent, type ActivityEvent } from "./protocol.js";
import type { ReplayScenario } from "./evaluation.js";

const syntheticSource = { kind: "synthetic" as const, instanceId: "evaluation-fixture" };
const filesystemSource = { kind: "filesystem" as const, instanceId: "evaluation-filesystem" };
const sessionId = "evaluation-session";

function event<TPayload>(input: {
  eventId: string;
  sequence: number;
  occurredAt: string;
  kind: Parameters<typeof createActivityEvent<TPayload>>[0]["kind"];
  payload: TPayload;
  source?: ActivityEvent["source"];
}): ActivityEvent<TPayload> {
  return createActivityEvent({ ...input, source: input.source ?? syntheticSource, sessionId });
}

export const heuristicEvaluationScenarios: readonly ReplayScenario[] = [
  {
    id: "browser-selection-search",
    title: "Search a selected browser error",
    events: [
      event({
        eventId: "browser-selection",
        sequence: 2,
        occurredAt: "2026-08-18T10:00:02.000Z",
        kind: "text_context_changed",
        payload: { prefix: "", suffix: "", selection: "TypeError", language: null },
      }),
      event({
        eventId: "browser-page",
        sequence: 0,
        occurredAt: "2026-08-18T10:00:00.000Z",
        kind: "browser_navigated",
        payload: { url: "https://example.com/errors", title: "Errors", host: "example.com" },
      }),
      event({
        eventId: "browser-focus",
        sequence: 1,
        occurredAt: "2026-08-18T10:00:01.000Z",
        kind: "focus_changed",
        payload: { applicationId: "browser", windowTitle: "Errors", role: "text_input", label: "Search" },
      }),
    ],
    cutPoints: [{
      id: "after-selection",
      eventIndex: 2,
      expectedKind: "search_selection",
      description: "The selection is ready to search, without any future navigation context.",
    }],
  },
  {
    id: "code-save-run-tests",
    title: "Run tests after saving code",
    events: [
      event({
        eventId: "code-save",
        sequence: 1,
        occurredAt: "2026-08-18T10:01:01.000Z",
        kind: "file_saved",
        payload: { path: "src/main.ts", applicationId: "vscode" },
      }),
      event({
        eventId: "code-app",
        sequence: 0,
        occurredAt: "2026-08-18T10:01:00.000Z",
        kind: "application_activated",
        payload: { applicationId: "vscode", applicationName: "Visual Studio Code" },
      }),
    ],
    cutPoints: [{
      id: "after-save",
      eventIndex: 1,
      expectedKind: "run_tests",
      description: "The saved code file is the final context available to the predictor.",
    }],
  },
  {
    id: "editor-draft-completion",
    title: "Complete a draft in an editor",
    events: [
      event({
        eventId: "editor-text",
        sequence: 2,
        occurredAt: "2026-08-18T10:02:02.000Z",
        kind: "text_context_changed",
        payload: { prefix: "The next release should", suffix: ".", selection: "", language: "en" },
      }),
      event({
        eventId: "editor-app",
        sequence: 0,
        occurredAt: "2026-08-18T10:02:00.000Z",
        kind: "application_activated",
        payload: { applicationId: "editor", applicationName: "Editor" },
      }),
      event({
        eventId: "editor-focus",
        sequence: 1,
        occurredAt: "2026-08-18T10:02:01.000Z",
        kind: "focus_changed",
        payload: { applicationId: "editor", windowTitle: "draft.md", role: "editor", label: "Document" },
      }),
    ],
    cutPoints: [{
      id: "after-text",
      eventIndex: 2,
      expectedKind: "draft_completion",
      description: "The editor has a non-empty prefix eligible for completion.",
    }],
  },
  {
    id: "failed-command-inspection",
    title: "Inspect a failed command",
    events: [
      event({
        eventId: "test-failed",
        sequence: 0,
        occurredAt: "2026-08-18T10:03:00.000Z",
        kind: "terminal_command_completed",
        payload: { commandClass: "test", succeeded: false, exitCode: 1 },
      }),
    ],
    cutPoints: [{
      id: "after-failure",
      eventIndex: 0,
      expectedKind: "inspect_error",
      description: "A failed terminal command should prompt error inspection.",
    }],
  },
  {
    // Exercises a real source: the write is observed by the filesystem watcher,
    // which knows the path but not the application. The coding context comes
    // from a separate source, so the two must combine through the projection.
    id: "filesystem-save-run-tests",
    title: "Run tests after a watched filesystem save",
    events: [
      event({
        eventId: "filesystem-save",
        sequence: 0,
        occurredAt: "2026-08-18T10:05:01.000Z",
        kind: "file_saved",
        payload: { path: "src/squid-core.ts", applicationId: "filesystem" },
        source: filesystemSource,
      }),
      event({
        eventId: "filesystem-code-app",
        sequence: 0,
        occurredAt: "2026-08-18T10:05:00.000Z",
        kind: "application_activated",
        payload: { applicationId: "vscode", applicationName: "Visual Studio Code" },
      }),
    ],
    cutPoints: [{
      id: "after-watched-save",
      eventIndex: 1,
      expectedKind: "run_tests",
      description: "A filesystem-observed save plus an active coding app should suggest tests.",
    }],
  },
  {
    id: "no-action-control",
    title: "No prediction without meaningful context",
    events: [
      event({
        eventId: "idle-app",
        sequence: 0,
        occurredAt: "2026-08-18T10:04:00.000Z",
        kind: "application_activated",
        payload: { applicationId: "clock", applicationName: "Clock" },
      }),
    ],
    cutPoints: [{
      id: "after-activation",
      eventIndex: 0,
      expectedKind: "none",
      description: "Foreground app activation alone should not trigger a suggestion.",
    }],
  },
];
