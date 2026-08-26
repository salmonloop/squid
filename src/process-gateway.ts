import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type {
  ActionResult,
  CapabilityGateway,
} from "./capability-gateway.js";
import { digestActionPlan, type ImmutableActionPlan } from "./action-plan.js";
import { resolveDeepestAncestor } from "./action-planner.js";
import { describeErrorForAudit, sanitizeAuditText } from "./action-egress.js";

export interface ProcessCapabilityGatewayOptions {
  /** Overrides `gateway.id`; defaults to "pi". */
  readonly id?: string;
  /** Injected in tests; defaults to the platform realpath. */
  readonly resolvePath?: (path: string) => Promise<string>;
}

/**
 * Executes one already-approved plan by handing it to a Pi agent session.
 *
 * Pi is the execution base: its own toolbelt (read, bash, edit, write) does the
 * work, and its extension/skill ecosystem widens what an action can do without
 * this file growing a registry. The gateway's job is the boundary around that
 * freedom:
 *
 * - It hands the session the plan's approved summary — the exact text a
 *   confirming user saw — plus nothing else. The model may choose *how* with
 *   whatever tools Pi exposes; it was told *what* by code.
 * - It records every tool call the session makes (`tool_execution_start`),
 *   so the audit trail shows not just that the action ran but everything the
 *   agent did along the way.
 * - Its only remaining judgment is a last-moment filesystem check before the
 *   session starts: a plan naming a canonical directory and target must still
 *   resolve inside that directory, which catches a symlink swapped in between
 *   planning and execution. Verify only — never re-plan.
 *
 * The execution model is the same one prediction uses (PI_MODEL_PROVIDER /
 * PI_MODEL_ID); a run without a reachable model predicts with the heuristic and
 * executes nothing — every action fails with a stated reason rather than
 * pretending to act.
 */
export class ProcessCapabilityGateway implements CapabilityGateway {
  public readonly id: string;
  private readonly resolvePath: (path: string) => Promise<string>;
  private readonly modelRuntimePromise: Promise<ModelRuntime>;

  public constructor(options: ProcessCapabilityGatewayOptions = {}) {
    this.id = options.id ?? "pi";
    this.resolvePath = options.resolvePath ?? ((path: string) => realpath(path));
    this.modelRuntimePromise = ModelRuntime.create({ allowModelNetwork: false });
  }

  public async invoke(plan: ImmutableActionPlan): Promise<ActionResult> {
    const planDigest = digestActionPlan(plan);

    const boundary = await this.verifyPathBoundary(plan);
    if (boundary !== null) {
      return { planDigest, outcome: "failed", error: boundary };
    }

    try {
      const outcome = await this.runSession(plan);
      return {
        planDigest,
        outcome: outcome.error === undefined ? "succeeded" : "failed",
        ...(outcome.summary !== undefined ? { details: { tool: plan.tool, summary: outcome.summary } } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      };
    } catch (error) {
      // A session failure mid-run leaves the outcome unknown — tools may have
      // already executed when the error landed. That is reconciliation
      // territory, not a fabricable failure, so it propagates for the
      // dispatcher to classify as reconciliation_required.
      throw error instanceof Error ? error : new Error(describeErrorForAudit(error));
    }
  }

  /**
   * One fresh session per invocation. Sessions are cheap (in-memory history)
   * and per-invocation isolation is the point: one action cannot inherit
   * another's context, and cleanup is whole-session disposal.
   *
   * The prompt is the approved summary verbatim — what the user read is what
   * the agent is asked to do — anchored in its working directory so relative
   * work starts where the plan canonicalized.
   */
  private async runSession(
    plan: ImmutableActionPlan,
  ): Promise<{ readonly summary?: string; readonly error?: string }> {
    const modelRuntime = await this.modelRuntimePromise;
    const provider = process.env.PI_MODEL_PROVIDER ?? "bifrost";
    const modelId = process.env.PI_MODEL_ID ?? "deepseek-v4-flash";
    const model = modelRuntime.getModel(provider, modelId);
    if (!model) {
      return { error: `No execution model is configured: ${provider}/${modelId}` };
    }

    // Skills and extensions stay on deliberately: they are how Pi's ecosystem
    // widens what an executed action can do. Prompt templates and themes are
    // presentation concerns this path has no use for; context files are the
    // project's own CLAUDE-style notes, which an executor working in that
    // project should read.
    const loader = new DefaultResourceLoader({
      cwd: plan.canonicalWorkingDirectory ?? process.cwd(),
      agentDir: getAgentDir(),
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: [
        "You are Squid's action executor.",
        "Complete exactly the task you are given, then stop.",
        "Stay inside the working directory you were started in unless the task itself names elsewhere.",
        "Prefer the smallest change that completes the task; do not fix unrelated problems you notice.",
        "Report concisely what you did.",
      ].join("\n"),
      appendSystemPrompt: [],
    });
    await loader.reload();

    const { session } = await createAgentSession({
      model,
      modelRuntime,
      resourceLoader: loader,
      // A scoped single-task execution needs no deep reasoning, and the
      // endpoint's time-to-first-byte is already seconds. Matches prediction.
      thinkingLevel: "low",
      sessionManager: SessionManager.inMemory(),
    });

    let toolCalls = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") toolCalls += 1;
    });

    try {
      const task = [
        `Working directory: ${plan.canonicalWorkingDirectory ?? "(none)"}`,
        `Task: ${plan.summary}`,
      ].join("\n");
      await session.prompt(task);
      await session.waitForIdle();
      if (toolCalls === 0) {
        // A settled session that never called a tool did not do the work.
        return { error: "The executor completed without performing any action." };
      }
      const summary = session.getLastAssistantText();
      const sanitized = summary === undefined
        ? undefined
        : sanitizeAuditText(summary, "mcp_summary");
      return {
        ...(sanitized !== undefined && sanitized.text.length > 0 ? { summary: sanitized.text } : {}),
      };
    } finally {
      unsubscribe();
      await session.abort().catch(() => undefined);
      session.dispose();
    }
  }

  /**
   * Re-resolves the plan's canonical paths immediately before the call.
   *
   * Returns a refusal reason, or null when the plan still holds. Plans without
   * filesystem scope have nothing to verify.
   */
  private async verifyPathBoundary(plan: ImmutableActionPlan): Promise<string | null> {
    const root = plan.canonicalWorkingDirectory;
    const target = plan.canonicalTarget;
    if (root === null || target === null) return null;

    let resolvedRoot: string;
    try {
      resolvedRoot = await this.resolvePath(root);
    } catch {
      return "The plan's working directory no longer resolves.";
    }
    if (resolvedRoot !== root) {
      return "The plan's working directory changed since it was approved.";
    }
    // A target that does not exist yet is legitimate — the plan may name a file
    // the run creates — but its directories still decide containment, so this
    // resolves the deepest existing ancestor rather than trusting the literal
    // path. Same helper the planner used, so the two boundaries cannot drift.
    const relativeTarget = relative(resolvedRoot, target);
    if (relativeTarget.length === 0 || isAbsolute(relativeTarget)
      || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
      return "The plan's target no longer resolves inside its working directory.";
    }
    const canonical = await resolveDeepestAncestor(
      resolvedRoot,
      relativeTarget,
      (path) => this.resolvePath(path),
    );
    if (canonical === null) {
      return "The plan's target no longer resolves.";
    }
    const containment = relative(resolvedRoot, canonical);
    if (
      containment === ".." ||
      containment.startsWith(`..${sep}`) ||
      isAbsolute(containment)
    ) {
      return "The plan's target no longer resolves inside its working directory.";
    }
    return null;
  }
}
