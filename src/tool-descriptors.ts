import { resolve } from "node:path";
import { Type } from "typebox";
import { quote } from "shell-quote";
import type {
  AdmissionContext,
  AdmissionReasonCode,
  AdmissionResult,
} from "./action-admission.js";
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

/**
 * The classes a failed check may propose re-running itself.
 *
 * A subset of what terminal capture reports, because the exclusions are the
 * point: `install` touches the network and a lockfile, `vcs` rewrites history,
 * `container` can deploy — none of those may propose running themselves again.
 * `build` is excluded for a weaker but real reason carried over from the first
 * inspect_error implementation: it only rewrites build output, so re-running
 * it tells the user nothing the failure did not already. A project declaring
 * `scripts.build` therefore gets no run_check capability for build failures,
 * and the schema never offers the literal — a model cannot propose what the
 * catalog does not name.
 */
const REINSPECTABLE_CLASSES = ["test", "lint", "typecheck"] as const satisfies
  readonly ProjectCheck[];

/** Checks the project both declares and allows re-running, in a stable order. */
export function declaredChecks(project: ProjectProfile | undefined): readonly ProjectCheck[] {
  if (project === undefined) return [];
  return REINSPECTABLE_CLASSES.filter((check) => project.commands[check] !== undefined);
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
    // Bypassed by decision (issue #11): the closed loop is meant to act, and a
    // confirmation prompt on every prediction is the loop never closing. The
    // declaration stays a per-tool property rather than the confirmation code
    // being deleted — flipping this back to "required" restores prompting with
    // no other change anywhere.
    confirmation: "none",
    async render(args, context): Promise<RenderedInvocation | ToolRenderFailure> {
      const path = args.path;
      if (typeof path !== "string" || path.trim().length === 0) {
        return { reasonCode: "arguments_invalid" };
      }
      // Containment before capability: the path boundary is a security property,
      // so a bad proposal is refused on those grounds even where no runner
      // exists — and the workdir diagnostics keep their pre-catalog order.
      const contained = await containPath(path, context.workingDirectory, context.resolvePath);
      if ("reasonCode" in contained) return { reasonCode: contained.reasonCode };

      const testCommand = context.project?.commands.test;
      if (testCommand === undefined || testCommand.length === 0) {
        return { reasonCode: "command_unavailable" };
      }

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
    /**
     * Executes a command locally, so its admission checks are about identity of
     * the target: the same coding application must still be in front, and the
     * newest save must still be the file the plan was built for.
     */
    guard(context): AdmissionResult {
      const { state, plan } = context;
      const application = state.activeApplication;
      if (application === null || !isCodingApplication(application)) {
        return refuse("coding_application_mismatch");
      }
      const lastSave = state.recentActions.find((action) => action.kind === "file_saved");
      if (
        lastSave === undefined ||
        lastSave.applicationId === null ||
        lastSave.applicationId !== application.id
      ) {
        return refuse("coding_application_mismatch");
      }
      if (
        lastSave.target === null ||
        plan.canonicalTarget === null ||
        plan.canonicalWorkingDirectory === null
      ) {
        return refuse("saved_path_mismatch");
      }
      // Path identity, not a string suffix. `endsWith` would authorize any file whose
      // path merely *ends* with the saved one — saving `a.ts` would admit a plan
      // targeting `sub/xa.ts` — and it would accept a target reached through a
      // symlink, since the resolved path still ends with the saved name.
      const savedTarget = resolve(plan.canonicalWorkingDirectory, lastSave.target);
      if (plan.canonicalTarget !== savedTarget) return refuse("saved_path_mismatch");
      return { admitted: true };
    },
  };
}

/**
 * Re-runs one of the project's declared checks, project-wide.
 *
 * This is what `inspect_error` was, with the hardcoded table removed. The model names a
 * check class — "the lint class" — and which command that is comes from the project. A model
 * naming the command itself would be a model choosing what executes on the machine from a
 * string it composed, which is the thing the argv discipline exists to prevent.
 *
 * The argument is named `commandClass` rather than `check` because that is the name the
 * captured fact already travels under: terminal capture reports it, the ledger stores it
 * beside the outcome, and admission compares the plan against it. One name from capture to
 * descriptor means candidates feed this schema with zero translation.
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
    // Bypassed alongside run_tests (see its comment): same decision, same
    // single-line rollback.
    confirmation: "none",
    async render(args, context): Promise<RenderedInvocation | ToolRenderFailure> {
      const commandClass = args.commandClass;
      if (
        typeof commandClass !== "string"
        || !available.includes(commandClass as ProjectCheck)
      ) {
        return { reasonCode: "arguments_invalid" };
      }
      // Workdir before capability: same ordering rationale as run_tests — the
      // boundary diagnostics are a property of the request, the command table
      // is a property of the environment.
      const workdir = await canonicalizeWorkdir(context.workingDirectory, context.resolvePath);
      if ("reasonCode" in workdir) return { reasonCode: workdir.reasonCode };

      const command = context.project?.commands[commandClass as ProjectCheck];
      if (command === undefined || command.length === 0) {
        // Reachable when the registry was built against one project profile and rendered
        // against another. Refusing beats falling back to a different check.
        return { reasonCode: "command_unavailable" };
      }

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
    /**
     * Re-runs a failed check, so its admission checks are about the failure
     * still being the current one.
     *
     * The class must match what the plan was built for, and the command must
     * still be *failing*. The second condition is the one that matters in
     * practice: a user who fixes the problem and re-runs successfully before
     * confirming should not then have the old failure's re-run executed.
     * Success is not a smaller version of failure — it is the reason to drop
     * the action.
     */
    guard(context): AdmissionResult {
      const { state, candidate } = context;
      const outcome = state.lastCommandOutcome;
      if (outcome === null) return refuse("command_outcome_missing");
      // Compared against the candidate rather than the plan: the plan holds a
      // quoted command string, and re-parsing it to recover the class would be a
      // second implementation of a mapping that already exists.
      if (candidate?.parameters.commandClass !== outcome.commandClass) {
        return refuse("command_outcome_changed");
      }
      if (outcome.succeeded) return refuse("command_succeeded");
      return { admitted: true };
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
    /**
     * Search sends user text off the machine, so its checks are the strictest:
     * egress must be explicitly allowed, the selection must still be exactly
     * what was predicted on, and whoever produced the text, whoever owns the
     * page, and whoever holds the foreground must agree — any disagreement
     * means the selection belongs to a document that is no longer shown.
     */
    guard(context): AdmissionResult {
      const { state, candidate, plan } = context;
      // Whether this may leave the machine is the egress policy's decision, and
      // it comes first: nothing else about the proposal matters if the answer
      // is no.
      if (context.egressPolicy.searchEgress !== "allow") return refuse("search_egress_denied");

      const text = state.textContext;
      const page = state.currentBrowserPage;
      if (text === null || text.selection.trim().length === 0) return refuse("selection_empty");
      if (page === null) return refuse("browser_page_missing");

      const predicted = candidate?.parameters.selection;
      if (typeof predicted !== "string" || predicted !== text.selection) {
        // A strict prefix is the shape redaction leaves: the policy caps the
        // selection it shows a provider, so a model proposing from that view
        // carries the head of the truth, not a different selection. Still
        // refused — sending the first half of what someone selected is not
        // searching their selection — but named for its cause rather than
        // folded into a generic mismatch (issue #9).
        if (
          typeof predicted === "string"
          && predicted.length > 0
          && predicted.length < text.selection.length
          && text.selection.startsWith(predicted)
        ) {
          return refuse("selection_truncated");
        }
        return refuse("selection_changed");
      }
      if (plan.arguments.query !== text.selection) return refuse("selection_changed");

      const foreground = state.focus === null
        ? null
        : { applicationId: state.focus.applicationId, windowTitle: state.focus.windowTitle };
      if (!sameOwner(text.owner, page.owner) || !sameOwner(text.owner, foreground)) {
        return refuse("owner_mismatch");
      }
      // A selection older than the current page was made against a document
      // that is no longer shown, whatever its text says.
      if (text.observationOrdinal <= page.observationOrdinal) return refuse("observation_out_of_order");
      return { admitted: true };
    },
  };
}

/**
 * Every built-in descriptor, including tools a given project cannot render.
 *
 * Admission looks guards up here rather than in the run's own registry: the
 * guards are pure world-state checks that never touch the project profile, and
 * a stored plan for a check-backed tool must still find its guard even after
 * the project stops declaring that check. Refusing such a plan on
 * `plan_kind_unsupported` would misreport "the world moved" as "the capability
 * vanished".
 */
/**
 * Built once. The guards are pure world-state checks over module constants, so
 * every construction would be identical — and admitAction runs inside the
 * serial projection critical section, where per-call allocation of three
 * descriptors and a four-literal schema union blocks concurrent ingests for
 * work whose answer never changes.
 */
const ADMISSION_DESCRIPTORS: readonly ToolDescriptor[] = [
  runTestsDescriptor(),
  runCheckDescriptor(REINSPECTABLE_CLASSES),
  searchSelectionDescriptor(),
];

export function admissionDescriptors(): readonly ToolDescriptor[] {
  return ADMISSION_DESCRIPTORS;
}

/**
 * The operator-facing text for a command-shaped invocation.
 *
 * Shell-quoted even though nothing is executed through a shell, because this string is read
 * by a human who may copy it: an unquoted path with a space would paste as two arguments
 * and run something else. The quoting is presentation, not execution — `argv` carries the
 * truth.
 *
 * Exported because the plan's `arguments.command` must be byte-identical to the summary
 * the user approved: one function produces both, so they cannot drift.
 */
export function renderCommandSummary(
  canonicalWorkingDirectory: string,
  argv: readonly string[],
): string {
  return `cd ${quote([canonicalWorkingDirectory])} && ${quote([...argv])}`;
}

/**
 * Whether the foreground application is a coding application, decided on its
 * *name* and never its id. The id is whatever the platform reports it as — on
 * macOS the screen reader reports a bare unix pid ("4242"), which cannot carry
 * the "code" signal — while the name is the one field that describes what kind
 * of application this is. Matching on the id would make every real macOS run
 * fail here regardless of what is actually in front.
 */
function isCodingApplication(application: { id: string; name: string }): boolean {
  return /code/i.test(application.name);
}

function sameOwner(
  left: { applicationId: string; windowTitle: string } | null,
  right: { applicationId: string; windowTitle: string } | null,
): boolean {
  if (left === null || right === null) return false;
  return left.applicationId === right.applicationId && left.windowTitle === right.windowTitle;
}

function refuse(reasonCode: AdmissionReasonCode): AdmissionResult {
  return { admitted: false, reasonCode };
}

