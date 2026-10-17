import { Type } from "typebox";
import type { Static } from "typebox";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { TextTypingService, type TextTypingTarget } from "./text-typing-service.js";

/**
 * Parameters for the standard Pi Agent `type_text` tool.
 */
export const typeTextParams = Type.Object({
  text: Type.String({
    description: "The text to type into the focused text target.",
  }),
  targetWindowTitle: Type.Optional(
    Type.String({
      description: "Optional window title to activate before typing.",
    }),
  ),
  targetApplicationId: Type.Optional(
    Type.String({
      description: "Optional application name or process identifier to activate before typing.",
    }),
  ),
});

export type TypeTextArgs = Static<typeof typeTextParams>;

export interface TypeTextToolDetails {
  ok: boolean;
  charsTyped?: number;
  error?: string;
}

/**
 * Creates the official Pi Agent ToolDefinition for typing text into desktop fields.
 *
 * Wraps `TextTypingService` to satisfy the official `@earendil-works/pi-coding-agent`
 * tool specification, standardizing argument validation, execution, and result formatting.
 */
export function createTypeTextTool(
  service: TextTypingService,
): ToolDefinition<typeof typeTextParams, TypeTextToolDetails> {
  return defineTool({
    name: "type_text",
    label: "Type text",
    description:
      "Type text into the currently active or specified desktop text target (input box, editor, or terminal). " +
      "Reactivates the target window when specified to avoid dropping focus.",
    promptSnippet: "type_text: inject text into active desktop input target",
    parameters: typeTextParams,
    execute: async (
      _toolCallId: string,
      params: TypeTextArgs,
      signal: AbortSignal | undefined,
      _onUpdate: undefined,
      _ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<TypeTextToolDetails>> => {
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Text typing aborted." }],
          details: { ok: false, error: "Aborted" },
        };
      }

      const target: TextTypingTarget = {
        text: params.text,
        ...(params.targetWindowTitle !== undefined ? { targetWindowTitle: params.targetWindowTitle } : {}),
        ...(params.targetApplicationId !== undefined ? { targetApplicationId: params.targetApplicationId } : {}),
      };

      const result = await service.typeText(target);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to type text: ${result.error ?? "unknown error"}` }],
          details: {
            ok: false,
            ...(result.error !== undefined ? { error: result.error } : {}),
          },
        };
      }

      return {
        content: [{ type: "text", text: `Successfully typed ${params.text.length} characters.` }],
        details: { ok: true, charsTyped: params.text.length },
      };
    },
  });
}
