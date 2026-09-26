import { describe, expect, it } from "bun:test";
import { llmLogExtension, type LlmLogEntry } from "../src/llm-log-extension.js";
import { LLM_PREVIEW_MAX_LENGTH } from "../src/audit-text.js";

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

  it("carries a bounded content preview and re-emits it (and metadata) on completion", () => {
    const entries: LlmLogEntry[] = [];
    const ext = asExtensionObject(llmLogExtension((entry) => entries.push(entry)));
    const handlers = new Map<string, (event: unknown) => unknown>();
    ext.factory({ on: (event: string, handler: (event: unknown) => unknown) => handlers.set(event, handler) });
    const beforeHandler = handlers.get("before_provider_request")!;
    const afterHandler = handlers.get("after_provider_response")!;

    beforeHandler({
      payload: {
        model: "m3",
        messages: [
          { role: "system", content: "you are squid" },
          { role: "user", content: "look at this" },
        ],
      },
    });
    const pending = entries[0];
    expect(pending?.preview).toContain("[user] look at this");
    expect(pending?.preview?.startsWith("(2 msgs)")).toBe(true);

    afterHandler({ status: 200, headers: {} });
    const done = entries[1];
    // The completed line re-emits model/count/preview, because the panel upserts
    // a row by id wholesale — a finished line without them would blank the row.
    expect(done?.model).toBe("m3");
    expect(done?.messageCount).toBe(2);
    expect(done?.preview).toBe(pending?.preview);
    expect(done?.outcome).toBe("ok");
  });

  it("bounds the preview to the preview ceiling for a huge payload", () => {
    const entries: LlmLogEntry[] = [];
    const ext = asExtensionObject(llmLogExtension((entry) => entries.push(entry)));
    const handlers = new Map<string, (event: unknown) => unknown>();
    ext.factory({ on: (event: string, handler: (event: unknown) => unknown) => handlers.set(event, handler) });
    const beforeHandler = handlers.get("before_provider_request")!;

    const huge = "x".repeat(500_000);
    beforeHandler({
      payload: {
        model: "m",
        messages: Array.from({ length: 200 }, () => ({ role: "user", content: huge })),
      },
    });
    const preview = entries[0]?.preview ?? "";
    // Capped at the preview ceiling plus the one-character truncation marker.
    expect(preview.length).toBeLessThanOrEqual(LLM_PREVIEW_MAX_LENGTH + 1);
  });
});
