import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { InMemoryEventStore } from "../src/event-store.js";
import { CapabilityDispatcher } from "../src/capability-gateway.js";
import type { ActionConfirmationPolicy } from "../src/action-confirmation.js";
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
  parseLiteralCommand,
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
async function connectCapabilityServer(queries: string[], commands: string[]): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "0.0.1" });
  server.registerTool(
    "search_web",
    { inputSchema: { query: z.string().min(1) } },
    async ({ query }) => {
      queries.push(query);
      return { content: [{ type: "text", text: `results for ${query}` }] };
    },
  );
  server.registerTool(
    "run_command",
    { inputSchema: { command: z.string().min(1) } },
    async ({ command }) => {
      commands.push(command);
      return { content: [{ type: "text", text: `ran ${command}` }] };
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
    runtimeSessionId: "test-runtime",
    stateDigest: `sha256:${"a".repeat(64)}`,
    projectionGeneration: 1,
    triggerDisposition: "accepted",
    contextPolicyId: "passthrough",
    actionTrust: "trusted",
    egressPolicyId: "search-egress-deny-v1",
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
  const commands: string[] = [];
  const client = await connectCapabilityServer(queries, commands);
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
  const gateway = new McpCapabilityGateway({ client, workingDirectory: "/workspace" });
  const dispatcher = new CapabilityDispatcher({
    runtime,
    gateway,
    ledger,
  });
  return {
    queries,
    commands,
    ledger,
    dispatcher,
    planner: (request: Parameters<typeof gateway.plan>[0]) => gateway.plan(request),
    recordFeedback: (input: Parameters<typeof runtime.recordFeedback>[0]) => runtime.recordFeedback(input),
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

  it("rejects actions for a provider admitted only in suggestion mode before opening MCP", async () => {
    const resolution = await resolveWatchActions(
      unreachable("runtime"),
      unreachable("ledger"),
      { SQUID_ACTIONS: "mcp", SQUID_ACTIONS_MCP_COMMAND: "bun server.ts" },
      { actionTrust: "suggestion_only" },
    );
    expect(resolution).toEqual({
      configError: "The selected provider is suggestion-only; actions require a replay-gated trusted provider.",
    });
  });

  it("reports a config error for a recognized variable with an unknown value", async () => {
    const resolution = await resolveWatchActions(unreachable("runtime"), unreachable("ledger"), { SQUID_ACTIONS: "yes" });
    expect(resolution).toHaveProperty("configError");
  });

  it("reports a config error for mcp mode without a command", async () => {
    const resolution = await resolveWatchActions(unreachable("runtime"), unreachable("ledger"), { SQUID_ACTIONS: "mcp" });
    expect(resolution).toHaveProperty("configError");
  });

  it("rejects an invalid confirmation mode before touching dependencies", async () => {
    const resolution = await resolveWatchActions(unreachable("runtime"), unreachable("ledger"), {
      SQUID_ACTIONS: "mcp",
      SQUID_ACTIONS_MCP_COMMAND: "bun run server.ts",
      SQUID_ACTION_CONFIRM: "always",
    });
    expect(resolution).toHaveProperty("configError");
  });

  it("rejects a malformed timeout before touching dependencies", async () => {
    const resolution = await resolveWatchActions(unreachable("runtime"), unreachable("ledger"), {
      SQUID_ACTIONS: "mcp",
      SQUID_ACTIONS_MCP_COMMAND: "bun run server.ts",
      SQUID_ACTION_CONFIRM_TIMEOUT_MS: "zero",
    });
    expect(resolution).toHaveProperty("configError");
  });

  it("requires terminal mode when a confirmation timeout is configured", async () => {
    const resolution = await resolveWatchActions(unreachable("runtime"), unreachable("ledger"), {
      SQUID_ACTIONS: "mcp",
      SQUID_ACTIONS_MCP_COMMAND: "bun run server.ts",
      SQUID_ACTION_CONFIRM_TIMEOUT_MS: "1000",
    });
    expect(resolution).toHaveProperty("configError");
  });

  it("requires an absolute working directory for terminal confirmation", async () => {
    const resolution = await resolveWatchActions(unreachable("runtime"), unreachable("ledger"), {
      SQUID_ACTIONS: "mcp",
      SQUID_ACTIONS_MCP_COMMAND: "bun run server.ts",
      SQUID_ACTION_CONFIRM: "terminal",
      SQUID_ACTION_WORKDIR: "relative/project",
    });
    expect(resolution).toHaveProperty("configError");
  });

  it("rejects control characters in the action working directory before opening MCP", async () => {
    for (const workingDirectory of ["/workspace/line\nbreak", "/workspace/escape\u001b[2J"]) {
      const resolution = await resolveWatchActions(unreachable("runtime"), unreachable("ledger"), {
        SQUID_ACTIONS: "mcp",
        SQUID_ACTIONS_MCP_COMMAND: "bun run server.ts",
        SQUID_ACTION_CONFIRM: "terminal",
        SQUID_ACTION_WORKDIR: workingDirectory,
      });
      expect(resolution).toHaveProperty("configError");
    }
  });
});

describe("parseLiteralCommand", () => {
  it("preserves quoted arguments without starting a shell", () => {
    expect(parseLiteralCommand('bun run "/tmp/server with spaces.ts"')).toEqual({
      command: "bun",
      args: ["run", "/tmp/server with spaces.ts"],
    });
  });

  it("rejects an empty executable", () => {
    expect(parseLiteralCommand('\"\"')).toHaveProperty("configError");
  });

  it("rejects operators, variables, comments, and globs", () => {
    for (const command of [
      "bun run server.ts && echo nope",
      "bun run $HOME/server.ts",
      "bun run server.ts # hidden",
      "bun run *.ts",
      "bun run `echo server.ts`",
    ]) {
      expect(parseLiteralCommand(command)).toHaveProperty("configError");
    }
  });
});

describe("dispatchTopCandidate", () => {
  it("dispatches the search_selection candidate through the real gateway and records both feedback kinds", async () => {
    const candidates = [
      candidate("run_tests"),
      candidate("search_selection", { parameters: { selection: "typebox" }, confidence: 0.2 }),
    ];
    const { queries, ledger, dispatcher, planner, close } = await setup(candidates);

    const result = await dispatchTopCandidate(
      { requestId: "req-1" },
      candidates,
      dispatcher,
      { planner },
    );

    expect(result?.action?.outcome).toBe("succeeded");
    expect(queries).toEqual(["typebox"]);
    const feedback = (await ledger.all())
      .filter((record) => record.recordType === "feedback");
    expect(feedback.map((record) => record.feedback)).toEqual(["dispatched", "succeeded"]);
    await close();
  });

  it("keeps run_tests disabled when terminal confirmation is not configured", async () => {
    const candidates = [candidate("run_tests", { confidence: 0.9 })];
    const { queries, dispatcher, planner, close } = await setup(candidates);

    const result = await dispatchTopCandidate(
      { requestId: "req-1" },
      candidates,
      dispatcher,
      { planner },
    );

    expect(result).toBeNull();
    expect(queries).toEqual([]);
    await close();
  });

  it("records acceptance, then dispatches run_tests through the real dispatcher", async () => {
    const candidates = [candidate("run_tests", {
      confidence: 0.9,
      parameters: { path: "tests/foo.test.ts" },
    })];
    const { commands, ledger, dispatcher, planner, recordFeedback, close } = await setup(candidates);
    const confirmation: ActionConfirmationPolicy = {
      confirm: async () => ({ outcome: "accepted", reason: "user_accepted" }),
    };

    const result = await dispatchTopCandidate(
      { requestId: "req-1" },
      candidates,
      dispatcher,
      { confirmation, planner, recordFeedback },
    );

    expect(result?.decision).toEqual({ outcome: "accepted", reason: "user_accepted" });
    expect(result?.action?.outcome).toBe("succeeded");
    expect(commands).toEqual(["cd /workspace && bun test -- tests/foo.test.ts"]);
    const feedback = (await ledger.all())
      .filter((record) => record.recordType === "feedback");
    expect(feedback.map((record) => record.feedback)).toEqual([
      "accepted",
      "dispatched",
      "succeeded",
    ]);
    await close();
  });

  it("records rejection and never invokes the gateway", async () => {
    const candidates = [candidate("run_tests", {
      parameters: { path: "tests/foo.test.ts" },
    })];
    const { ledger, dispatcher, planner, recordFeedback, close } = await setup(candidates);
    const confirmation: ActionConfirmationPolicy = {
      confirm: async () => ({ outcome: "rejected", reason: "user_rejected" }),
    };

    const result = await dispatchTopCandidate(
      { requestId: "req-1" },
      candidates,
      dispatcher,
      { confirmation, planner, recordFeedback },
    );

    expect(result?.action).toBeNull();
    const feedback = (await ledger.all())
      .filter((record) => record.recordType === "feedback");
    expect(feedback.map((record) => record.feedback)).toEqual(["rejected"]);
    await close();
  });

  it("rechecks expiry after an accepted confirmation", async () => {
    const candidates = [candidate("run_tests", {
      expiresAt: "2030-01-01T00:00:10.000Z",
      parameters: { path: "tests/foo.test.ts" },
    })];
    const { ledger, dispatcher, planner, recordFeedback, close } = await setup(candidates);
    let call = 0;
    const confirmation: ActionConfirmationPolicy = {
      confirm: async () => ({ outcome: "accepted", reason: "user_accepted" }),
    };

    const result = await dispatchTopCandidate(
      { requestId: "req-1" },
      candidates,
      dispatcher,
      {
        confirmation,
        planner,
        recordFeedback,
        now: () => new Date(call++ === 0
          ? "2030-01-01T00:00:00.000Z"
          : "2030-01-01T00:00:11.000Z"),
      },
    );

    expect(result?.decision).toEqual({ outcome: "expired", reason: "candidate_expired" });
    expect(result?.action).toBeNull();
    const feedback = (await ledger.all())
      .filter((record) => record.recordType === "feedback");
    expect(feedback.map((record) => record.feedback)).toEqual(["accepted", "expired"]);
    await close();
  });

  it("skips an expired candidate instead of acting on stale context", async () => {
    const candidates = [
      candidate("search_selection", {
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        parameters: { selection: "stale" },
      }),
    ];
    const { queries, dispatcher, planner, close } = await setup(candidates);

    const result = await dispatchTopCandidate(
      { requestId: "req-1" },
      candidates,
      dispatcher,
      { planner },
    );

    expect(result).toBeNull();
    expect(queries).toEqual([]);
    await close();
  });

  it("prefers the higher-confidence of two eligible candidates", async () => {
    const candidates = [
      candidate("search_selection", { parameters: { selection: "low" }, confidence: 0.1 }),
      candidate("search_selection", { parameters: { selection: "high" }, confidence: 0.8 }),
    ];
    const { queries, dispatcher, planner, close } = await setup(candidates);

    const result = await dispatchTopCandidate(
      { requestId: "req-1" },
      candidates,
      dispatcher,
      { planner },
    );

    expect(result?.action?.outcome).toBe("succeeded");
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
