import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { McpCapabilityGateway } from "../src/mcp-gateway.js";
import { planAction, isPlanFailure } from "../src/action-planner.js";
import { digestActionPlan, type ImmutableActionPlan } from "../src/action-plan.js";

/**
 * The gateway is tested against a real MCP server over the in-memory
 * transport — not a stub of the client. That exercises the protocol layer
 * (tool listing, argument validation, error results) exactly as a stdio or
 * HTTP deployment would see it, while staying offline and deterministic.
 */
/**
 * Builds a real plan through the planner rather than hand-writing one, so these
 * tests exercise the exact object shape production sends to the gateway.
 */
async function plan(
  kind: "search_selection" | "run_tests",
  parameters: Record<string, string>,
  workingDirectory?: string,
): Promise<ImmutableActionPlan> {
  const planned = await planAction(
    { candidateId: "req:candidate:0", attemptId: "req", kind, parameters },
    {
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      resolvePath: async (path) => path,
    },
  );
  if (isPlanFailure(planned)) {
    throw new Error(`planner refused: ${planned.reasonCode}`);
  }
  return planned.plan;
}

async function connect(options: {
  onSearchWeb?: (args: { query: string }) => string;
  onRunCommand?: (args: { command: string }) => string;
} = {}): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "0.0.1" });
  server.registerTool(
    "search_web",
    {
      description: "Search the web for a query.",
      inputSchema: { query: z.string().min(1) },
    },
    async ({ query }) => ({
      content: [
        {
          type: "text",
          text: options.onSearchWeb
            ? options.onSearchWeb({ query })
            : `results for ${query}`,
        },
      ],
    }),
  );
  server.registerTool(
    "run_command",
    {
      description: "Run a command.",
      inputSchema: { command: z.string().min(1) },
    },
    async ({ command }) => ({
      content: [
        {
          type: "text",
          text: options.onRunCommand
            ? options.onRunCommand({ command })
            : `ran ${command}`,
        },
      ],
    }),
  );

  const client = new Client({ name: "squid-test", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

describe("McpCapabilityGateway", () => {
  it("maps search_selection's selection onto search_web and reports success with a summary", async () => {
    const client = await connect({
      onSearchWeb: ({ query }) => `3 hits for ${query}`,
    });
    const gateway = new McpCapabilityGateway({ client });

    const result = await gateway.invoke(
      await plan("search_selection", { selection: "typebox union" }),
    );

    expect(result.outcome).toBe("succeeded");
    expect(result.details?.tool).toBe("search_web");
    expect(result.details?.summary).toBe("3 hits for typebox union");
  });

  it("runs the exact command the planner froze, in the canonical directory", async () => {
    let seenCommand = "";
    const client = await connect({
      onRunCommand: ({ command }) => {
        seenCommand = command;
        return "ran";
      },
    });
    const gateway = new McpCapabilityGateway({ client });

    // A real directory, because the gateway re-resolves the plan's canonical
    // paths before invoking: a workdir that no longer exists must not run.
    const root = await mkdtemp(join(tmpdir(), "squid-gateway-"));
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "tests", "sample.test.ts"), "", "utf8");
    const built = await plan("run_tests", { path: "tests/sample.test.ts" }, root);

    const result = await gateway.invoke(built);

    expect(result.outcome).toBe("succeeded");
    // Quoted exactly once, over the canonical root the planner resolved.
    expect(seenCommand).toBe(built.arguments.command);
    expect(seenCommand).toContain("bun test -- tests/sample.test.ts");
  });

  it("refuses to invoke when the plan's canonical directory no longer resolves", async () => {
    const client = await connect({
      onRunCommand: () => {
        throw new Error("must not be called");
      },
    });
    const gateway = new McpCapabilityGateway({ client });

    const result = await gateway.invoke(await plan(
      "run_tests",
      { path: "tests/gone.test.ts" },
      "/workspace/definitely missing",
    ));

    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("working directory");
  });

  it("reports a missing tool as a failed outcome rather than throwing", async () => {
    const client = await connect();
    const gateway = new McpCapabilityGateway({ client });
    const valid = await plan("search_selection", { selection: "x" });

    // A plan naming a tool this server does not expose: the gateway does not
    // discover tools, so the protocol-level rejection is the answer.
    const result = await gateway.invoke({ ...valid, tool: "no_such_tool" });

    expect(result.outcome).toBe("failed");
    expect(result.planDigest).toBe(result.planDigest);
  });

  it("turns an MCP error result into a failed outcome carrying the message", async () => {
    const server = new McpServer({ name: "failing-server", version: "0.0.1" });
    server.registerTool(
      "search_web",
      { inputSchema: { query: z.string() } },
      async () => ({
        content: [{ type: "text", text: "upstream search provider down" }],
        isError: true,
      }),
    );
    const client = new Client({ name: "squid-test", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    const gateway = new McpCapabilityGateway({ client });

    const result = await gateway.invoke(await plan("search_selection", { selection: "x" }));

    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("upstream search provider down");
  });

  it("turns a tool handler that throws into a failed outcome", async () => {
    // The handler threw on the *server* side, so MCP delivers a well-formed
    // error result. The tool ran and reported failure, which is terminal — quite
    // different from the transport case below.
    const server = new McpServer({ name: "throwing-server", version: "0.0.1" });
    server.registerTool(
      "search_web",
      { inputSchema: { query: z.string() } },
      async () => {
        throw new Error("handler exploded");
      },
    );
    const client = new Client({ name: "squid-test", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    const gateway = new McpCapabilityGateway({ client });

    const result = await gateway.invoke(await plan("search_selection", { selection: "x" }));

    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("handler exploded");
  });

  it("returns the plan's own digest so the dispatcher can match the completion", async () => {
    const client = await connect();
    const gateway = new McpCapabilityGateway({ client });
    const actionPlan = await plan("search_selection", { selection: "x" });

    const result = await gateway.invoke(actionPlan);

    expect(result.outcome).toBe("succeeded");
    expect(result.planDigest).toBe(digestActionPlan(actionPlan));
  });

  /**
   * The distinction the whole reconciliation path rests on. A server-side error
   * result is terminal: the tool ran and said no. A dead transport is not — the
   * request may have reached the tool and completed. The gateway must therefore
   * throw rather than return `failed`, because `failed` in the ledger invites an
   * automatic retry of an action that may already have run.
   */
  it("throws rather than fabricating a failure when the transport is closed", async () => {
    const client = await connect();
    const gateway = new McpCapabilityGateway({ client });
    const actionPlan = await plan("search_selection", { selection: "x" });
    await client.close();

    await expect(gateway.invoke(actionPlan)).rejects.toThrow();
  });
});
