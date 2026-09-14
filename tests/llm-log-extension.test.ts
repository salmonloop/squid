import { describe, expect, it } from "bun:test";
import { llmLogExtension, type LlmLogEntry } from "../src/llm-log-extension.js";

interface ExtensionObject {
  readonly name?: string;
  readonly hidden?: boolean;
  readonly factory: (pi: unknown) => void;
}

function asExtensionObject(ext: unknown): ExtensionObject {
  if (typeof ext === "object" && ext !== null && "factory" in ext) {
    return ext as ExtensionObject;
  }
  throw new Error("Expected extension object with factory");
}

describe("llmLogExtension", () => {
  it("creates an inline extension named squid-llm-log", () => {
    const ext = asExtensionObject(llmLogExtension(() => {}));
    expect(ext.name).toBe("squid-llm-log");
    expect(ext.hidden).toBe(true);
  });

  it("captures request metadata on before_provider_request and returns payload unchanged", () => {
    const entries: LlmLogEntry[] = [];
    const ext = asExtensionObject(llmLogExtension((entry) => entries.push(entry)));

    const handlers = new Map<string, (event: unknown) => unknown>();
    const mockPi = {
      on: (event: string, handler: (event: unknown) => unknown) => {
        handlers.set(event, handler);
      },
    };

    ext.factory(mockPi);

    const beforeHandler = handlers.get("before_provider_request");
    expect(beforeHandler).toBeDefined();

    const payload = {
      model: "test-model-id",
      messages: [{ role: "user", content: "hello" }],
    };

    const result = beforeHandler!({ payload });
    expect(result).toBe(payload);
    expect(entries.length).toBe(1);
    const entry = entries[0];
    expect(entry).toBeDefined();
    expect(entry?.id).toBe(1);
    expect(entry?.model).toBe("test-model-id");
    expect(entry?.messageCount).toBe(1);
    expect(entry?.outcome).toBe("pending");
    expect((entry?.promptChars ?? 0) > 0).toBe(true);
  });

  it("captures response status and computes duration on after_provider_response", () => {
    const entries: LlmLogEntry[] = [];
    const ext = asExtensionObject(llmLogExtension((entry) => entries.push(entry)));

    const handlers = new Map<string, (event: unknown) => unknown>();
    const mockPi = {
      on: (event: string, handler: (event: unknown) => unknown) => {
        handlers.set(event, handler);
      },
    };

    ext.factory(mockPi);

    const beforeHandler = handlers.get("before_provider_request")!;
    const afterHandler = handlers.get("after_provider_response")!;

    beforeHandler({ payload: { model: "m1", messages: [] } });
    expect(entries.length).toBe(1);
    expect(entries[0]?.outcome).toBe("pending");

    afterHandler({ status: 200, headers: {} });
    expect(entries.length).toBe(2);
    const res = entries[1];
    expect(res?.id).toBe(1);
    expect(res?.httpStatus).toBe(200);
    expect(res?.outcome).toBe("ok");
    expect(typeof res?.durationMs).toBe("number");
  });

  it("marks 4xx and 5xx responses as error", () => {
    const entries: LlmLogEntry[] = [];
    const ext = asExtensionObject(llmLogExtension((entry) => entries.push(entry)));

    const handlers = new Map<string, (event: unknown) => unknown>();
    const mockPi = {
      on: (event: string, handler: (event: unknown) => unknown) => {
        handlers.set(event, handler);
      },
    };

    ext.factory(mockPi);

    const beforeHandler = handlers.get("before_provider_request")!;
    const afterHandler = handlers.get("after_provider_response")!;

    beforeHandler({ payload: { model: "m2" } });
    afterHandler({ status: 401, headers: {} });

    expect(entries.length).toBe(2);
    const err = entries[1];
    expect(err?.outcome).toBe("error");
    expect(err?.httpStatus).toBe(401);
    expect(err?.error).toContain("401");
  });
});
