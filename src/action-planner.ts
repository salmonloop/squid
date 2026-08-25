import { realpath } from "node:fs/promises";
import { quote } from "shell-quote";
import { sanitizeAuditText } from "./action-egress.js";
import {
  digestActionPlan,
  digestCandidateParameters,
  type ImmutableActionPlan,
} from "./action-plan.js";
import { isActionableCategory, type ActionablePredictionKind } from "./action-plan.js";
import { detectProject, type ProjectProfile } from "./project-detect.js";
import type { PredictionCandidate } from "./protocol.js";
import { renderCommandSummary, buildToolRegistry } from "./tool-descriptors.js";
import {
  isRenderFailure,
  ToolRegistry,
  type ToolRenderContext,
} from "./tool-catalog.js";

export { resolveDeepestAncestor } from "./path-containment.js";

export interface PlannedAction {
  readonly plan: ImmutableActionPlan;
  /** sha256 over the canonical plan. The identity confirm/claim/invoke share. */
  readonly planDigest: string;
  /** sha256 over the sanitized candidate parameters, for ledger audit. */
  readonly candidateParametersDigest: string;
}

export interface ActionPlanFailure {
  readonly reasonCode: PlanFailureReason;
}

/**
 * Why a candidate could not become a plan.
 *
 * The path and workdir codes are produced by `path-containment.ts` and pass through
 * unchanged; the planner adds only what it owns. `tool_unknown` covers both a
 * candidate naming no tool and one naming a tool this run did not register —
 * from the plan's point of view they are the same fact: there is nothing here
 * that can render.
 */
export type PlanFailureReason =
  | "tool_unknown"
  | "kind_unactionable"
  | "parameters_invalid"
  | "command_unavailable"
  | "workdir_missing"
  | "workdir_not_absolute"
  | "workdir_control_characters"
  | "path_absolute"
  | "path_control_characters"
  | "path_escapes_workdir"
  | "path_unresolvable"
  | "workdir_unresolvable";

/**
 * What the planner needs to build one plan: the predicted operation plus the
 * identity it will carry. The identity travels with the plan rather than beside
 * it so a claim can never pair a digest with the wrong candidate.
 */
export interface ActionPlanRequest {
  readonly candidateId: string;
  readonly attemptId: string;
  /** The semantic category the candidate claims. Used only when it names no tool. */
  readonly kind: PredictionCandidate["kind"];
  /**
   * The registered capability the candidate proposes, if it named one.
   *
   * Routing is by tool, not by kind: kinds group but do not select, and two
   * tools may share a category. A candidate that names a tool this registry
   * does not hold is refused — falling back to "some other tool of the same
   * category" would execute a capability nobody proposed.
   */
  readonly toolId: string | null;
  readonly parameters: PredictionCandidate["parameters"];
}

export interface ActionPlanningContext {
  readonly workingDirectory?: string;
  /** Injected in tests; defaults to the platform realpath. */
  readonly resolvePath?: (path: string) => Promise<string>;
  /**
   * What this project declares it can run. Absent (or omitted) means detection runs
   * against `workingDirectory`, which costs one directory read per planning call —
   * acceptable on an already-filesystem-bound path, and correct when no caller is
   * positioned to detect once per session.
   */
  readonly project?: ProjectProfile;
}

export function isPlanFailure(
  value: PlannedAction | ActionPlanFailure,
): value is ActionPlanFailure {
  return "reasonCode" in value;
}

/**
 * Turns a candidate into a canonical, immutable plan.
 *
 * The capability surface used to be a `switch (kind)` over three cases with two commands
 * hardcoded as string literals. It is now a lookup in the tool catalog by the tool the
 * candidate names: the registry validates the proposed arguments against the descriptor's
 * schema, and the descriptor's own render produces the invocation. Adding a capability
 * means registering a descriptor; nothing here changes.
 *
 * What did not move: canonicalization happens before anything user-visible exists, so
 * the digest covers the resolved truth rather than the string the model produced; and
 * the summary is built from canonical values only, so what the user approves cannot
 * describe a different file or command than the one that runs.
 */
export async function planAction(
  request: ActionPlanRequest,
  context: ActionPlanningContext = {},
): Promise<PlannedAction | ActionPlanFailure> {
  const { kind, toolId, parameters, candidateId, attemptId } = request;
  const resolvePath = context.resolvePath ?? ((path: string) => realpath(path));
  const renderContext: ToolRenderContext = {
    ...(context.workingDirectory !== undefined
      ? { workingDirectory: context.workingDirectory }
      : {}),
    resolvePath,
    ...(context.project !== undefined ? { project: context.project } : {}),
  };

  const registry = context.project !== undefined
    ? new ToolRegistry(registryForProject(context.project))
    : await defaultRegistry(context.workingDirectory);

  // The candidate names the tool; the kind only groups. A null toolId is a fact
  // about the proposal (nothing to do), not missing data, so there is no
  // category fallback for it — and none for an unknown id either: executing a
  // different tool of the same category would run something nobody proposed.
  const descriptor = toolId === null ? undefined : registry.get(toolId);
  if (descriptor === undefined) return { reasonCode: "tool_unknown" };

  // The catalog may hold tools whose category the rest of the system cannot
  // score or record. Refusing here keeps the refusal at the boundary where the
  // mismatch was introduced, rather than letting a plan through whose `kind`
  // would be unreadable downstream.
  if (!isActionableCategory(descriptor.category)) return { reasonCode: "kind_unactionable" };

  const rendered = await descriptor.render(parameters, renderContext);
  if (isRenderFailure(rendered)) {
    return rendered.reasonCode === "arguments_invalid"
      ? { reasonCode: "parameters_invalid" }
      : { reasonCode: rendered.reasonCode };
  }

  return finish({
    planSchemaVersion: 1,
    kind: descriptor.category as ActionablePredictionKind,
    // Frozen so the guard admission runs is the one this plan was rendered by,
    // even when another registered tool shares the same category.
    descriptorId: descriptor.id,
    candidateId,
    attemptId,
    tool: rendered.tool,
    // One command string, quoted by the same function that built the summary — the
    // argv discipline holds at the descriptor boundary, and the string here is its
    // presentation form, byte-identical to what the user approves.
    arguments:
      rendered.argv !== undefined && rendered.canonicalWorkingDirectory !== null
        ? {
          command: renderCommandSummary(rendered.canonicalWorkingDirectory, rendered.argv),
        }
        : rendered.arguments ?? {},
    summary: rendered.summary,
    confirmation: descriptor.confirmation,
    canonicalWorkingDirectory: rendered.canonicalWorkingDirectory,
    canonicalTarget: rendered.canonicalTarget,
  }, parameters);
}

/** Descriptors for one project's declared capabilities, in prompt order. */
function registryForProject(project: ProjectProfile) {
  return buildToolRegistry({ project }).all;
}

async function defaultRegistry(
  workingDirectory: string | undefined,
): Promise<ToolRegistry> {
  // Detection runs for real: a caller with no project profile still gets the tools
  // the directory itself declares, which is what makes `bun test` work in a plain
  // checkout without anyone wiring a ProjectProfile through.
  const project = workingDirectory === undefined
    ? undefined
    : await detectProject(workingDirectory);
  return buildToolRegistry({
    ...(project !== undefined ? { project } : {}),
  });
}

/**
 * Freezes the plan and derives the two digests that follow it everywhere.
 *
 * Both digests come from `action-admission.ts` so the value the planner writes
 * to the ledger is byte-identical to the value admission recomputes at claim
 * time. Two implementations of "the same digest" would eventually disagree, and
 * the disagreement would look like tampering.
 */
function finish(
  plan: ImmutableActionPlan,
  parameters: PredictionCandidate["parameters"],
): PlannedAction {
  const frozen: ImmutableActionPlan = Object.freeze({
    ...plan,
    arguments: Object.freeze({ ...plan.arguments }),
  });
  return {
    plan: frozen,
    planDigest: digestActionPlan(frozen),
    candidateParametersDigest: digestCandidateParameters(parameters),
  };
}
