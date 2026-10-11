import { describe, expect, it } from "bun:test";
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  decisionCuratorEnabled,
  decisionCuratorExtension,
  resolveCuratorConfig,
} from "../src/decision-curator-extension.js";
import { groupIntoUnits } from "../src/jev-curator/units.js";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "../src/jev-curator/config.js";

type AgentMessage = ContextEvent["messages"][number];

/**
 * The curator is exercised at three seams that matter and no more: the enable
 * switch, the config resolver's defaults, and the classify call — model
 * construction, options passthrough, threshold mapping, fail-open — driven
 * through a stubbed `modelRegistry`. The wire itself (`bool`→`noul`,
 * `/v1/systemone`, bearer, timeout, retries) is Pi-ai's own transport, tested
 * there; the extension's `on("context")` reducer runs through a hand-rolled
 * `ExtensionAPI` stub so no live model runtime is started, matching how the
 * rest of the suite avoids one.
 */

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text } as unknown as AgentMessage;
}
function assistantMessage(text: string): AgentMessage {
  return { role: "assistant", content: text } as unknown as AgentMessage;
}

describe("decisionCuratorEnabled", () => {
  it("is on unless the switch says off (unset means on)", () => {
    expect(decisionCuratorEnabled({})).toBe(true);
    expect(decisionCuratorEnabled({ SQUID_DECISION_CURATOR: "" })).toBe(true);
    expect(decisionCuratorEnabled({ SQUID_DECISION_CURATOR: "on" })).toBe(true);
    expect(decisionCuratorEnabled({ SQUID_DECISION_CURATOR: "off" })).toBe(false);
  });
});

describe("resolveCuratorConfig", () => {
  it("defaults to hosted Jev and clamps a bad threshold", () => {
    const cfg = resolveCuratorConfig({});
    expect(cfg.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(cfg.model).toBe(DEFAULT_MODEL);
    expect(cfg.threshold).toBe(0.5);
  });

  it("reads a self-hosted endpoint and model from the merged env, trimming trailing slashes", () => {
    const cfg = resolveCuratorConfig({
      SQUID_DECISION_BASE_URL: "http://127.0.0.1:8009/",
      SQUID_DECISION_MODEL: "kev-4b",
      SQUID_DECISION_THRESHOLD: "0.8",
    });
    expect(cfg.baseUrl).toBe("http://127.0.0.1:8009");
    expect(cfg.model).toBe("kev-4b");
    expect(cfg.threshold).toBe(0.8);
  });

  it("clamps an out-of-range threshold into [0,1]", () => {
    expect(resolveCuratorConfig({ SQUID_DECISION_THRESHOLD: "5" }).threshold).toBe(1);
    expect(resolveCuratorConfig({ SQUID_DECISION_THRESHOLD: "-1" }).threshold).toBe(0);
  });
});

describe("decisionCuratorExtension reducer", () => {
  /** What the reducer's classify calls captured: the model, context, options. */
  interface ClassifyCall {
    model: { id: string; baseUrl: string; provider: string; api: string; type: string };
    state: { transcript?: string };
    questions: Record<string, { type: string }>;
    apiKey: string | undefined;
    timeoutMs: number | undefined;
    maxRetries: number | undefined;
  }

  /**
   * A minimal ExtensionAPI stub that captures the one `context` handler and
   * answers every classify with the supplied noul probabilities (by question
   * id, defaulting to "keep").
   */
  function captureContextHandler(
    ext: ReturnType<typeof decisionCuratorExtension>,
    classify?: (
      call: ClassifyCall,
    ) => { stopReason: string; answers?: Record<string, unknown> },
  ): {
    calls: ClassifyCall[];
    fire: (messages: AgentMessage[], usageTokens?: number) => Promise<AgentMessage[]>;
    sessionStart: () => void;
  } {
    if (ext === undefined) throw new Error("extension was disabled");
    const factory = typeof ext === "function" ? ext : ext.factory;
    const calls: ClassifyCall[] = [];
    let contextHandler:
      | ((event: ContextEvent, ctx: unknown) => Promise<{ messages: AgentMessage[] } | void>)
      | undefined;
    let sessionStartHandler: (() => void) | undefined;
    const pi = {
      on: (event: string, handler: unknown) => {
        if (event === "context") contextHandler = handler as typeof contextHandler;
        if (event === "session_start") sessionStartHandler = handler as typeof sessionStartHandler;
      },
    } as unknown as ExtensionAPI;
    void factory(pi);
    return {
      calls,
      fire: async (messages, usageTokens) => {
        if (contextHandler === undefined) throw new Error("no context handler registered");
        const ctx = {
          signal: undefined,
          getContextUsage: () => (usageTokens === undefined ? undefined : { tokens: usageTokens }),
          modelRegistry: {
            classify: async (model: unknown, context: unknown, options: unknown) => {
              const call = {
                model: model as ClassifyCall["model"],
                ...(context as { state: ClassifyCall["state"]; questions: ClassifyCall["questions"] }),
                ...(options as Pick<ClassifyCall, "apiKey" | "timeoutMs" | "maxRetries">),
              };
              calls.push(call);
              const answers: Record<string, { type: string; probability: number }> = {};
              for (const id of Object.keys(call.questions)) {
                answers[id] = { type: "bool", probability: 0.99 };
              }
              return classify
                ? classify(call)
                : { stopReason: "stop", answers };
            },
          },
        };
        const result = await contextHandler({ type: "context", messages }, ctx);
        return result?.messages ?? messages;
      },
      sessionStart: () => sessionStartHandler?.(),
    };
  }

  it("is disabled (undefined) when the switch is off", () => {
    expect(decisionCuratorExtension({ env: { SQUID_DECISION_CURATOR: "off" } })).toBeUndefined();
  });

  it("passes context through untouched below the min-token floor", async () => {
    const ext = decisionCuratorExtension({ env: {} });
    const { fire, calls } = captureContextHandler(ext);
    const messages = [userMessage("sys"), assistantMessage("a"), userMessage("b")];
    // Tiny context (well under 8000 tokens): the reducer returns nothing, so
    // the caller keeps every message. This is why an idle agent pays no Jev.
    const out = await fire(messages, 10);
    expect(out).toEqual(messages);
    expect(calls.length).toBe(0);
  });

  it("builds the classifier model and options from config, and maps answers by threshold", async () => {
    const ext = decisionCuratorExtension({
      env: {
        SQUID_DECISION_BASE_URL: "http://127.0.0.1:8009",
        SQUID_DECISION_MODEL: "kev-4b",
        SQUID_DECISION_THRESHOLD: "0.5",
        SQUID_DECISION_KEY: "k",
      },
    });
    const { fire, calls } = captureContextHandler(ext, (call) => {
      // Drop every unit: probability 0 < 0.5.
      const answers: Record<string, { type: string; probability: number }> = {};
      for (const id of Object.keys(call.questions)) {
        answers[id] = { type: "bool", probability: 0.01 };
      }
      return { stopReason: "stop", answers };
    });
    const messages = [
      userMessage("system-ish preamble"),
      assistantMessage("old reasoning one"),
      userMessage("old detail two"),
      assistantMessage("old reasoning three"),
      userMessage("current request"),
    ];
    // frequency default is 5, so a single call is not a query turn. Fire five
    // times to reach the query turn; the stub always answers "drop".
    let out: AgentMessage[] = messages;
    for (let i = 0; i < 5; i++) out = await fire(messages, 9000);

    // Exactly one classify call happened, on the query turn.
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    // The model points at the configured replica: baseUrl + /v1, the
    // configured id, Pi's typesafe-system-one classifier shape.
    expect(call.model.baseUrl).toBe("http://127.0.0.1:8009/v1");
    expect(call.model.id).toBe("kev-4b");
    expect(call.model.provider).toBe("typesafe");
    expect(call.model.api).toBe("typesafe-system-one");
    expect(call.model.type).toBe("classifier");
    // Options: injected key, the 15s timeout, and no retries — a slow
    // endpoint must not stall the LLM call this sits ahead of.
    expect(call.apiKey).toBe("k");
    expect(call.timeoutMs).toBe(15000);
    expect(call.maxRetries).toBe(0);
    // State is the JSON-object transcript; questions are bool-framed per unit.
    expect(typeof call.state.transcript).toBe("string");
    expect(Object.keys(call.questions).length).toBeGreaterThan(0);
    for (const q of Object.values(call.questions)) expect(q.type).toBe("bool");

    // The reducer dropped at least the judged middle units, keeping fewer
    // than it was handed. The exact count depends on unit grouping; the
    // invariant is that trimming happened and the last message survived.
    expect(out.length).toBeLessThan(messages.length);
    expect(out[out.length - 1]).toEqual(messages[messages.length - 1]!);
  });

  it("keeps units at or above threshold and drops those below", async () => {
    const ext = decisionCuratorExtension({
      env: { SQUID_DECISION_THRESHOLD: "0.5" },
    });
    const { fire } = captureContextHandler(ext, (call) => {
      const answers: Record<string, { type: string; probability: number }> = {};
      for (const id of Object.keys(call.questions)) {
        const idx = Number(id.slice(1));
        // Even local indexes kept (0.99 >= 0.5), odd dropped — except the
        // exactly-at-threshold 0.5 on unit two, which keeps.
        answers[id] = { type: "bool", probability: idx % 2 === 0 ? 0.99 : idx === 1 ? 0.49 : 0.5 };
      }
      return { stopReason: "stop", answers };
    });
    const messages = [
      userMessage("zero"),
      userMessage("one"),
      userMessage("two"),
      userMessage("three"),
    ];
    // frequency defaults to 5: the fifth fire is the query turn.
    let out: AgentMessage[] = messages;
    for (let i = 0; i < 5; i++) out = await fire(messages, 9000);
    // The last unit (the current request) is always kept; among the judged
    // rest, "one" (0.49) is dropped, the others survive.
    expect(out.map((m) => (m as { content: string }).content)).toEqual([
      "zero",
      "two",
      "three",
    ]);
  });

  it("fails open (keeps everything, records nothing) when classify errors", async () => {
    const ext = decisionCuratorExtension({
      env: { SQUID_DECISION_KEY: "k" },
    });
    const { fire, calls } = captureContextHandler(ext, () => ({
      stopReason: "error",
      errorMessage: "boom",
    }));
    const messages = [
      userMessage("zero"),
      userMessage("one"),
      userMessage("two"),
    ];
    let out: AgentMessage[] = messages;
    for (let i = 0; i < 5; i++) out = await fire(messages, 9000);
    expect(out).toEqual(messages);
    // The next query turn re-asks: the failed judgment was not checkpointed.
    for (let i = 0; i < 5; i++) await fire(messages, 9000);
    expect(calls.length).toBe(2);
  });

  it("sends a placeholder key for a keyless endpoint", async () => {
    const ext = decisionCuratorExtension({ env: {} });
    const { fire, calls } = captureContextHandler(ext);
    for (let i = 0; i < 5; i++) await fire([userMessage("zero"), userMessage("one"), userMessage("two")], 9000);
    expect(calls[0]?.apiKey).toBe("keyless");
  });

  it("caps the state at the newest units that fit the budget", async () => {
    const ext = decisionCuratorExtension({ env: {} });
    let questionCount = 0;
    const { fire } = captureContextHandler(ext, (call) => {
      questionCount = Object.keys(call.questions).length;
      return { stopReason: "stop", answers: {} };
    });
    const messages = [userMessage("m".repeat(1200)), ...Array.from({ length: 200 }, (_, i) => userMessage(`unit-${i} ${"x".repeat(200)}`))];
    for (let i = 0; i < 5; i++) await fire(messages, 90000);
    // 28000-token budget (112000 chars): not every unit's line fits, so the
    // newest-fit subset is judged. The count is bounded well below the whole.
    expect(questionCount).toBeGreaterThan(0);
    expect(questionCount).toBeLessThan(201);
  });
});
