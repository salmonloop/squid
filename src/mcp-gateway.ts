import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  PredictionCandidate,
  PredictionKind,
} from "./protocol.js";
import type {
  ActionRequest,
  ActionResult,
  CapabilityGateway,
} from "./capability-gateway.js";

/**
 * The subset of prediction kinds Squid can dispatch to an MCP server today.
 * Each maps to exactly one MCP tool with a fixed parameter contract, so the
 * mapping table below is exhaustive over this union and a candidate of any
 * other kind is refused rather than guessed at.
 */
const mappableKinds = ["search_selection", "run_tests"] as const satisfies readonly PredictionKind[];
type MappableKind = (typeof mappableKinds)[number];

interface ToolMapping {
  readonly tool: string;
  /**
   * Derives the tool's arguments from candidate parameters. Returning
   * undefined means the candidate lacks what this tool needs and is refused.
   */
  readonly buildArguments: (
    parameters: PredictionCandidate["parameters"],
  ) => Record<string, string | number | boolean | null> | undefined;
}

/**
 * One row per mappable kind. `search_selection` opens the selection in a
 * browser search; `run_tests` runs the test command for a saved path. Both
 * tools are expected to be read-mostly and side-effect-bounded — they launch
 * or navigate, they do not write files.
 *
 * The argument keys are the *gateway's* contract, not the predictors': the
 * heuristic emits `{selection}` for search_selection and `{path}` for
 * run_tests, so the mapping derives tool arguments from candidate parameters
 * rather than forwarding keys that no producer sets.
 */
const toolMappings: Record<MappableKind, ToolMapping> = {
  search_selection: {
    tool: "search_web",
    buildArguments: (parameters) => {
      const selection = parameters.selection;
      if (typeof selection !== "string" || selection.trim().length === 0) {
        return undefined;
      }
      return { query: selection };
    },
  },
  run_tests: {
    tool: "run_command",
    buildArguments: (parameters) => {
      const path = parameters.path;
      if (typeof path !== "string" || path.length === 0) {
        return undefined;
      }
      return { command: `bun test ${path}` };
    },
  },
};

export interface McpCapabilityGatewayOptions {
  /**
   * An already-connected MCP client. The gateway owns no transport lifecycle:
   * connecting (stdio, HTTP, in-memory) is the entry point's job, because
   * transports differ per deployment while this mapping does not.
   */
  readonly client: Client;
  /** Overrides `gateway.id`; defaults to the client's server-provided name if any. */
  readonly id?: string;
}

function isMappableKind(kind: PredictionKind): kind is MappableKind {
  return (mappableKinds as readonly string[]).includes(kind);
}

/**
 * Maps accepted prediction candidates onto calls to a connected MCP server.
 *
 * The gateway stays deliberately thin: it translates one candidate to one
 * tool call using the table above and reports what happened. It does not
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

  public constructor(options: McpCapabilityGatewayOptions) {
    this.client = options.client;
    this.id = options.id ?? "mcp";
  }

  public async invoke(request: ActionRequest): Promise<ActionResult> {
    const mapping = this.resolveMapping(request);
    if (typeof mapping === "string") {
      return this.refuse(request.candidateId, mapping);
    }

    const args = mapping.buildArguments(request.parameters);
    if (args === undefined) {
      return this.refuse(
        request.candidateId,
        `Candidate parameters do not satisfy the ${mapping.tool} contract.`,
      );
    }

    let result;
    try {
      result = await this.client.callTool(
        { name: mapping.tool, arguments: args },
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
      ...(summary !== undefined ? { details: { tool: mapping.tool, summary } } : {}),
    };
  }

  private resolveMapping(request: ActionRequest): ToolMapping | string {
    if (!isMappableKind(request.kind)) {
      return `No MCP tool mapping exists for prediction kind "${request.kind}".`;
    }
    return toolMappings[request.kind];
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
