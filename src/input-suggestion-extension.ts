import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Resettable } from "./input-suggestion.js";

export interface InputSuggestionExtensionOptions {
  readonly typeTextTool?: ToolDefinition<any, any, any> | undefined;
  readonly lifecycle?: Resettable | undefined;
  readonly service?: (Resettable & { getTypeTextTool?: () => ToolDefinition<any, any, any> }) | undefined;
}

/**
 * Pi Agent InlineExtension for desktop text typing & proactive input suggestions.
 *
 * Adheres strictly to the `@earendil-works/pi-coding-agent` ExtensionAPI specification.
 * Dynamically registers the official `type_text` tool and ties lifecycle cleanup to
 * `session_shutdown`.
 */
export function inputSuggestionExtension(
  options: InputSuggestionExtensionOptions,
): InlineExtension {
  return {
    name: "squid-input-suggestion",
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      const toolToRegister = options.typeTextTool ?? options.service?.getTypeTextTool?.();
      if (toolToRegister !== undefined) {
        pi.registerTool(toolToRegister);
      }

      const targetLifecycle = options.lifecycle ?? options.service;
      if (targetLifecycle?.reset) {
        pi.on("session_shutdown", () => {
          targetLifecycle.reset();
        });
      }
    },
  };
}
