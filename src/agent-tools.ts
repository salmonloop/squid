import { Type } from "typebox";
import type { Static } from "typebox";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { EventStore } from "./event-store.js";
import { createTypeTextTool } from "./type-text-tool.js";
import type { TextTypingService } from "./text-typing-service.js";

export { createTypeTextTool, typeTextParams, type TypeTextArgs, type TypeTextToolDetails } from "./type-text-tool.js";

/**
 * The agent's window onto its own sensory record.
 *
 * The resident agent is prompted with the *current* world state on every turn,
 * but the event store holds the full history the projection was built from —
 * and nothing let it look back. These tools expose that history as Pi custom
 * tools, so the agent queries its senses the way it queries a file: by calling
 * a tool, in its own sandbox, with the call and result recorded in its session
 * history like every other action.
 *
 * Read-only by construction: the store is handed over as a narrowed query
 * surface, not as a mutable capability. What the agent can and cannot see is
 * the store's own deletion semantics — a retention prune removes history from
 * here too, which is the same promise the panel makes.
 */

const recentEventsParams = Type.Object({
  limit: Type.Optional(
    Type.Integer({
      description: "Maximum events to return, most recent last. Default 20, maximum 100.",
      minimum: 1,
      maximum: 100,
    }),
  ),
  kind: Type.Optional(
    Type.String({
      description:
        'Only events of this kind (e.g. "application_activated", "text_context_changed"). ' +
        "Omit to return all kinds.",
    }),
  ),
  since: Type.Optional(
    Type.String({
      description: "ISO-8601 timestamp; only events at or after it are returned.",
    }),
  ),
});

interface RecentEventsArgs {
  limit?: number;
  kind?: string;
  since?: string;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

function textResult(text: string, count: number): AgentToolResult<{ count: number }> {
  return {
    content: [{ type: "text", text }],
    details: { count },
  };
}

/** Builds the query tool against one store. Exported for direct testing. */
export function queryRecentEventsTool(
  store: EventStore,
): ToolDefinition<typeof recentEventsParams, { count: number }> {
  // `defineTool` is Pi's own shim for exactly this: a concrete tool kept intact
  // when it joins a `ToolDefinition[]`, where the array's default type parameters
  // would otherwise widen the schema and the details to `unknown``.
  return defineTool({
    name: "query_recent_events",
    label: "Query recent events",
    description:
      "Read back recent activity events the sensors captured — the history behind the " +
      "current world state. Use it to look further back than the state snapshot shows, " +
      "or to check what happened while you were thinking.",
    promptSnippet:
      "query_recent_events: read the sensors' recent activity history (the events behind the world state)",
    parameters: recentEventsParams,
    execute: async (
      _toolCallId: string,
      params: Static<typeof recentEventsParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<{ count: number }>> => {
      const args = params as RecentEventsArgs;
      const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const sinceEvents =
        args.since !== undefined ? await store.since(args.since) : await store.all();
      const filtered =
        args.kind !== undefined ? sinceEvents.filter((e) => e.kind === args.kind) : sinceEvents;
      const selected = filtered.slice(-limit);
      return textResult(JSON.stringify(selected), selected.length);
    },
  });
}

/** The custom tools a resident agent gets for its own store and capabilities. */
export function agentCustomTools(
  store: EventStore,
  typingService?: TextTypingService,
): readonly ToolDefinition<any, any, any>[] {
  const tools: ToolDefinition<any, any, any>[] = [queryRecentEventsTool(store)];
  if (typingService !== undefined) {
    tools.push(createTypeTextTool(typingService));
  }
  return tools;
}
