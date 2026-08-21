import { quote } from "shell-quote";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PredictionCandidate, PredictionKind } from "./protocol.js";

/** Prediction kinds with a concrete MCP action contract. */
export const actionablePredictionKinds = [
  "search_selection",
  "run_tests",
] as const satisfies readonly PredictionKind[];

export type ActionablePredictionKind = (typeof actionablePredictionKinds)[number];

export interface CapabilityActionPlan {
  readonly kind: ActionablePredictionKind;
  readonly tool: string;
  readonly arguments: Record<string, string | number | boolean | null>;
  /** Exact, human-readable operation presented at the confirmation boundary. */
  readonly summary: string;
  readonly confirmation: "none" | "required";
}

export interface CapabilityActionPlanFailure {
  readonly error: string;
}

export interface CapabilityActionPlanningContext {
  readonly workingDirectory?: string;
}

/**
 * Converts a prediction into the one concrete operation Squid may request.
 *
 * This is shared by confirmation and execution so the user never approves a
 * friendly description while the gateway constructs a different command.
 */
export function planCapabilityAction(
  kind: PredictionKind,
  parameters: PredictionCandidate["parameters"],
  context: CapabilityActionPlanningContext = {},
): CapabilityActionPlan | CapabilityActionPlanFailure {
  switch (kind) {
    case "search_selection": {
      const selection = parameters.selection;
      if (typeof selection !== "string" || selection.trim().length === 0) {
        return { error: "Candidate parameters do not satisfy the search_web contract." };
      }
      return {
        kind,
        tool: "search_web",
        arguments: { query: selection },
        summary: `Search the web for ${JSON.stringify(selection)}`,
        confirmation: "none",
      };
    }

    case "run_tests": {
      const path = parameters.path;
      if (typeof path !== "string" || path.trim().length === 0) {
        return { error: "Candidate parameters do not satisfy the run_command contract." };
      }
      if (/[\u0000-\u001F\u007F]/u.test(path)) {
        return { error: "run_tests path contains control characters." };
      }
      if (isAbsolute(path)) {
        return { error: "run_tests path must be relative to the action working directory." };
      }
      if (context.workingDirectory === undefined || !isAbsolute(context.workingDirectory)) {
        return { error: "run_tests requires an explicit working directory." };
      }
      if (/[\u0000-\u001F\u007F]/u.test(context.workingDirectory)) {
        return { error: "run_tests working directory contains control characters." };
      }
      const pathFromRoot = relative(
        context.workingDirectory,
        resolve(context.workingDirectory, path),
      );
      if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
        return { error: "run_tests path must stay inside the action working directory." };
      }
      const command = `cd ${quote([context.workingDirectory])} && ${quote(["bun", "test", "--", path])}`;
      return {
        kind,
        tool: "run_command",
        arguments: { command },
        summary: command,
        confirmation: "required",
      };
    }

    case "draft_completion":
    case "inspect_error":
    case "none":
      return { error: `No MCP tool mapping exists for prediction kind "${kind}".` };

    default:
      return assertNever(kind);
  }
}

export function isActionPlanFailure(
  plan: CapabilityActionPlan | CapabilityActionPlanFailure,
): plan is CapabilityActionPlanFailure {
  return "error" in plan;
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled prediction kind: ${String(value)}`);
}
