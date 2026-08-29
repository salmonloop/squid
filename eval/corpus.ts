import { createActivityEvent, type ActivityEvent } from "../src/protocol.js";
import type { ActivityReading } from "../src/resident-agent.js";

/**
 * The agent-evaluation corpus: worked examples of "what the sensors saw" and
 * what a reader should conclude from them.
 *
 * A corpus that nothing consumes is a pile of files — a green gate proves
 * nothing about it. So each scenario is exercised by `tests/eval-corpus.test.ts`,
 * which projects the events through the real SquidCore, renders the real sense
 * prompt, and asserts the evidence the scenario claims is actually visible in
 * what the agent would read. If a sensor renames a field, the corpus fails the
 * gate instead of silently rotting.
 *
 * What is deliberately *not* asserted here is the `reading` — "what the user is
 * doing" is a judgment only the live agent can make, and the live model is
 * deliberately kept out of CI (its latency and nondeterminism are measured
 * facts, not tuning problems). The reading is recorded as the *expected*
 * judgment for human- and agent-run evaluation, typed so a vocabulary change
 * breaks compilation.
 */

export interface EvalScenario {
  readonly id: string;
  readonly description: string;
  /** The sensory record, in capture order, at fixed times so runs are deterministic. */
  readonly events: readonly ActivityEvent[];
  /** Substrings that must appear in the sense prompt the agent reads. */
  readonly evidence: readonly string[];
  /** Substrings that must NOT appear — absence is part of what a scenario teaches. */
  readonly absence?: readonly string[];
  /** What a reader should conclude the user is doing; `null` when nothing is supported. */
  readonly reading: ActivityReading | null;
}

const BASE_MS = Date.parse("2026-08-29T10:00:00Z");

/** Fixed-scenario timestamp: `at(5)` is five seconds after the scenario base. */
function at(seconds: number): string {
  return new Date(BASE_MS + seconds * 1000).toISOString();
}

function ev(kind: ActivityEvent["kind"], occurredAt: string, payload: Record<string, unknown>): ActivityEvent {
  return createActivityEvent({ kind, occurredAt, payload });
}

export const evalScenarios: readonly EvalScenario[] = [
  {
    id: "debugging-a-failed-test",
    description:
      "A terminal ran the test suite, it failed, and the user moved to the editor and " +
      "focused the source file — reading the failure, not writing code yet.",
    events: [
      ev("application_activated", at(0), { applicationId: "terminal", applicationName: "Terminal" }),
      ev("terminal_command_completed", at(5), { commandClass: "test", succeeded: false, exitCode: 1 }),
      ev("application_activated", at(20), { applicationId: "editor", applicationName: "Editor" }),
      ev("focus_changed", at(25), {
        applicationId: "editor",
        windowTitle: "watch-session.ts",
        role: "editor",
        label: "watch-session.ts",
      }),
    ],
    evidence: ["last_command: class=\"test\" outcome=failed exit=1", "active_application: id=editor"],
    reading: "debugging a failure",
  },
  {
    id: "drafting-a-document",
    description:
      "An editor holds prose mid-sentence with no selection — the user is composing, not " +
      "manipulating a result.",
    events: [
      ev("application_activated", at(0), { applicationId: "editor", applicationName: "Editor" }),
      ev("focus_changed", at(5), {
        applicationId: "editor",
        windowTitle: "essay.md",
        role: "text_input",
        label: "Essay",
      }),
      ev("text_context_changed", at(10), {
        prefix: "The next release should ship",
        suffix: "",
        selection: "",
        language: "en",
      }),
    ],
    evidence: ["active_application: id=editor", "prefix=\"The next release should ship\"", "selection=\"\""],
    absence: ["last_command", "browser_page"],
    reading: "drafting text",
  },
  {
    id: "researching-a-selection",
    description:
      "The browser landed on documentation and the user selected a phrase in it — a " +
      "lookup-in-progress, anchored to specific text.",
    events: [
      ev("application_activated", at(0), { applicationId: "browser", applicationName: "Browser" }),
      ev("window_changed", at(5), {
        applicationId: "browser",
        title: "Refinery overview",
        bounds: null,
      }),
      ev("browser_navigated", at(10), {
        url: "https://docs.example.com/refinery/overview",
        title: "Refinery overview",
        host: "docs.example.com",
        owner: { applicationId: "browser", windowTitle: "Refinery overview" },
      }),
      ev("focus_changed", at(20), {
        applicationId: "browser",
        windowTitle: "Refinery overview",
        role: "unknown",
        label: null,
      }),
      ev("text_context_changed", at(25), {
        prefix: "Refinery is ",
        suffix: " for production traces.",
        selection: "trace-aware tail-based sampling",
        language: "en",
      }),
    ],
    evidence: [
      "browser_page: url=\"https://docs.example.com/refinery/overview\"",
      "selection=\"trace-aware tail-based sampling\"",
    ],
    absence: ["last_command"],
    reading: "researching a selection",
  },
  {
    id: "validating-a-change",
    description:
      "A file was just saved and then the test suite ran clean — the edit exists and is " +
      "verified, not merely attempted.",
    events: [
      ev("file_saved", at(0), { path: "src/agent-senses.ts", applicationId: "editor" }),
      ev("application_activated", at(10), { applicationId: "terminal", applicationName: "Terminal" }),
      ev("terminal_command_completed", at(15), { commandClass: "test", succeeded: true, exitCode: 0 }),
    ],
    evidence: ["recent_files: \"src/agent-senses.ts\"", "last_command: class=\"test\" outcome=succeeded exit=0"],
    reading: "validating a change",
  },
  {
    id: "away-idle",
    description:
      "The capture gate paused and nothing else happened — the honest reading is that no " +
      "activity supports a conclusion at all.",
    events: [
      ev("idle_state_changed", at(0), {}),
      ev("capture_gate_changed", at(5), { paused: true }),
    ],
    evidence: ["capture_gate: paused"],
    absence: ["text_context", "last_command", "browser_page", "active_application"],
    reading: null,
  },
];
