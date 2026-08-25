import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  SEARCH_EGRESS_DENY_ID,
  type EgressPolicy,
} from "../src/action-egress.js";
import { RedactingContextPolicy } from "../src/context-policy.js";
import { CapabilityDispatcher } from "../src/capability-gateway.js";
import { InMemoryEventStore } from "../src/event-store.js";
import { FakePredictionProvider, candidate } from "../src/fake-prediction-provider.js";
import { McpCapabilityGateway } from "../src/mcp-gateway.js";
import { PredictionCoordinator } from "../src/prediction-coordinator.js";
import { InMemoryPredictionLedger } from "../src/prediction-ledger.js";
import { PredictionRuntime } from "../src/prediction-runtime.js";
import { createActivityEvent, type ActivityEvent } from "../src/protocol.js";
import { SquidCore } from "../src/squid-core.js";
import { dispatchTopCandidate, uniqueSaveTarget } from "../src/watch-actions.js";
import { bunProject } from "./fixtures/bun-project.js";

/**
 * The acceptance test for issue #9.
 *
 * Under a redacting projection the model is shown a basename where raw state
 * holds a path, and a selection capped at `maxTextLength` where raw state holds
 * more. Before this fix both shapes were refused by admission as generic
 * mismatches — `saved_path_mismatch` and `selection_changed` — so two
 * capabilities were quietly unavailable in exactly the modes a model runs in,
 * with nothing naming why.
 *
 * What these tests pin:
 *
 * - A basename proposal resolves against the triggering ingest's *raw* saves
 *   and dispatches for a nested file; a root-level file keeps working (its
 *   basename happens to be its whole relative path).
 * - Two saves sharing a basename refuse rather than guess.
 * - The identity checks issue #9 says must not weaken still hold: a suffix
 *   match and a symlinked sibling stay refused. Those live in
 *   `tests/action-admission.test.ts`; here they are re-proven through the
 *   resolution path, because that path is what could have weakened them.
 * - A capped selection refuses as `selection_truncated`, naming redaction as
 *   the cause instead of claiming the selection changed.
 */

const DENY: EgressPolicy = { id: SEARCH_EGRESS_DENY_ID, searchEgress: "deny" };
const SESSION = "redacted-session";

const nextRequestId = () => {
  let sequence = 0;
  return () => `redacted-${++sequence}`;
};

async function connectRunCommandServer(commands: string[]): Promise<Client> {
  const server = new McpServer({ name: "run-server", version: "0.0.1" });
  server.registerTool(
    "run_command",
    { inputSchema: { command: z.string().min(1) } },
    async ({ command }) => {
      commands.push(command);
      return { content: [{ type: "text", text: "ok" }] };
    },
  );
  const client = new Client({ name: "squid-test", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

/**
 * A save the editor-save source produces: the path and who wrote it. The
 * attribution is what makes run_tests reachable at all — the guard requires
 * the newest save's owner to equal the foreground application — and it is
 * exactly what `SQUID_EDITOR_SAVES=fifo` exists to supply.
 *
 * The explicit `occurredAt` is what makes the ordering deterministic. Events
 * created in the same millisecond tie on time and fall back to comparing
 * source kinds — where "filesystem" sorts before "host", silently turning the
 * newest save into a late event and refusing every dispatch with
 * `trigger_disposition_late`. Stamping saves strictly after the host facts is
 * the order a live desktop produces.
 */
const BASE_TIME = Date.parse("2026-08-25T12:00:00.000Z");
let saveOffset = 0;
function fileSaved(path: string): ActivityEvent {
  saveOffset += 1;
  return createActivityEvent({
    kind: "file_saved",
    eventId: `e-save-${saveOffset}`,
    source: { kind: "filesystem", instanceId: "fs-1" },
    sessionId: SESSION,
    sequence: saveOffset,
    occurredAt: new Date(BASE_TIME + 10_000 + saveOffset).toISOString(),
    payload: { path, applicationId: "vscode" },
  });
}

let hostOffset = 0;
function hostEvent(kind: "application_activated" | "window_changed" | "focus_changed"): ActivityEvent {
  hostOffset += 1;
  const payloads = {
    application_activated: { applicationId: "vscode", applicationName: "Visual Studio Code" },
    window_changed: { applicationId: "vscode", title: "main.test.ts", bounds: null },
    focus_changed: { applicationId: "vscode", windowTitle: "main.test.ts", role: "editor", label: null },
  } as const;
  return createActivityEvent({
    kind,
    eventId: `e-host-${hostOffset}`,
    source: { kind: "host", instanceId: "screen-1" },
    sessionId: SESSION,
    sequence: hostOffset,
    occurredAt: new Date(BASE_TIME + hostOffset).toISOString(),
    payload: payloads[kind],
  });
}

/**
 * The world after an editor-attributed save, projected through the redacting
 * policy — exactly what a model-mode provider sees. The candidate it would
 * produce for run_tests carries the basename of the saved file.
 */
async function setupRedacted(options: {
  readonly root: string;
  /** Raw save targets; the last one is the newest save the guard checks. */
  readonly savePaths: readonly string[];
}) {
  const commands: string[] = [];
  const client = await connectRunCommandServer(commands);
  const ledger = new InMemoryPredictionLedger();
  const policy = new RedactingContextPolicy();

  // The provider answers from the *projected* state, exactly as a real
  // model-mode one does: it proposes run_tests for the newest save's target
  // as it saw it — a basename. Building the candidate inside `predict` also
  // means the attempt record in the ledger holds this same candidate, which is
  // what admission later verifies the dispatched parameters against.
  const runtime = new PredictionRuntime(
    new SquidCore(new InMemoryEventStore()),
    new PredictionCoordinator({
      provider: {
        name: "model",
        predict: async (request) => {
          const latestSave = request.worldState.recentActions.find(
            (action) => action.kind === "file_saved",
          );
          if (latestSave === undefined) return [];
          return [
            candidate("run_tests", 0.9, { path: latestSave.target }, "run_tests"),
          ];
        },
      },
      contextPolicy: policy,
      random: nextRequestId(),
    }),
    {
      ledger,
      runtimeSessionId: SESSION,
      actionTrust: "trusted",
      egressPolicyId: DENY.id,
    },
  );

  let rawState = null;
  let requestId = "";
  let proposed: ReturnType<typeof candidate> | null = null;
  const events: ActivityEvent[] = [
    hostEvent("application_activated"),
    hostEvent("window_changed"),
    hostEvent("focus_changed"),
  ];
  for (const savePath of options.savePaths) {
    events.push(fileSaved(savePath));
  }
  for (const event of events) {
    const ingested = await runtime.ingest(event);
    if (ingested.ingest !== null) rawState = ingested.ingest.state;
    if (ingested.prediction !== null) {
      const outcome = await ingested.prediction;
      requestId = outcome.requestId;
      proposed = outcome.candidates[0] ?? null;
    }
  }
  await runtime.awaitIdle();

  if (rawState === null || proposed === null || requestId === "") {
    throw new Error("setup produced no projection or no candidate");
  }
  const dispatcher = new CapabilityDispatcher({ runtime, gateway: new McpCapabilityGateway({ client }), ledger });

  return {
    commands,
    dispatcher,
    requestId,
    rawState,
    projectedState: policy.project(rawState),
    proposed: proposed as ReturnType<typeof candidate>,
    close: async () => {
      await runtime.dispose();
      await client.close();
    },
  };
}

describe("run_tests under a redacting provider (issue #9)", () => {
  it("dispatches a nested file resolved from the raw saves", async () => {
    const root = await mkdtemp(join(tmpdir(), "squid-redacted-"));
    await mkdir(join(root, "src", "deep"), { recursive: true });
    await writeFile(join(root, "src", "deep", "main.test.ts"), "", "utf8");

    const setup = await setupRedacted({
      root,
      savePaths: ["src/deep/main.test.ts"],
    });

    const result = await dispatchTopCandidate(
      { requestId: setup.requestId },
      [setup.proposed],
      setup.dispatcher,
      {
        egressPolicy: DENY,
        workingDirectory: root,
        project: bunProject,
        resolveRedactedSave: (base) => uniqueSaveTarget(setup.rawState!, base),
      },
    );

    expect(result?.status).toBe("dispatched");
    expect(setup.commands).toHaveLength(1);
    expect(setup.commands[0]).toContain("bun test -- src/deep/main.test.ts");
    await setup.close();
  });

  it("keeps dispatching a root-level file whose basename is its whole path", async () => {
    const root = await mkdtemp(join(tmpdir(), "squid-redacted-"));
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "tests", "foo.test.ts"), "", "utf8");

    const setup = await setupRedacted({
      root,
      savePaths: ["tests/foo.test.ts"],
    });

    const result = await dispatchTopCandidate(
      { requestId: setup.requestId },
      [setup.proposed],
      setup.dispatcher,
      {
        egressPolicy: DENY,
        workingDirectory: root,
        project: bunProject,
        resolveRedactedSave: (base) => uniqueSaveTarget(setup.rawState!, base),
      },
    );

    expect(result?.status).toBe("dispatched");
    expect(setup.commands[0]).toContain("bun test -- tests/foo.test.ts");
    await setup.close();
  });

  it("refuses when two saves share the basename, rather than guessing", async () => {
    const root = await mkdtemp(join(tmpdir(), "squid-redacted-"));
    await mkdir(join(root, "a"), { recursive: true });
    await mkdir(join(root, "b"), { recursive: true });
    await writeFile(join(root, "a", "same.test.ts"), "", "utf8");
    await writeFile(join(root, "b", "same.test.ts"), "", "utf8");

    const setup = await setupRedacted({
      root,
      savePaths: ["a/same.test.ts", "b/same.test.ts"],
    });

    // The raw state itself carries both saves, so the honest resolver —
    // `uniqueSaveTarget` over it — has two matches and answers null. The plan
    // is never built; nothing renders and nothing runs.
    expect(uniqueSaveTarget(setup.rawState!, "same.test.ts")).toBeNull();

    const result = await dispatchTopCandidate(
      { requestId: setup.requestId },
      [setup.proposed],
      setup.dispatcher,
      {
        egressPolicy: DENY,
        workingDirectory: root,
        project: bunProject,
        resolveRedactedSave: (base) => uniqueSaveTarget(setup.rawState!, base),
      },
    );

    expect(result).toBeNull();
    expect(setup.commands).toEqual([]);
    await setup.close();
  });

  it("runs nothing when the proposed basename matches no save — no endsWith widening", async () => {
    const root = await mkdtemp(join(tmpdir(), "squid-redacted-"));
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "xa.ts"), "", "utf8");
    await writeFile(join(root, "a.ts"), "", "utf8");

    const setup = await setupRedacted({
      root,
      savePaths: ["a.ts"],
    });
    // The provider proposed for what it was shown (`a.ts`); a candidate naming
    // `xa.ts` is a hallucination. The resolver must not find it by suffix —
    // that would be the endsWith bug returning — so no save named xa.ts means
    // planning refuses outright and nothing renders.
    const hallucinated = candidate(
      "run_tests", 0.9, { path: "xa.ts" }, "run_tests",
    );

    const result = await dispatchTopCandidate(
      { requestId: setup.requestId },
      [hallucinated],
      setup.dispatcher,
      {
        egressPolicy: DENY,
        workingDirectory: root,
        project: bunProject,
        resolveRedactedSave: (base) => uniqueSaveTarget(setup.rawState!, base),
      },
    );

    expect(result).toBeNull();
    expect(setup.commands).toEqual([]);
    await setup.close();
  });

});
