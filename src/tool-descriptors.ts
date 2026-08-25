import { Type } from "typebox";
import { quote } from "shell-quote";
import { sanitizeAuditText } from "./action-egress.js";
import { canonicalizeWorkdir, containPath } from "./path-containment.js";
import { projectChecks, type ProjectCheck, type ProjectProfile } from "./project-detect.js";
import {
  containedPathSchema,
  isRenderFailure,
  projectCheckSchema,
  ToolRegistry,
  type RenderedInvocation,
  type ToolDescriptor,
  type ToolRenderContext,
  type ToolRenderFailure,
} from "./tool-catalog.js";

/**
 * The descriptors for the capabilities that already exist.
 *
 * Written to be behaviour-identical to the `switch (kind)` in `action-planner.ts`, so the
 * existing planner and admission tests hold against descriptors *before* anything switches
 * over to them. Where a rendered invocation differs from what the switch produced, the
 * difference is called out in a comment on the descriptor rather than left for a diff to
 * reveal.
 *
 * The one intentional change: `inspect_error` no longer resolves its command from the
 * hardcoded `REINSPECT_COMMANDS` table, which said `bun` on every project. It reads the
 * command the project itself declares. A project that declares nothing gets no such tool
 * registered, which is why the registry is built per run rather than once per process.
 */

/** The gateway capability every command-shaped tool routes through. */
const RUN_COMMAND_TOOL = "run_command";

export interface BuildRegistryOptions {
  /** What this project declares it can run. Absent means no check-backed tools. */
  readonly project?: ProjectProfile;
}

/**
 * The tools one run may propose, in prompt order.
 *
 * Registration order is deliberate and is the order a model sees them listed: the
 * path-scoped test run first because it is the most common useful proposal, the
 * project-wide check second, the outbound search last because it is the only one that
 * leaves the machine.
 *
 * A check-backed tool is registered only when the project declares at least one check.
 * Registering it unconditionally and failing at render time would put a capability in the
 * prompt that can never succeed, and a model that proposes it would be scored as wrong for
 * following the catalog it was given.
 */
export function buildToolRegistry(options: BuildRegistryOptions = {}): ToolRegistry {
  const descriptors: ToolDescriptor[] = [runTestsDescriptor()];

  const available = declaredChecks(options.project);
  if (available.length > 0) descriptors.push(runCheckDescriptor(available));

  descriptors.push(searchSelectionDescriptor());
  return new ToolRegistry(descriptors);
}

/** Checks the project actually declares, in a stable order. */
export function declaredChecks(project: ProjectProfile | undefined): readonly ProjectCheck[] {
  if (project === undefined) return [];
  return projectChecks.filter((check) => project.commands[check] !== undefined);
}

/**
 * Runs the project's test command against one contained path.
 *
 * The command comes from `detectProject` rather than the literal `bun test` the switch
 * hardcoded. The path is appended after `--` so a runner treats it as a filter rather than
 * as one of its own flags — which is what the switch did too, and is the reason the path
 * must be relative: an argv element beginning with `-` or `/` would be read as an option or
 * as an absolute location outside the project.
 */
function runTestsDescriptor(): ToolDescriptor {
  return {
    id: "run_tests",
    title: "Run the project's tests for one file",
    category: "run_tests",
    parameters: containedPathSchema,
    risk: "mutates_workspace",
    confirmation: "required",
    async render(args, context): Promise<RenderedInvocation | ToolRenderFailure> {
      const path = args.path;
      if (typeof path !== "string" || path.trim().length === 0) {
        return { reasonCode: "arguments_invalid" };
      }
      const testCommand = context.project?.commands.test;
      if (testCommand === undefined || testCommand.length === 0) {
        return { reasonCode: "command_unavailable" };
      }

      const contained = await containPath(path, context.workingDirectory, context.resolvePath);
      if ("reasonCode" in contained) return { reasonCode: contained.reasonCode };

      const argv = [...testCommand, "--", contained.relativeTarget];
      return {
        tool: RUN_COMMAND_TOOL,
        argv,
        // The summary is the exact command, because that is what the user approves. Built
        // from canonical values only — the model's original string never appears in it, so
        // an approved summary cannot describe a different file than the one that runs.
        summary: renderCommandSummary(contained.canonicalWorkingDirectory, argv),
        canonicalWorkingDirectory: contained.canonicalWorkingDirectory,
        canonicalTarget: contained.canonicalTarget,
      };
    },
  };
}

/**
 * Re-runs one of the project's declared checks, project-wide.
 *
 * This is what `inspect_error` was, with the hardcoded table removed. The model names a
 * check — "the lint check" — and which command that is comes from the project. A model
 * naming the command itself would be a model choosing what executes on the machine from a
 * string it composed, which is the thing the argv discipline exists to prevent.
 *
 * `install`, `vcs`, and `container` work has no descriptor at all, rather than a descriptor
 * that refuses: the catalog is the vocabulary, so an absent capability cannot be proposed
 * and then declined. A failed deploy has no way to propose running itself again.
 */
function runCheckDescriptor(available: readonly ProjectCheck[]): ToolDescriptor {
  return {
    id: "run_check",
    title: "Re-run one of the project's checks",
    category: "inspect_error",
    parameters: projectCheckSchema(available),
    risk: "mutates_workspace",
    confirmation: "required",
    async render(args, context): Promise<RenderedInvocation | ToolRenderFailure> {
      const check = args.check;
      if (typeof check !== "string" || !available.includes(check as ProjectCheck)) {
        return { reasonCode: "arguments_invalid" };
      }
      const command = context.project?.commands[check as ProjectCheck];
      if (command === undefined || command.length === 0) {
        // Reachable when the registry was built against one project profile and rendered
        // against another. Refusing beats falling back to a different check.
        return { reasonCode: "command_unavailable" };
      }

      const workdir = await canonicalizeWorkdir(context.workingDirectory, context.resolvePath);
      if ("reasonCode" in workdir) return { reasonCode: workdir.reasonCode };

      const argv = [...command];
      return {
        tool: RUN_COMMAND_TOOL,
        argv,
        summary: renderCommandSummary(workdir.canonicalWorkingDirectory, argv),
        canonicalWorkingDirectory: workdir.canonicalWorkingDirectory,
        // No path argument, so there is no path boundary for the gateway to re-verify. Null
        // is the signal for that, not a missing field.
        canonicalTarget: null,
      };
    },
  };
}

/**
 * Searches the web for the user's current selection.
 *
 * The only `external` tool, and the only one whose arguments carry user text. The selection
 * reaches the gateway in `arguments` and never reaches the summary: the summary states the
 * selection's length instead, because a summary is logged and a selection may be a
 * password, a customer name, or a private key.
 */
function searchSelectionDescriptor(): ToolDescriptor {
  return {
    id: "search_selection",
    title: "Search the web for the current selection",
    category: "search_selection",
    parameters: Type.Object({
      selection: Type.String({ minLength: 1, maxLength: 4096 }),
    }, { additionalProperties: false }),
    risk: "external",
    // Nothing local executes and nothing is written; the egress policy, not a prompt,
    // decides whether this may leave the machine.
    confirmation: "none",
    async render(args): Promise<RenderedInvocation | ToolRenderFailure> {
      const selection = args.selection;
      if (typeof selection !== "string" || selection.trim().length === 0) {
        return { reasonCode: "arguments_invalid" };
      }
      const measured = sanitizeAuditText(selection, "selection");
      return {
        tool: "search_web",
        arguments: { query: selection },
        summary: `Search the web for a ${measured.originalLength}-character selection`,
        canonicalWorkingDirectory: null,
        canonicalTarget: null,
      };
    },
  };
}

/**
 * The operator-facing text for a command-shaped invocation.
 *
 * Shell-quoted even though nothing is executed through a shell, because this string is read
 * by a human who may copy it: an unquoted path with a space would paste as two arguments
 * and run something else. The quoting is presentation, not execution — `argv` carries the
 * truth.
 */
function renderCommandSummary(
  canonicalWorkingDirectory: string,
  argv: readonly string[],
): string {
  return `cd ${quote([canonicalWorkingDirectory])} && ${quote([...argv])}`;
}

export { isRenderFailure };
export type { ToolRenderContext };
