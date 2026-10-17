import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { InputSuggestionService } from "./input-suggestion.js";

export interface InputSuggestionExtensionOptions {
  readonly service: InputSuggestionService;
  readonly typeTextTool?: ToolDefinition<any, any, any> | undefined;
}

/**
 * Pi Agent InlineExtension for proactive input suggestions.
 *
 * Adheres strictly to the `@earendil-works/pi-coding-agent` ExtensionAPI specification.
 * Integrates the suggestion service lifecycle with the Pi Agent session and registers
 * the official `type_text` tool dynamically.
 */
export function inputSuggestionExtension(
  options: InputSuggestionExtensionOptions,
): InlineExtension {
  return {
    name: "squid-input-suggestion",
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      const toolToRegister = options.typeTextTool ?? options.service.getTypeTextTool?.();
      if (toolToRegister !== undefined) {
        pi.registerTool(toolToRegister);
      }

      pi.on("session_shutdown", () => {
        options.service.reset?.();
      });
    },
  };
}
