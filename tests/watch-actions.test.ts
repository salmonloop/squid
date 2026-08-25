import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { InMemoryEventStore } from "../src/event-store.js";
import { CapabilityDispatcher } from "../src/capability-gateway.js";
import type { ActionConfirmationPolicy } from "../src/action-confirmation.js";
import {
  resolveSearchEgress,
  SEARCH_EGRESS_ALLOW_ID,
  SEARCH_EGRESS_DENY_ID,
  type EgressPolicy,
} from "../src/action-egress.js";
import { McpCapabilityGateway } from "../src/mcp-gateway.js";
import { PredictionCoordinator } from "../src/prediction-coordinator.js";
import { InMemoryPredictionLedger } from "../src/prediction-ledger.js";
import { PredictionRuntime } from "../src/prediction-runtime.js";
import { createActivityEvent, type ActivityEvent, type PredictionCandidate } from "../src/protocol.js";
import { SquidCore } from "../src/squid-core.js";
import {
  createConfirmation,
  dispatchTopCandidate,
  parseLiteralCommand,
  resolveWatchActions,
} from "../src/watch-actions.js";
import type { CapabilityActionPlan, ImmutableActionPlan } from "../src/action-plan.js";
import { digestActionPlan } from "../src/action-plan.js";
import { isPlanFailure, planAction, type PlannedAction } from "../src/action-planner.js";
import { bunProject } from "./fixtures/bun-project.js";

const SESSION = "watch-session";
const ALLOW: EgressPolicy = { id: SEARCH_EGRESS_ALLOW_ID, searchEgress: "allow" };
const DENY: EgressPolicy = { id: SEARCH_EGRESS_DENY_ID, searchEgress: "deny" };

const nextRequestId = () => {
  let sequence = 0;
  return () => `dispatch-${++sequence}`;
};

/**
 * Plans for real against this run's attempt identity, then restamps the plan to
 * require confirmation.
 *
 * The descriptors are bypassed by decision (issue #11), so plans no longer ask
 * for a prompt by default — but the dispatcher's confirmation mechanism still
 * runs for any plan that does, and these are its tests. Planning with the live
 * request id keeps every other field exactly what admission expects; only
 * `confirmation` changes, and the digest is recomputed with it so the pair
 * remains one fact.
 */
async function restampedRequiredPlan(
  root: string,
  requestId: string,
): Promise<{ readonly plan: ImmutableActionPlan; readonly planned: PlannedAction }> {
  const planned = await planAction(
    {
      candidateId: `${requestId}:candidate:0`,
      attemptId: requestId,
      kind: "run_tests",
      toolId: "run_tests",
      parameters: { path: "tests/foo.test.ts" },
    },
    { workingDirectory: root, project: bunProject },
  );
  if (isPlanFailure(planned)) throw new Error(planned.reasonCode);
  const plan = Object.freeze({
    ...planned.plan,
    confirmation: "required" as const,
    arguments: Object.freeze({ ...planned.plan.arguments }),
  });
  return { plan, planned };
}

/**
 * The dispatch loop is tested end-to-end through the production objects: a real
 * MCP server over the in-memory transport, a real gateway, a real dispatcher,
 * and a real runtime whose projection is built by ingesting real events — the
 * same chain a live run executes, minus only the stdio wire.
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

/** Events that put a selection in a browser window, owned end to end. */
function browserSelection(selection: string): readonly ActivityEvent[] {
  return [
    createActivityEvent({
      kind: "application_activated",
      eventId: "b-app",
      payload: { applicationId: "chrome", applicationName: "Chrome" },
    }),
    createActivityEvent({
      kind: "window_changed",
      eventId: "b-window",
      payload: { applicationId: "chrome", title: "Docs", bounds: null },
    }),
    createActivityEvent({
      kind: "browser_navigated",
      eventId: "b-page",
      payload: {
        url: "https://example.com/docs",
        title: "Docs",
        host: "example.com",
        owner: { applicationId: "chrome", windowTitle: "Docs" },
      },
    }),
    createActivityEvent({
      kind: "focus_changed",
      eventId: "b-focus",
      payload: {
        applicationId: "chrome",
        windowTitle: "Docs",
        role: "text_input",
        label: null,
      },
    }),
    createActivityEvent({
      kind: "text_context_changed",
      eventId: "b-text",
      payload: { prefix: "", suffix: "", selection, language: null },
    }),
  ];
}

/** Events that make a coding application the owner of the newest save. */
function editorSave(path: string): readonly ActivityEvent[] {
  return [
    createActivityEvent({
      kind: "application_activated",
      eventId: "e-app",
      payload: { applicationId: "vscode", applicationName: "Code" },
    }),
    createActivityEvent({
      kind: "window_changed",
      eventId: "e-window",
      payload: { applicationId: "vscode", title: "main.ts", bounds: null },
    }),
    createActivityEvent({
      kind: "file_saved",
      eventId: "e-save",
      payload: { path, applicationId: "vscode" },
    }),
  ];
}

function candidate(
  kind: PredictionCandidate["kind"],
  overrides: Partial<PredictionCandidate> = {},
): PredictionCandidate {
  return {
    kind,
    // Default to the built-in tool of this category; a test proposing without
    // a capability overrides it to null explicitly.
    toolId: overrides.toolId ?? (kind === "run_tests" ? "run_tests"
      : kind === "search_selection" ? "search_selection"
      : kind === "inspect_error" ? "run_check"
      : null),
    rationale: `test ${kind}`,
    confidence: 0.5,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceEventIds: [],
    parameters: {},
    ...overrides,
  };
}

/**
 * Builds the live chain and drives the runtime through `events` so the attempt
 * the dispatcher validates against was produced by a real projection rather
 * than hand-written into the ledger.
 */
async function setup(options: {
  readonly candidates: readonly PredictionCandidate[];
  readonly events: readonly ActivityEvent[];
  readonly confirmation?: ActionConfirmationPolicy;
  readonly workingDirectory?: string;
  /**
   * The one egress policy this runtime is built with. Production resolves a
   * single policy in `resolveWatchActions` and hands the same object to both
   * the runtime and every dispatch, so the fixture mirrors that: tests read
   * `egressPolicy` back from setup rather than passing their own.
   */
  readonly egressPolicy?: EgressPolicy;
}) {
  const egressPolicy = options.egressPolicy ?? ALLOW;
  const queries: string[] = [];
  const commands: string[] = [];
  const client = await connectCapabilityServer(queries, commands);
  const ledger = new InMemoryPredictionLedger();
  const runtime = new PredictionRuntime(
    new SquidCore(new InMemoryEventStore()),
    new PredictionCoordinator({
      provider: {
        name: "scripted",
        predict: () => Promise.resolve(options.candidates),
      },
      random: nextRequestId(),
    }),
    {
      ledger,
      runtimeSessionId: SESSION,
      actionTrust: "trusted",
      egressPolicyId: egressPolicy.id,
    },
  );
  const gateway = new McpCapabilityGateway({ client });
  const dispatcher = new CapabilityDispatcher({
    runtime,
    gateway,
    ledger,
    ...(options.confirmation === undefined ? {} : { confirmation: options.confirmation }),
  });

  let requestId = "";
  for (const event of options.events) {
    const ingested = await runtime.ingest(event);
    if (ingested.prediction !== null) {
      requestId = (await ingested.prediction).requestId;
    }
  }
  await runtime.awaitIdle();

  return {
    queries,
    commands,
    ledger,
    dispatcher,
    requestId,
    egressPolicy,
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

  it("rejects an invalid SQUID_SEARCH_EGRESS value before opening MCP", async () => {
    for (const value of ["Allow", "allowed", "deny", "yes"]) {
      const resolution = await resolveWatchActions(
        unreachable("runtime"),
        unreachable("ledger"),
        {
          SQUID_ACTIONS: "mcp",
          SQUID_ACTIONS_MCP_COMMAND: "bun server.ts",
          SQUID_SEARCH_EGRESS: value,
        },
      );
      expect(resolution).toHaveProperty("configError");
    }
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

  it("requires some confirmation mode when a confirmation timeout is configured", async () => {
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

  /**
   * The graphical surface needs a spawnable command, and every one of these
   * checks has to land before the MCP transport opens — an `unreachable`
   * runtime and ledger are what prove that. A graphical mode that resolved far
   * enough to open a server and only then discovered it had no window to draw
   * in would leave a live connection behind with nothing able to confirm
   * through it.
   */
  it("requires a graphical UI command for graphical confirmation", async () => {
    const resolution = await resolveWatchActions(unreachable("runtime"), unreachable("ledger"), {
      SQUID_ACTIONS: "mcp",
      SQUID_ACTIONS_MCP_COMMAND: "bun run server.ts",
      SQUID_ACTION_CONFIRM: "graphical",
      SQUID_ACTION_WORKDIR: "/workspace",
    });
    expect(resolution).toHaveProperty("configError");
  });

  it("rejects a graphical UI command without graphical confirmation", async () => {
    for (const confirmationMode of [undefined, "terminal"]) {
      const resolution = await resolveWatchActions(unreachable("runtime"), unreachable("ledger"), {
        SQUID_ACTIONS: "mcp",
        SQUID_ACTIONS_MCP_COMMAND: "bun run server.ts",
        SQUID_ACTION_WORKDIR: "/workspace",
        SQUID_GRAPHICAL_UI_COMMAND: "squid-ui",
        ...(confirmationMode === undefined ? {} : { SQUID_ACTION_CONFIRM: confirmationMode }),
      });
      expect(resolution).toHaveProperty("configError");
    }
  });

  it("rejects a graphical UI command that would need a shell", async () => {
    for (const command of ["squid-ui && echo nope", "squid-ui $HOME", "squid-ui `echo x`"]) {
      const resolution = await resolveWatchActions(unreachable("runtime"), unreachable("ledger"), {
        SQUID_ACTIONS: "mcp",
        SQUID_ACTIONS_MCP_COMMAND: "bun run server.ts",
        SQUID_ACTION_CONFIRM: "graphical",
        SQUID_ACTION_WORKDIR: "/workspace",
        SQUID_GRAPHICAL_UI_COMMAND: command,
      });
      expect(resolution).toMatchObject({
        configError: expect.stringContaining("SQUID_GRAPHICAL_UI_COMMAND"),
      });
    }
  });

  it("requires a working directory for graphical confirmation", async () => {
    const resolution = await resolveWatchActions(unreachable("runtime"), unreachable("ledger"), {
      SQUID_ACTIONS: "mcp",
      SQUID_ACTIONS_MCP_COMMAND: "bun run server.ts",
      SQUID_ACTION_CONFIRM: "graphical",
      SQUID_GRAPHICAL_UI_COMMAND: "squid-ui",
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

/**
 * The mapping from a validated mode to a live surface.
 *
 * Every `resolveWatchActions` test above asserts a config *error*, because a
 * successful resolution opens an MCP transport and these tests deliberately pass
 * unreachable dependencies. That left the mapping itself unexercised: a swapped
 * branch would have produced a terminal prompt for `graphical` and no test would
 * have noticed. `createConfirmation` is where the mapping lives, so it is tested
 * where it can be observed — including through a real spawned process.
 */
describe("createConfirmation", () => {
  const plan: CapabilityActionPlan = {
    kind: "run_tests",
    tool: "run_command",
    arguments: { command: "cd /workspace && bun test" },
    summary: "cd /workspace && bun test",
    confirmation: "required",
  };
  const request = { candidateId: "req:candidate:0", plan, expiresAt: "2030-01-01T00:01:00.000Z" };
  const stub = `${import.meta.dir}/fixtures/graphical-ui/stub.mjs`;

  it("builds the terminal surface for terminal mode", () => {
    const policy = createConfirmation({ mode: "terminal" });
    expect(policy.surfaceId).toBe("terminal");
  });

  it("builds the graphical surface for graphical mode", () => {
    const policy = createConfirmation({ mode: "graphical", command: "squid-ui", args: [] });
    expect(policy.surfaceId).toBe("graphical");
  });

  // The end-to-end path a `SQUID_ACTION_CONFIRM=graphical` run takes: mode to
  // surface to transport to a spawned process, one prompt over the wire, one
  // correlated answer back, one decision. Each layer has its own tests; this is
  // the one that fails if they are correct individually and misconnected.
  it("carries a real prompt to a spawned process and back", async () => {
    const policy = createConfirmation({
      mode: "graphical",
      command: process.execPath,
      args: [stub, "approve"],
    });
    expect(await policy.confirm(request)).toEqual({
      outcome: "accepted",
      reason: "user_accepted",
    });
    await policy.close?.();
  });

  it("refuses when the spawned UI declines", async () => {
    const policy = createConfirmation({
      mode: "graphical",
      command: process.execPath,
      args: [stub, "decline"],
    });
    expect(await policy.confirm(request)).toEqual({
      outcome: "rejected",
      reason: "user_rejected",
    });
    await policy.close?.();
  });

  // A missing binary is the likeliest production failure — the Rust crate is not
  // built, or the path is wrong. It must read as a closed surface, never as
  // consent, and the timeout must not be what discovers it.
  it("fails closed when the UI binary does not exist", async () => {
    const policy = createConfirmation({
      mode: "graphical",
      command: `${import.meta.dir}/fixtures/graphical-ui/no-such-binary`,
      args: [],
    });
    expect(await policy.confirm(request)).toEqual({
      outcome: "rejected",
      reason: "input_closed",
    });
    await policy.close?.();
  });

  // The engine's own deadline, reached through the graphical surface rather than
  // a stub transport: a UI that reads the prompt and never answers is a timeout,
  // and `close()` has to reach the still-running child through two layers.
  it("times out a UI that never answers, and closes it", async () => {
    const policy = createConfirmation(
      { mode: "graphical", command: process.execPath, args: [stub, "silent"] },
      { timeoutMs: 40 },
    );
    expect(await policy.confirm(request)).toEqual({
      outcome: "rejected",
      reason: "timed_out",
    });
    await policy.close?.();
  });
});

describe("parseLiteralCommand", () => {
  it("preserves quoted arguments without starting a shell", () => {
    expect(parseLiteralCommand('bun run "/tmp/server with spaces.ts"', "SQUID_ACTIONS_MCP_COMMAND")).toEqual({
      command: "bun",
      args: ["run", "/tmp/server with spaces.ts"],
    });
  });

  it("rejects an empty executable", () => {
    expect(parseLiteralCommand('\"\"', "SQUID_ACTIONS_MCP_COMMAND")).toHaveProperty("configError");
  });

  it("rejects operators, variables, comments, and globs", () => {
    for (const command of [
      "bun run server.ts && echo nope",
      "bun run $HOME/server.ts",
      "bun run server.ts # hidden",
      "bun run *.ts",
      "bun run `echo server.ts`",
    ]) {
      expect(parseLiteralCommand(command, "SQUID_ACTIONS_MCP_COMMAND")).toHaveProperty("configError");
    }
  });

  /**
   * More than one variable now holds a spawnable command. A config error that
   * blames the wrong one sends the operator to edit a variable that is already
   * correct, so the message has to name the variable the value came from.
   */
  it("blames the variable the command came from", () => {
    for (const rejected of ["", "bun run `echo ui`", "bun run $HOME/ui"]) {
      const result = parseLiteralCommand(rejected, "SQUID_GRAPHICAL_UI_COMMAND");
      expect(result).toHaveProperty("configError");
      const { configError } = result as { readonly configError: string };
      expect(configError).toContain("SQUID_GRAPHICAL_UI_COMMAND");
      expect(configError).not.toContain("SQUID_ACTIONS_MCP_COMMAND");
    }
  });
});

describe("egress policy agreement", () => {
  /**
   * The runtime stamps its egress policy id onto every attempt, and admission
   * compares that id against the policy the dispatcher presents. If the two were
   * resolved independently, enabling search egress would stamp one id and
   * dispatch another, refusing *every* action — including run_tests, which has
   * nothing to do with egress. This asserts the whole chain agrees when built
   * the way the entry points build it.
   */
  it("admits a run_tests action when search egress is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "squid-egress-"));
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "tests", "foo.test.ts"), "", "utf8");
    const resolvedEgress = resolveSearchEgress("allow");
    if ("configError" in resolvedEgress) throw new Error("expected a policy");

    const candidates = [candidate("run_tests", {
      confidence: 0.9,
      parameters: { path: "tests/foo.test.ts" },
    })];
    const confirmation: ActionConfirmationPolicy = {
      confirm: async () => ({ outcome: "accepted", reason: "user_accepted" }),
    };
    const { commands, dispatcher, requestId, egressPolicy, close } = await setup({
      candidates,
      events: editorSave("tests/foo.test.ts"),
      confirmation,
      workingDirectory: root,
      // Built exactly as an entry point would: one policy for both sides.
      egressPolicy: resolvedEgress,
    });

    const result = await dispatchTopCandidate(
      { requestId },
      candidates,
      dispatcher,
      { egressPolicy, workingDirectory: root, project: bunProject },
    );

    expect(result?.status).toBe("dispatched");
    expect(commands).toHaveLength(1);
    await close();
  });
});

describe("dispatchTopCandidate", () => {
  it("dispatches the search_selection candidate when egress is allowed", async () => {
    const candidates = [candidate("search_selection", {
      confidence: 0.8,
      parameters: { selection: "typebox" },
    })];
    const { queries, dispatcher, requestId, egressPolicy, close } = await setup({
      candidates,
      events: browserSelection("typebox"),
    });

    const result = await dispatchTopCandidate(
      { requestId },
      candidates,
      dispatcher,
      { egressPolicy },
    );

    expect(result?.status).toBe("dispatched");
    expect(result?.action?.outcome).toBe("succeeded");
    expect(queries).toEqual(["typebox"]);
    await close();
  });

  it("refuses a search with zero tool calls when egress is denied", async () => {
    const candidates = [candidate("search_selection", {
      confidence: 0.8,
      parameters: { selection: "typebox" },
    })];
    const { queries, dispatcher, requestId, egressPolicy, close } = await setup({
      candidates,
      events: browserSelection("typebox"),
      egressPolicy: DENY,
    });

    const result = await dispatchTopCandidate(
      { requestId },
      candidates,
      dispatcher,
      { egressPolicy },
    );

    expect(result?.status).toBe("not_admitted");
    expect(queries).toEqual([]);
    await close();
  });

  it("refuses a search whose selection changed since the prediction", async () => {
    const candidates = [candidate("search_selection", {
      confidence: 0.8,
      parameters: { selection: "stale text" },
    })];
    const { queries, dispatcher, requestId, egressPolicy, close } = await setup({
      candidates,
      // The world holds a different selection than the candidate predicted on.
      events: browserSelection("current text"),
    });

    const result = await dispatchTopCandidate(
      { requestId },
      candidates,
      dispatcher,
      { egressPolicy },
    );

    expect(result?.status).toBe("not_admitted");
    expect(result?.reasonCode).toBe("selection_changed");
    expect(queries).toEqual([]);
    await close();
  });

  it("keeps run_tests off when no confirmation policy is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "squid-watch-"));
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "tests", "foo.test.ts"), "", "utf8");
    const candidates = [candidate("run_tests", {
      confidence: 0.9,
      parameters: { path: "tests/foo.test.ts" },
    })];
    // Dispatched through a restamped required plan rather than the live path:
    // descriptors are bypassed by decision (issue #11), so a real plan no longer
    // asks for confirmation — but a plan that *does* must still be refused when
    // nothing is wired to ask. This is coverage of that refusal.
    const { commands, dispatcher, requestId, egressPolicy, close } = await setup({
      candidates,
      events: editorSave("tests/foo.test.ts"),
      workingDirectory: root,
      egressPolicy: DENY,
    });
    const { plan, planned } = await restampedRequiredPlan(root, requestId);

    const result = await dispatcher.dispatch({
      plan,
      planDigest: digestActionPlan(plan),
      candidateParametersDigest: planned.candidateParametersDigest,
      candidate: candidates[0]!,
      egressPolicy: DENY,
    });

    expect(result.status).toBe("not_accepted");
    expect(result.reasonCode).toBe("confirmation_policy_missing");
    expect(commands).toEqual([]);
    await close();
  });

  it("runs the confirmed run_tests command exactly as planned", async () => {
    const root = await mkdtemp(join(tmpdir(), "squid-watch-"));
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "tests", "foo.test.ts"), "", "utf8");
    const candidates = [candidate("run_tests", {
      confidence: 0.9,
      parameters: { path: "tests/foo.test.ts" },
    })];
    const confirmation: ActionConfirmationPolicy = {
      confirm: async () => ({ outcome: "accepted", reason: "user_accepted" }),
    };
    const { commands, dispatcher, requestId, egressPolicy, close } = await setup({
      candidates,
      events: editorSave("tests/foo.test.ts"),
      confirmation,
      workingDirectory: root,
      egressPolicy: DENY,
    });

    const result = await dispatchTopCandidate(
      { requestId },
      candidates,
      dispatcher,
      { egressPolicy, workingDirectory: root, project: bunProject },
    );

    expect(result?.status).toBe("dispatched");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("bun test -- tests/foo.test.ts");
    await close();
  });

  it("records rejection and never invokes the gateway", async () => {
    const root = await mkdtemp(join(tmpdir(), "squid-watch-"));
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "tests", "foo.test.ts"), "", "utf8");
    const candidates = [candidate("run_tests", {
      confidence: 0.9,
      parameters: { path: "tests/foo.test.ts" },
    })];
    const confirmation: ActionConfirmationPolicy = {
      confirm: async () => ({ outcome: "rejected", reason: "user_rejected" }),
    };
    // Required plan restamped for the same reason as the missing-policy test
    // above: the mechanism is what is under test, not the current declaration.
    const { commands, ledger, dispatcher, requestId, close } = await setup({
      candidates,
      events: editorSave("tests/foo.test.ts"),
      confirmation,
      workingDirectory: root,
      egressPolicy: DENY,
    });
    const { plan, planned } = await restampedRequiredPlan(root, requestId);

    const result = await dispatcher.dispatch({
      plan,
      planDigest: digestActionPlan(plan),
      candidateParametersDigest: planned.candidateParametersDigest,
      candidate: candidates[0]!,
      egressPolicy: DENY,
    });

    expect(result.status).toBe("not_accepted");
    expect(result.reasonCode).toBe("user_rejected");
    expect(commands).toEqual([]);
    const records = await ledger.all();
    expect(records.filter((r) => r.recordType === "plan_decision")).toHaveLength(1);
    expect(records.filter((r) => r.recordType === "plan_dispatch")).toHaveLength(0);
    await close();
  });

  it("never dispatches from a late trigger, even with a perfect candidate", async () => {
    // A late event reprojects history; its prediction is observational only.
    const candidates = [candidate("search_selection", {
      confidence: 0.9,
      parameters: { selection: "typebox" },
    })];
    const { queries, ledger, dispatcher, requestId, egressPolicy, close } = await setup({
      candidates,
      events: browserSelection("typebox"),
    });

    const result = await dispatchTopCandidate(
      { requestId },
      candidates,
      dispatcher,
      { egressPolicy, triggerDisposition: "late" },
    );

    // Refused before planning: no plan record, no claim, no tool call.
    expect(result).toBeNull();
    expect(queries).toEqual([]);
    const records = await ledger.all();
    expect(records.filter((r) => r.recordType === "plan")).toHaveLength(0);
    expect(records.filter((r) => r.recordType === "plan_dispatch")).toHaveLength(0);
    await close();
  });

  it("skips an expired candidate instead of acting on stale context", async () => {
    const candidates = [candidate("search_selection", {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      parameters: { selection: "stale" },
    })];
    const { queries, dispatcher, requestId, egressPolicy, close } = await setup({
      candidates,
      events: browserSelection("stale"),
    });

    const result = await dispatchTopCandidate(
      { requestId },
      candidates,
      dispatcher,
      { egressPolicy },
    );

    expect(result).toBeNull();
    expect(queries).toEqual([]);
    await close();
  });

  it("considers only the top candidate and never downgrades to a lower one", async () => {
    // The top candidate is unmappable; a system that fell back would run the
    // search instead, quietly doing something the ranking did not choose.
    const candidates = [
      candidate("draft_completion", { confidence: 0.9, parameters: { prefix: "x" } }),
      candidate("search_selection", { confidence: 0.2, parameters: { selection: "typebox" } }),
    ];
    const { queries, dispatcher, requestId, egressPolicy, close } = await setup({
      candidates,
      events: browserSelection("typebox"),
    });

    const result = await dispatchTopCandidate(
      { requestId },
      candidates,
      dispatcher,
      { egressPolicy },
    );

    expect(result).toBeNull();
    expect(queries).toEqual([]);
    await close();
  });

  it("picks the higher-confidence candidate when several are actionable", async () => {
    const candidates = [
      candidate("search_selection", { confidence: 0.1, parameters: { selection: "low" } }),
      candidate("search_selection", { confidence: 0.8, parameters: { selection: "typebox" } }),
    ];
    const { queries, dispatcher, requestId, egressPolicy, close } = await setup({
      candidates,
      events: browserSelection("typebox"),
    });

    const result = await dispatchTopCandidate(
      { requestId },
      candidates,
      dispatcher,
      { egressPolicy },
    );

    expect(result?.status).toBe("dispatched");
    expect(queries).toEqual(["typebox"]);
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
