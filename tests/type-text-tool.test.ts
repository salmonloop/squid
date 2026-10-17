import { describe, expect, it } from "bun:test";
import { createTypeTextTool } from "../src/type-text-tool.js";
import { TextTypingService, type TextTypingTarget } from "../src/text-typing-service.js";

describe("createTypeTextTool", () => {
  it("defines standard Pi tool metadata and parameter schema", () => {
    const service = new TextTypingService();
    const tool = createTypeTextTool(service);

    expect(tool.name).toBe("type_text");
    expect(tool.label).toBe("Type text");
    expect(tool.description).toContain("Type text into the currently active");
    expect(tool.parameters).toBeDefined();
    expect(tool.parameters.type).toBe("object");
  });

  it("executes successfully through TextTypingService and returns AgentToolResult", async () => {
    const typedTargets: TextTypingTarget[] = [];
    const fakeService = {
      typeText: async (target: TextTypingTarget) => {
        typedTargets.push(target);
        return { ok: true };
      },
    } as unknown as TextTypingService;

    const tool = createTypeTextTool(fakeService);
    const result = await tool.execute(
      "call-1",
      {
        text: "hello world",
        targetWindowTitle: "Terminal",
        targetApplicationId: "kitty",
      },
      undefined,
      undefined,
      {} as any,
    );

    expect(result.content[0]).toEqual({
      type: "text",
      text: "Successfully typed 11 characters.",
    });
    expect(result.details).toEqual({
      ok: true,
      charsTyped: 11,
    });
    expect(typedTargets).toEqual([
      {
        text: "hello world",
        targetWindowTitle: "Terminal",
        targetApplicationId: "kitty",
      },
    ]);
  });

  it("returns error details when typing fails without throwing", async () => {
    const fakeService = {
      typeText: async () => {
        return { ok: false, error: "Window activation failed" };
      },
    } as unknown as TextTypingService;

    const tool = createTypeTextTool(fakeService);
    const result = await tool.execute(
      "call-2",
      { text: "failed text" },
      undefined,
      undefined,
      {} as any,
    );

    expect(result.content[0]?.type).toBe("text");
    expect((result.content[0] as any)?.text).toContain("Failed to type text: Window activation failed");
    expect(result.details).toEqual({
      ok: false,
      error: "Window activation failed",
    });
  });

  it("aborts when AbortSignal is already triggered", async () => {
    const controller = new AbortController();
    controller.abort();

    const fakeService = {
      typeText: async () => ({ ok: true }),
    } as unknown as TextTypingService;

    const tool = createTypeTextTool(fakeService);
    const result = await tool.execute(
      "call-3",
      { text: "aborted text" },
      controller.signal,
      undefined,
      {} as any,
    );

    expect(result.details).toEqual({
      ok: false,
      error: "Aborted",
    });
  });
});
