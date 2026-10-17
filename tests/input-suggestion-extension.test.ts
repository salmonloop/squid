import { describe, expect, it } from "bun:test";
import { inputSuggestionExtension } from "../src/input-suggestion-extension.js";
import { InputSuggestionService } from "../src/input-suggestion.js";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

describe("inputSuggestionExtension", () => {
  it("conforms to Pi InlineExtension interface and registers type_text tool", () => {
    let resetCount = 0;
    const fakeService = {
      reset: () => {
        resetCount++;
      },
      getTypeTextTool: () =>
        ({
          name: "type_text",
        }) as unknown as ToolDefinition,
    } as unknown as InputSuggestionService;

    const extension = inputSuggestionExtension({ service: fakeService });
    if (typeof extension === "function") {
      throw new Error("expected object extension");
    }

    expect(extension.name).toBe("squid-input-suggestion");
    expect(extension.hidden).toBe(true);

    const registeredTools: any[] = [];
    const eventHandlers: Record<string, () => void> = {};

    const fakePi = {
      registerTool: (tool: any) => {
        registeredTools.push(tool);
      },
      on: (event: string, handler: () => void) => {
        eventHandlers[event] = handler;
      },
    } as unknown as ExtensionAPI;

    extension.factory(fakePi);

    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0]?.name).toBe("type_text");

    // Test session_shutdown lifecycle hook
    expect(eventHandlers["session_shutdown"]).toBeDefined();
    eventHandlers["session_shutdown"]?.();
    expect(resetCount).toBe(1);
  });
});
