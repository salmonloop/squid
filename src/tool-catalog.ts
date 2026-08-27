import type { PredictionKind } from "./protocol.js";

/**
 * The capability surface the agent is told about, as data.
 *
 * This module used to be half of a rule engine: a `ToolDescriptor` carried a
 * `render` that turned validated arguments into a concrete argv, and a `guard`
 * that decided when that argv was still allowed to run — because Squid built
 * every command itself and had to police what it built.
 *
 * It no longer builds commands. Pi's own tools (bash, read, edit, write, …) are
 * the execution surface, and tool-layer safety is Pi's sandbox, so there is
 * nothing here to render and nothing to guard. What remains is what the agent
 * genuinely needs: a description of extra capabilities it may ask for, rendered
 * into the prompt. Pure data, no behavior — which also means nothing in this
 * module can be the thing that decides whether an action is permitted.
 */

/** How much of the outside world a tool can reach. Declared, not inferred. */
export type ToolRisk =
  /** Reads project state and reports. Nothing observable changes. */
  | "read_only"
  /** Runs project tooling: may write build output, caches, or fixtures. */
  | "mutates_workspace"
  /** Leaves the machine. */
  | "external";

/**
 * The prompt-facing view of one capability: what a model needs to propose well,
 * and nothing else.
 *
 * The id to name it by, the title to understand it by, the category the work
 * falls under, the argument schema to satisfy, and the risk class. Anything
 * more is attack surface; anything less is guessing.
 */
export interface ToolSummary {
  readonly id: string;
  readonly title: string;
  readonly category: PredictionKind;
  /**
   * The argument schema itself, sent verbatim rather than paraphrased. A JSON
   * Schema is a plain object tree, so it crosses the boundary as data — and
   * sending the real thing means the prompt and whoever validates a call cannot
   * disagree about what counts as valid, which a hand-written description
   * eventually would.
   */
  readonly parameters: unknown;
  readonly risk: ToolRisk;
}

/**
 * Renders the catalog as prompt lines, one tool per line.
 *
 * Exported because the rendering is prompt surface with its own contract —
 * schema verbatim, absence stated rather than invented — and that contract is
 * testable without a model, which a private function's would not be.
 *
 * Absent tools means no catalog reached this request, and the honest rendering
 * is a stated absence, not an invented list: the agent still has Pi's own tools
 * and should reach for those rather than guess at an id that may not exist.
 */
export function catalogPromptLines(tools: readonly ToolSummary[] | undefined): string[] {
  if (tools === undefined) {
    return [
      "No supplementary tool catalog was supplied; use your built-in tools rather than naming a capability you cannot see.",
    ];
  }
  if (tools.length === 0) {
    return ["The supplementary tool catalog is empty; use your built-in tools."];
  }
  return tools.map((tool) =>
    `- id=${JSON.stringify(tool.id)} category=${JSON.stringify(tool.category)} risk=${tool.risk}: ${tool.title} — arguments schema: ${JSON.stringify(tool.parameters)}`,
  );
}
