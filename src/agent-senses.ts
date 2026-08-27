import { catalogPromptLines } from "./tool-catalog.js";
import type { ToolSummary } from "./tool-catalog.js";
import type { WorldState } from "./protocol.js";

/**
 * How the resident agent sees the world.
 *
 * The agent's "eyes and ears" are this rendering: the current WorldState
 * projected into prompt lines, delivered before every LLM call via the
 * `on("context")` hook. The agent reads what the sensors saw and decides
 * what to do — it is not told what to do by code.
 *
 * This is a pure function of (WorldState, tools) → string[] so it is testable
 * without a model, the same posture as `catalogPromptLines`. The rendering is
 * line-oriented and labeled rather than a raw JSON blob: the model reads a
 * structured view, not a dump it has to parse.
 *
 * What is deliberately *not* here: instructions, rationale, "you should…".
 * Those belong in the system prompt. This function reports state; the agent
 * interprets it.
 */
export function sensePromptLines(
  state: WorldState,
  tools: readonly ToolSummary[] | undefined,
): string[] {
  const lines: string[] = ["# Current world state"];

  if (state.updatedAt !== null) {
    lines.push(`updated_at: ${state.updatedAt}`);
  }
  if (state.lastEventKind !== null) {
    lines.push(`last_event: ${state.lastEventKind}`);
  }
  if (state.episode !== null) {
    lines.push(
      `episode: id=${state.episode.id} started=${state.episode.startedAt} events=${state.episode.eventCount}`,
    );
  }

  if (state.activeApplication !== null) {
    lines.push(
      `active_application: id=${state.activeApplication.id} name=${state.activeApplication.name}`,
    );
  }
  if (state.activeWindow !== null) {
    lines.push(
      `active_window: app=${state.activeWindow.applicationId} title=${JSON.stringify(state.activeWindow.title)}`,
    );
  }
  if (state.focus !== null) {
    lines.push(
      `focus: app=${state.focus.applicationId} role=${state.focus.role}${state.focus.label !== null ? ` label=${JSON.stringify(state.focus.label)}` : ""} title=${JSON.stringify(state.focus.windowTitle)}`,
    );
  }
  if (state.textContext !== null) {
    lines.push(renderTextContext(state.textContext));
  }
  if (state.currentBrowserPage !== null) {
    lines.push(
      `browser_page: url=${JSON.stringify(state.currentBrowserPage.url)} title=${JSON.stringify(state.currentBrowserPage.title)}`,
    );
  }
  if (state.recentFiles.length > 0) {
    lines.push(`recent_files: ${state.recentFiles.map((f) => JSON.stringify(f)).join(" ")}`);
  }
  if (state.lastCommandOutcome !== null) {
    const cmd = state.lastCommandOutcome;
    lines.push(
      `last_command: class=${JSON.stringify(cmd.commandClass)} outcome=${cmd.succeeded ? "succeeded" : "failed"}${cmd.exitCode !== null ? ` exit=${cmd.exitCode}` : ""}`,
    );
  }
  if (state.captureGate !== null) {
    lines.push(`capture_gate: ${state.captureGate.paused ? "paused" : "open"}`);
  }

  if (state.recentActions.length > 0) {
    lines.push("recent_actions:");
    for (const action of state.recentActions) {
      lines.push(
        `  - kind=${action.kind} target=${action.target === null ? "(none)" : JSON.stringify(action.target)} outcome=${action.outcome} at=${action.occurredAt}`,
      );
    }
  }

  lines.push("");
  lines.push("# Tool catalog");
  lines.push(...catalogPromptLines(tools));

  return lines;
}

function renderTextContext(ctx: NonNullable<WorldState["textContext"]>): string {
  const parts = [
    `owner=${ctx.owner?.applicationId ?? "(none)"}`,
    `language=${ctx.language ?? "(unknown)"}`,
    `selection=${JSON.stringify(truncate(ctx.selection, 200))}`,
    `prefix=${JSON.stringify(truncate(ctx.prefix, 200))}`,
    `suffix=${JSON.stringify(truncate(ctx.suffix, 200))}`,
  ];
  return `text_context: ${parts.join(" ")}`;
}

/** Truncates a string to `max` chars with an ellipsis, for prompt brevity. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
