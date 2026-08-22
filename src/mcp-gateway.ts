import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type {
  ActionResult,
  CapabilityGateway,
} from "./capability-gateway.js";
import { digestActionPlan, type ImmutableActionPlan } from "./action-plan.js";
import { sanitizeAuditText } from "./action-egress.js";

export interface McpCapabilityGatewayOptions {
  /**
   * An already-connected MCP client. The gateway owns no transport lifecycle:
   * connecting (stdio, HTTP, in-memory) is the entry point's job, because
   * transports differ per deployment while this mapping does not.
   */
  readonly client: Client;
  /** Overrides `gateway.id`; defaults to "mcp". */
  readonly id?: string;
  /** Injected in tests; defaults to the platform realpath. */
  readonly resolvePath?: (path: string) => Promise<string>;
}

/**
 * Executes one already-approved plan against a connected MCP server.
 *
 * The gateway does no planning. It receives the exact tool and arguments the
 * planner fixed and the user approved, so a model can never choose what runs.
 * Its only remaining judgment is a last-moment filesystem check: a plan naming a
 * canonical directory and target must still resolve inside that directory, which
 * catches a symlink swapped in between planning and execution.
 *
 * That check may only *verify* the plan it was given — never re-plan. If the
 * paths no longer agree, the answer is a refusal, not a corrected command.
 */
export class McpCapabilityGateway implements CapabilityGateway {
  public readonly id: string;
  private readonly client: Client;
  private readonly resolvePath: (path: string) => Promise<string>;

  public constructor(options: McpCapabilityGatewayOptions) {
    this.client = options.client;
    this.id = options.id ?? "mcp";
    this.resolvePath = options.resolvePath ?? ((path: string) => realpath(path));
  }

  public async invoke(plan: ImmutableActionPlan): Promise<ActionResult> {
    const planDigest = digestActionPlan(plan);

    const boundary = await this.verifyPathBoundary(plan);
    if (boundary !== null) {
      return { planDigest, outcome: "failed", error: boundary };
    }

    let result;
    try {
      result = await this.client.callTool(
        { name: plan.tool, arguments: { ...plan.arguments } },
        CallToolResultSchema,
      );
    } catch (error) {
      // Rethrown, not converted: a transport failure means the tool may have
      // run. Only the dispatcher may decide what an unknown outcome means, and
      // its answer is reconciliation, never a fabricated failure.
      throw error instanceof Error ? error : new Error(String(error));
    }

    if (result.isError === true) {
      const summary = summarizeContent(result.content);
      return {
        planDigest,
        outcome: "failed",
        error: summary ?? "MCP tool reported an error.",
      };
    }

    const summary = summarizeContent(result.content);
    return {
      planDigest,
      outcome: "succeeded",
      // `exactOptionalPropertyTypes`: omit the key rather than write undefined.
      ...(summary !== undefined ? { details: { tool: plan.tool, summary } } : {}),
    };
  }

  /**
   * Re-resolves the plan's canonical paths immediately before the call.
   *
   * Returns a refusal reason, or null when the plan still holds. Plans without
   * filesystem scope (a web search) have nothing to verify.
   */
  private async verifyPathBoundary(plan: ImmutableActionPlan): Promise<string | null> {
    const root = plan.canonicalWorkingDirectory;
    const target = plan.canonicalTarget;
    if (root === null || target === null) return null;

    let resolvedRoot: string;
    let resolvedTarget: string;
    try {
      resolvedRoot = await this.resolvePath(root);
    } catch {
      return "The plan's working directory no longer resolves.";
    }
    if (resolvedRoot !== root) {
      return "The plan's working directory changed since it was approved.";
    }
    try {
      resolvedTarget = await this.resolvePath(target);
    } catch {
      // A target that does not exist yet is legitimate — the plan was built for
      // a file the tests may create — as long as it stays inside the root.
      resolvedTarget = target;
    }
    const containment = relative(resolvedRoot, resolvedTarget);
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

/**
 * Reduces tool output to one sanitized line for ledger details.
 *
 * MCP output is untrusted text from another process, so it goes through the same
 * audit sanitizer as everything else that reaches a log: control characters
 * stripped, credentials redacted, length capped.
 */
function summarizeContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block
        ? String((block as { text: unknown }).text)
        : "",
    )
    .filter((line) => line.length > 0)
    .join(" ");
  if (text.trim().length === 0) return undefined;
  const sanitized = sanitizeAuditText(text, "mcp_summary");
  return sanitized.text.length > 0 ? sanitized.text : undefined;
}
