import { afterAll, describe, expect, it } from "bun:test";
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  decisionCuratorEnabled,
  decisionCuratorExtension,
  resolveCuratorConfig,
} from "../src/decision-curator-extension.js";
import { groupIntoUnits } from "../src/jev-curator/units.js";
import { askJev } from "../src/jev-curator/jev.js";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "../src/jev-curator/config.js";

type AgentMessage = ContextEvent["messages"][number];

/**
 * The curator is exercised at three seams that matter and no more: the enable
 * switch, the config resolver's defaults, and one round trip through `askJev`
 * against a fake `/v1/systemone` — which is the whole point of the vendored
 * wire contract, that a 20-line server stands in for a 54GB model. The
 * extension's `on("context")` reducer is driven through a hand-rolled
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

describe("askJev against a fake /v1/systemone", () => {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/v1/systemone") return new Response("not found", { status: 404 });
      const body = (await req.json()) as {
        questions: Record<string, unknown>;
      };
      // Answer every question: keep the even-indexed unit, drop the odd. The
      // question ids are `u<localIndex>`, so this lets the assertion below know
      // exactly which local indexes should survive.
      const answers: Record<string, { type: string; noul: number }> = {};
      for (const key of Object.keys(body.questions)) {
        const idx = Number(key.slice(1));
        answers[key] = { type: "noul", noul: idx % 2 === 0 ? 0.99 : 0.01 };
      }
      return Response.json({ model: "fake", answers, usage: { input_tokens: 42 } });
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  afterAll(() => server.stop(true));

  it("keeps units above threshold and drops those below, reporting tokens", async () => {
    const messages = [
      userMessage("zero"),
      userMessage("one"),
      userMessage("two"),
    ];
    const units = groupIntoUnits(messages);
    const decision = await askJev(
      units,
      "test-key",
      { baseUrl, model: "fake", threshold: 0.5, minTokens: 0, frequency: 1 },
      undefined,
    );
    expect(decision).not.toBeNull();
    if (!decision) return;
    // Even local indexes kept, odd dropped — exactly what the fake answered.
    expect(decision.keep.has(0)).toBe(true);
    expect(decision.keep.has(1)).toBe(false);
    expect(decision.keep.has(2)).toBe(true);
    expect(decision.inputTokens).toBe(42);
  });

  it("fails open (returns null) on a non-OK response", async () => {
    const decision = await askJev(
      groupIntoUnits([userMessage("a"), userMessage("b")]),
      "test-key",
      { baseUrl: `${baseUrl}/nope`, model: "fake", threshold: 0.5, minTokens: 0, frequency: 1 },
      undefined,
    );
    // A 404 is a thrown-then-caught failure: the caller keeps everything.
    expect(decision).toBeNull();
  });
});

describe("decisionCuratorExtension reducer", () => {
  /** A minimal ExtensionAPI stub that captures the one `context` handler. */
  function captureContextHandler(ext: ReturnType<typeof decisionCuratorExtension>): {
    fire: (messages: AgentMessage[], usageTokens?: number) => Promise<AgentMessage[]>;
    sessionStart: () => void;
  } {
    if (ext === undefined) throw new Error("extension was disabled");
    const factory = typeof ext === "function" ? ext : ext.factory;
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
      fire: async (messages, usageTokens) => {
        if (contextHandler === undefined) throw new Error("no context handler registered");
        const ctx = {
          signal: undefined,
          getContextUsage: () => (usageTokens === undefined ? undefined : { tokens: usageTokens }),
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
    const { fire } = captureContextHandler(ext);
    const messages = [userMessage("sys"), assistantMessage("a"), userMessage("b")];
    // Tiny context (well under 8000 tokens): the reducer returns nothing, so
    // the caller keeps every message. This is why an idle agent pays no Jev.
    const out = await fire(messages, 10);
    expect(out).toEqual(messages);
  });

  it("trims dropped units once the endpoint answers, above the floor", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { questions: Record<string, unknown> };
        const answers: Record<string, { type: string; noul: number }> = {};
        // Drop everything the model is asked about: noul 0 < any threshold.
        for (const key of Object.keys(body.questions)) answers[key] = { type: "noul", noul: 0 };
        return Response.json({ answers, usage: { input_tokens: 10 } });
      },
    });
    try {
      const ext = decisionCuratorExtension({
        env: {
          SQUID_DECISION_BASE_URL: `http://127.0.0.1:${server.port}`,
          SQUID_DECISION_KEY: "k",
        },
      });
      const { fire } = captureContextHandler(ext);
      // Enough distinct middle units that at least one is judged and dropped;
      // the last unit is always kept (it is the current request).
      const messages = [
        userMessage("system-ish preamble"),
        assistantMessage("old reasoning one"),
        userMessage("old detail two"),
        assistantMessage("old reasoning three"),
        userMessage("current request"),
      ];
      // frequency default is 5, so a single call is not a query turn. Fire five
      // times to reach the query turn; the fake always answers "drop".
      let out: AgentMessage[] = messages;
      for (let i = 0; i < 5; i++) out = await fire(messages, 9000);
      // The reducer dropped at least the judged middle units, keeping fewer
      // than it was handed. The exact count depends on unit grouping; the
      // invariant is that trimming happened and the last message survived.
      expect(out.length).toBeLessThan(messages.length);
      expect(out[out.length - 1]).toEqual(messages[messages.length - 1]!);
    } finally {
      server.stop(true);
    }
  });
});
