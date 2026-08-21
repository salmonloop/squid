import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { InMemoryEventStore } from "../src/event-store.js";
import { CapabilityDispatcher } from "../src/capability-gateway.js";
import { McpCapabilityGateway } from "../src/mcp-gateway.js";
import { PredictionCoordinator } from "../src/prediction-coordinator.js";
import {
  candidateEnvelopes,
  createAttemptRecord,
  InMemoryPredictionLedger,
  type PredictionLedger,
} from "../src/prediction-ledger.js";
import { PredictionRuntime } from "../src/prediction-runtime.js";
import type { PredictionCandidate } from "../src/protocol.js";
import { SquidCore } from "../src/squid-core.js";
import {
  dispatchTopCandidate,
  resolveWatchActions,
} from "../src/watch-actions.js";

const nextRequestId = () => {
  let sequence = 0;
  return () => `dispatch-${++sequence}`;
};

/**
 * The dispatch loop is tested end-to-end through the production objects: a
 * real MCP server over the in-memory transport, a real McpCapabilityGateway,
 * a real CapabilityDispatcher over a real ledger seeded with the attempt —
 * the same chain a live run executes, minus only the stdio wire.
 */
async function connectSearchServer(queries: string[]): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "0.0.1" });
  server.registerTool(
    "search_web",
    { inputSchema: { query: z.string().min(1) } },
    async ({ query }) => {
      queries.push(query);
      return { content: [{ type: "text", text: `results for ${query}` }] };
    },
  );
  const client = new Client({ name: "squid-test", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

function candidate(
  kind: PredictionCandidate["kind"],
  overrides: Partial<PredictionCandidate> = {},
): PredictionCandidate {
  return {
    kind,
    rationale: `test ${kind}`,
    confidence: 0.5,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceEventIds: [],
    parameters: {},
    ...overrides,
  };
}

/** Seeds the ledger with the attempt a live prediction run would have written. */
async function seedAttempt(
  ledger: PredictionLedger,
  requestId: string,
  candidates: readonly PredictionCandidate[],
): Promise<void> {
  await ledger.appendAttempt(createAttemptRecord({
    triggerEventId: "evt-1",
    episodeId: null,
    triggeredAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    outcome: {
      requestId,
      provider: "heuristic",
      status: "succeeded",
      candidates,
      latencyMs: 1,
    },
    candidates: candidateEnvelopes(requestId, candidates),
  }));
}

async function setup(candidates: readonly PredictionCandidate[]) {
  const queries: string[] = [];
  const client = await connectSearchServer(queries);
  const ledger = new InMemoryPredictionLedger();
  await seedAttempt(ledger, "req-1", candidates);
  const runtime = new PredictionRuntime(
    new SquidCore(new InMemoryEventStore()),
    // No event is ever ingested in these tests, so the coordinator never
    // requests a prediction; it exists only because the runtime owns one.
    new PredictionCoordinator({
      provider: { name: "unused", predict: () => Promise.resolve([]) },
      random: nextRequestId(),
    }),
    { ledger },
  );
  const dispatcher = new CapabilityDispatcher({
    runtime,
    gateway: new McpCapabilityGateway({ client }),
    ledger,
  });
  return {
    queries,
    dispatcher,
    close: async () => {
      await runtime.dispose();
      await client.close();
    },
  };
}

describe("resolveWatchActions", () => {
  it("returns undefined when SQUID_ACTIONS is unset — actions stay off", async () => {
    const resolution = await resolveWatchActions(unreachable("runtime"), unreachable("ledger"), {});
    expect(resolution).toBeUndefined();
  });

  it("reports a config error for a recognized variable with an unknown value", async () => {
    const resolution = await resolveWatchActions(unreachable("runtime"), unreachable("ledger"), { SQUID_ACTIONS: "yes" });
    expect(resolution).toHaveProperty("configError");
  });

  it("reports a config error for mcp mode without a command", async () => {
    const resolution = await resolveWatchActions(unreachable("runtime"), unreachable("ledger"), { SQUID_ACTIONS: "mcp" });
    expect(resolution).toHaveProperty("configError");
  });
});

describe("dispatchTopCandidate", () => {
  it("dispatches the search_selection candidate through the real gateway and records both feedback kinds", async () => {
    const candidates = [
      candidate("run_tests"),
      candidate("search_selection", { parameters: { selection: "typebox" }, confidence: 0.2 }),
    ];
    const { queries, dispatcher, close } = await setup(candidates);

    const result = await dispatchTopCandidate(
      { requestId: "req-1" },
      candidates,
      dispatcher,
    );

    expect(result?.outcome).toBe("succeeded");
    expect(queries).toEqual(["typebox"]);
    const feedback = (await (dispatcher as unknown as { ledger: PredictionLedger }).ledger.all())
      .filter((record) => record.recordType === "feedback");
    expect(feedback.map((record) => record.feedback)).toEqual(["dispatched", "succeeded"]);
    await close();
  });

  it("skips run_tests even when it ranks highest — no confirmation step exists yet", async () => {
    const candidates = [candidate("run_tests", { confidence: 0.9 })];
    const { queries, dispatcher, close } = await setup(candidates);

    const result = await dispatchTopCandidate({ requestId: "req-1" }, candidates, dispatcher);

    expect(result).toBeNull();
    expect(queries).toEqual([]);
    await close();
  });

  it("skips an expired candidate instead of acting on stale context", async () => {
    const candidates = [
      candidate("search_selection", {
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        parameters: { selection: "stale" },
      }),
    ];
    const { queries, dispatcher, close } = await setup(candidates);

    const result = await dispatchTopCandidate({ requestId: "req-1" }, candidates, dispatcher);

    expect(result).toBeNull();
    expect(queries).toEqual([]);
    await close();
  });

  it("prefers the higher-confidence of two eligible candidates", async () => {
    const candidates = [
      candidate("search_selection", { parameters: { selection: "low" }, confidence: 0.1 }),
      candidate("search_selection", { parameters: { selection: "high" }, confidence: 0.8 }),
    ];
    const { queries, dispatcher, close } = await setup(candidates);

    const result = await dispatchTopCandidate({ requestId: "req-1" }, candidates, dispatcher);

    expect(result?.outcome).toBe("succeeded");
    expect(queries).toEqual(["high"]);
    await close();
  });
});

// Config validation reads only `env`, so these dependencies are never touched
// before the function returns. A Proxy that throws on any property access
// proves that: touching either argument at all fails the test loudly.
function unreachable(label: string): never {
  return new Proxy({}, {
    get() {
      throw new Error(`${label} must not be reached during config validation`);
    },
  }) as never;
}
