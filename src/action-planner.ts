import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { quote } from "shell-quote";
import { sanitizeAuditText } from "./action-egress.js";
import {
  digestActionPlan,
  digestCandidateParameters,
  isReinspectableCommandClass,
  REINSPECT_COMMANDS,
  type ImmutableActionPlan,
} from "./action-plan.js";
import type { PredictionCandidate } from "./protocol.js";

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

export type PlanFailureReason =
  | "kind_not_actionable"
  | "parameters_invalid"
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
  readonly kind: PredictionCandidate["kind"];
  readonly parameters: PredictionCandidate["parameters"];
}

export interface ActionPlanningContext {
  readonly workingDirectory?: string;
  /** Injected in tests; defaults to the platform realpath. */
  readonly resolvePath?: (path: string) => Promise<string>;
}

export function isPlanFailure(
  value: PlannedAction | ActionPlanFailure,
): value is ActionPlanFailure {
  return "reasonCode" in value;
}

/**
 * Turns a candidate into a canonical, immutable plan.
 *
 * Async because canonicalization is a filesystem question: `realpath` is the
 * only way to know whether `src/../src/x.test.ts`, a symlink, or a bind mount
 * lands inside the working directory. Doing it here — once, before the user
 * sees anything — means the digest covers the resolved truth rather than the
 * string the model produced.
 */
export async function planAction(
  request: ActionPlanRequest,
  context: ActionPlanningContext = {},
): Promise<PlannedAction | ActionPlanFailure> {
  const { kind, parameters, candidateId, attemptId } = request;
  const resolvePath = context.resolvePath ?? ((path: string) => realpath(path));
  const identity = { candidateId, attemptId } as const;

  switch (kind) {
    case "search_selection": {
      const selection = parameters.selection;
      if (typeof selection !== "string" || selection.trim().length === 0) {
        return { reasonCode: "parameters_invalid" };
      }
      // The summary is what gets logged and shown; the raw selection lives only
      // in `arguments`, which never reaches the ledger.
      const sanitized = sanitizeAuditText(selection, "selection");
      return finish({
        planSchemaVersion: 1,
        kind,
        ...identity,
        tool: "search_web",
        arguments: { query: selection },
        summary: `Search the web for a ${sanitized.originalLength}-character selection`,
        confirmation: "none",
        canonicalWorkingDirectory: null,
        canonicalTarget: null,
      }, parameters);
    }

    case "run_tests": {
      const path = parameters.path;
      if (typeof path !== "string" || path.trim().length === 0) {
        return { reasonCode: "parameters_invalid" };
      }
      if (/[\u0000-\u001F\u007F]/u.test(path)) {
        return { reasonCode: "path_control_characters" };
      }
      if (isAbsolute(path)) {
        return { reasonCode: "path_absolute" };
      }
      const workdir = context.workingDirectory;
      if (workdir === undefined) {
        return { reasonCode: "workdir_missing" };
      }
      if (!isAbsolute(workdir)) {
        return { reasonCode: "workdir_not_absolute" };
      }
      if (/[\u0000-\u001F\u007F]/u.test(workdir)) {
        return { reasonCode: "workdir_control_characters" };
      }

      // Lexical containment first: it rejects the obvious `../..` cases without
      // touching the filesystem, so an unresolvable path cannot be used to
      // probe for existence outside the root.
      const lexical = relative(workdir, resolve(workdir, path));
      if (lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
        return { reasonCode: "path_escapes_workdir" };
      }

      let canonicalWorkdir: string;
      try {
        canonicalWorkdir = await resolvePath(workdir);
      } catch {
        return { reasonCode: "path_unresolvable" };
      }

      // The target may not exist yet — a test file about to be created — so an
      // unresolvable target is not itself a refusal. But falling back to the
      // lexically-joined path would skip every symlink on the way: a planted
      // `link -> /outside` plus a not-yet-existing `link/x.test.ts` would look
      // contained while `bun test` follows the link and executes outside the
      // root. So the deepest existing ancestor is resolved instead, and the
      // remaining segments are appended to *that*.
      const joined = resolve(canonicalWorkdir, lexical);
      let canonicalTarget: string;
      try {
        canonicalTarget = await resolvePath(joined);
      } catch {
        const resolvedAncestor = await resolveDeepestAncestor(
          canonicalWorkdir, lexical, resolvePath,
        );
        if (resolvedAncestor === null) {
          return { reasonCode: "path_unresolvable" };
        }
        canonicalTarget = resolvedAncestor;
      }
      const containment = relative(canonicalWorkdir, canonicalTarget);
      if (
        containment === ".." ||
        containment.startsWith(`..${sep}`) ||
        isAbsolute(containment)
      ) {
        return { reasonCode: "path_escapes_workdir" };
      }

      // Quoting happens once, over canonical values. The summary is the exact
      // command, because that is what the user is being asked to approve.
      const command = `cd ${quote([canonicalWorkdir])} && ${quote(["bun", "test", "--", containment])}`;
      return finish({
        planSchemaVersion: 1,
        kind,
        candidateId: identity.candidateId,
        attemptId: identity.attemptId,
        tool: "run_command",
        arguments: { command },
        summary: command,
        confirmation: "required",
        canonicalWorkingDirectory: canonicalWorkdir,
        canonicalTarget,
      }, parameters);
    }

    /**
     * Re-runs the failed check so its output is in front of the user.
     *
     * The mapping is narrow because the captured fact is narrow.
     * `TerminalCommandCompletedPayload` holds a class, a flag, and an exit code —
     * no command text, no output, no working directory — because a shell command
     * line is among the most sensitive text on a developer's machine and capture
     * is irreversible. So "show me the failing output" cannot be served from
     * history; the output has to be produced again.
     *
     * That rules out the two alternatives. Opening the file at the failing line
     * needs a line number nothing captured, and re-running with more verbosity
     * needs the original command. Re-running the project's own script for the
     * class is the only option the recorded fact actually supports.
     */
    case "inspect_error": {
      const commandClass = parameters.commandClass;
      if (!isReinspectableCommandClass(commandClass)) {
        // Includes every class deliberately left out of the re-runnable set:
        // `install` touches the network, `vcs` rewrites history, `container` can
        // deploy, `other` is unknown. A failed deploy must not propose itself.
        return { reasonCode: "parameters_invalid" };
      }
      const workdir = context.workingDirectory;
      if (workdir === undefined) {
        return { reasonCode: "workdir_missing" };
      }
      if (!isAbsolute(workdir)) {
        return { reasonCode: "workdir_not_absolute" };
      }
      if (/[\u0000-\u001F\u007F]/u.test(workdir)) {
        return { reasonCode: "workdir_control_characters" };
      }
      let canonicalWorkdir: string;
      try {
        canonicalWorkdir = await resolvePath(workdir);
      } catch {
        return { reasonCode: "workdir_unresolvable" };
      }

      // No path parameter at all, so there is nothing to contain: the command is
      // fixed by the class and runs at the canonical root. `canonicalTarget` stays
      // null, which is what tells the gateway there is no path boundary to
      // re-verify before the call.
      const command = `cd ${quote([canonicalWorkdir])} && ${quote([...REINSPECT_COMMANDS[commandClass]])}`;
      return finish({
        planSchemaVersion: 1,
        kind,
        candidateId: identity.candidateId,
        attemptId: identity.attemptId,
        tool: "run_command",
        arguments: { command },
        summary: command,
        // Same posture as `run_tests`: this executes locally, so the user sees
        // the exact command first.
        confirmation: "required",
        canonicalWorkingDirectory: canonicalWorkdir,
        canonicalTarget: null,
      }, parameters);
    }

    case "draft_completion":
    case "none":
      return { reasonCode: "kind_not_actionable" };

    default:
      return assertNever(kind);
  }
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

function assertNever(value: never): never {
  throw new TypeError(`Unhandled prediction kind: ${String(value)}`);
}

/**
 * Canonicalizes a path whose leaf does not exist yet.
 *
 * Walks from the full path toward the root until something resolves, then
 * re-appends the segments that did not. This is what makes a missing target
 * safe to plan: every existing component — including any symlinked directory
 * on the way — is traversed by `realpath`, so a link pointing outside the root
 * surfaces in the returned path and fails the containment check that follows.
 *
 * Returns null when not even the canonical root resolves, which means the
 * working directory vanished mid-plan and there is nothing safe to target.
 */
/**
 * Canonicalizes a target that may not exist yet.
 *
 * A missing file is legitimate — the plan may name a test the run will create —
 * but its *directories* still decide containment. Resolving only the full path
 * and falling back to the lexical join on failure would skip every symlink on
 * the way down, so a planted `link/ -> /outside` would pass containment while
 * the command it produces executes outside the root. Walking up to the deepest
 * existing ancestor resolves every real component, then re-appends the missing
 * tail to that canonical base.
 *
 * Returns null when not even the working directory resolves.
 */
export async function resolveDeepestAncestor(
  canonicalWorkdir: string,
  relativeTarget: string,
  resolvePath: (path: string) => Promise<string>,
): Promise<string | null> {
  const segments = relativeTarget.split(sep).filter((segment) => segment.length > 0);
  for (let depth = segments.length - 1; depth >= 0; depth -= 1) {
    const ancestor = resolve(canonicalWorkdir, ...segments.slice(0, depth));
    let resolvedAncestor: string;
    try {
      resolvedAncestor = await resolvePath(ancestor);
    } catch {
      continue;
    }
    return resolve(resolvedAncestor, ...segments.slice(depth));
  }
  return null;
}
