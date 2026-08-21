import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  ActionRequest,
  ActionResult,
  CapabilityGateway,
} from "./capability-gateway.js";
import {
  isActionPlanFailure,
  planCapabilityAction,
  type CapabilityActionPlan,
  type CapabilityActionPlanFailure,
} from "./action-plan.js";

export interface McpCapabilityGatewayOptions {
  /**
   * An already-connected MCP client. The gateway owns no transport lifecycle:
   * connecting (stdio, HTTP, in-memory) is the entry point's job, because
   * transports differ per deployment while this mapping does not.
   */
  readonly client: Client;
  /** Overrides `gateway.id`; defaults to the client's server-provided name if any. */
  readonly id?: string;
  /** Directory in which a run_tests command executes. */
  readonly workingDirectory?: string;
}

/**
 * Maps accepted prediction candidates onto calls to a connected MCP server.
 *
 * The gateway stays deliberately thin: it executes the shared action plan
 * for one candidate and reports what happened. It does not
 * discover tools dynamically (a missing tool surfaces as a failed result),
 * does not retry, and does not interpret tool output beyond extracting a
 * text summary for ledger details.
 *
 * A protocol-level failure (`isError` on the result) and a thrown call both
 * become `outcome: "failed"` — from the dispatcher's point of view they are
 * the same thing: the operation did not happen.
 */
export class McpCapabilityGateway implements CapabilityGateway {
  public readonly id: string;
  private readonly client: Client;
  private readonly workingDirectory: string | undefined;

  public constructor(options: McpCapabilityGatewayOptions) {
    this.client = options.client;
    this.id = options.id ?? "mcp";
    this.workingDirectory = options.workingDirectory;
  }

  public plan(request: ActionRequest): CapabilityActionPlan | CapabilityActionPlanFailure {
    return planCapabilityAction(request.kind, request.parameters, {
      ...(this.workingDirectory === undefined ? {} : { workingDirectory: this.workingDirectory }),
    });
  }

  public async invoke(request: ActionRequest): Promise<ActionResult> {
    const plan = this.plan(request);
    if (isActionPlanFailure(plan)) {
      return this.refuse(request.candidateId, plan.error);
    }

    let result;
    try {
      result = await this.client.callTool(
        { name: plan.tool, arguments: plan.arguments },
        CallToolResultSchema,
      );
    } catch (error) {
      return {
        candidateId: request.candidateId,
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (result.isError === true) {
      return {
        candidateId: request.candidateId,
        outcome: "failed",
        error: summarizeContent(result.content) || "MCP tool reported an error.",
      };
    }

    const summary = summarizeContent(result.content);
    return {
      candidateId: request.candidateId,
      outcome: "succeeded",
      // `exactOptionalPropertyTypes`: omit the key rather than write undefined.
      ...(summary !== undefined ? { details: { tool: plan.tool, summary } } : {}),
    };
  }

  private refuse(candidateId: string, reason: string): ActionResult {
    return { candidateId, outcome: "failed", error: reason };
  }
}

/** Joins text content blocks into one short line for ledger details. */
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
    .join(" ")
    .trim();
  return text.length > 0 ? text.slice(0, 200) : undefined;
}
