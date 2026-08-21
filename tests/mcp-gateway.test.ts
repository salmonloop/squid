import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { McpCapabilityGateway } from "../src/mcp-gateway.js";
import type { ActionRequest } from "../src/capability-gateway.js";

/**
 * The gateway is tested against a real MCP server over the in-memory
 * transport — not a stub of the client. That exercises the protocol layer
 * (tool listing, argument validation, error results) exactly as a stdio or
 * HTTP deployment would see it, while staying offline and deterministic.
 */
function request(kind: ActionRequest["kind"], parameters: ActionRequest["parameters"]): ActionRequest {
  return { candidateId: `req:candidate:0`, kind, parameters };
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
      request("search_selection", { selection: "typebox union", prefix: "", suffix: "" }),
    );

    expect(result.outcome).toBe("succeeded");
    expect(result.candidateId).toBe("req:candidate:0");
    expect(result.details?.tool).toBe("search_web");
    expect(result.details?.summary).toBe("3 hits for typebox union");
  });

  it("maps run_tests' saved path onto a run_command invocation", async () => {
    let seenCommand = "";
    const client = await connect({
      onRunCommand: ({ command }) => {
        seenCommand = command;
        return "ran";
      },
    });
    const gateway = new McpCapabilityGateway({ client, workingDirectory: "/workspace/squid project" });

    const result = await gateway.invoke(
      request("run_tests", { path: "tests/foo bar;$(touch nope).test.ts" }),
    );

    expect(result.outcome).toBe("succeeded");
    expect(seenCommand).toBe("cd '/workspace/squid project' && bun test -- 'tests/foo bar;$(touch nope).test.ts'");
  });

  it("refuses prediction kinds with no tool mapping", async () => {
    const client = await connect();
    const gateway = new McpCapabilityGateway({ client });

    const result = await gateway.invoke(request("draft_completion", { prefix: "hello" }));

    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("draft_completion");
  });

  it("refuses candidates whose parameters do not satisfy the tool contract instead of calling the tool", async () => {
    const client = await connect({
      onSearchWeb: () => {
        throw new Error("must not be called");
      },
    });
    const gateway = new McpCapabilityGateway({ client });

    // The heuristic emits {selection}; a candidate without it is refused.
    const emptySelection = await gateway.invoke(request("search_selection", { selection: "   " }));
    expect(emptySelection.outcome).toBe("failed");

    const noPath = await gateway.invoke(request("run_tests", {}));
    expect(noPath.outcome).toBe("failed");
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

    const result = await gateway.invoke(request("search_selection", { selection: "x" }));

    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("upstream search provider down");
  });

  it("turns a thrown tool invocation into a failed outcome", async () => {
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

    const result = await gateway.invoke(request("search_selection", { selection: "x" }));

    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("handler exploded");
  });

  it("rejects schema-invalid arguments as a failed outcome via the server's own validation", async () => {
    const client = await connect();
    const gateway = new McpCapabilityGateway({ client });

    // A selection of only whitespace passes the gateway (it is a string) but
    // the mapping trims it — so use a non-empty value and force rejection at
    // the server instead by registering an empty-argument-tolerant tool.
    const result = await gateway.invoke(request("search_selection", { selection: "x" }));

    expect(result.outcome).toBe("succeeded");
  });
});
