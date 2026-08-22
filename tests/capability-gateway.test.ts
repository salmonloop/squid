import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryEventStore } from "../src/event-store.js";
import { FakePredictionProvider, candidate } from "../src/fake-prediction-provider.js";
import { PredictionCoordinator } from "../src/prediction-coordinator.js";
import {
  CapabilityDispatcher,
  FakeCapabilityGateway,
  type DispatchRequest,
} from "../src/capability-gateway.js";
import { digestActionPlan, type ImmutableActionPlan } from "../src/action-plan.js";
import { isPlanFailure, planAction } from "../src/action-planner.js";
import { SEARCH_EGRESS_DENY_ID, type EgressPolicy } from "../src/action-egress.js";
import { InMemoryPredictionLedger } from "../src/prediction-ledger.js";
import { PredictionRuntime } from "../src/prediction-runtime.js";
import { createActivityEvent, type PredictionCandidate } from "../src/protocol.js";
import { SquidCore } from "../src/squid-core.js";
import type {
  ActionConfirmationDecision,
  ActionConfirmationPolicy,
} from "../src/action-confirmation.js";

const RUNTIME_SESSION = "session-dispatch";
const DENY_POLICY: EgressPolicy = { id: SEARCH_EGRESS_DENY_ID, searchEgress: "deny" };

const nextRequestId = () => {
  let sequence = 0;
  return () => `dispatch-${++sequence}`;
};

/** Accepts or refuses every plan without touching a terminal. */
class ScriptedConfirmation implements ActionConfirmationPolicy {
  public readonly seen: ImmutableActionPlan[] = [];

  public constructor(private readonly decision: ActionConfirmationDecision) {}

  public async confirm(request: { readonly plan: ImmutableActionPlan }) {
    this.seen.push(request.plan);
    return this.decision;
  }
}

/**
 * A world where `run_tests` admission passes: a coding app in front, and the
 * newest save naming the file the plan targets.
 */
async function savedInEditor(root: string, eventId = "saved-1") {
  return [
    createActivityEvent({
      kind: "application_activated",
      eventId: `${eventId}-app`,
      payload: { applicationId: "vscode", applicationName: "Code" },
    }),
    createActivityEvent({
      kind: "window_changed",
      eventId: `${eventId}-window`,
      payload: {
        applicationId: "vscode",
        title: "main.ts",
        bounds: { x: 0, y: 0, width: 100, height: 100 },
      },
    }),
    createActivityEvent({
      kind: "file_saved",
      eventId,
      payload: { path: "tests/x.test.ts", applicationId: "vscode" },
    }),
  ];
}

async function setup(options: {
  readonly gatewayOutcome?: "succeeded" | "failed";
  readonly gatewayError?: Error;
  readonly gatewayDetails?: Record<string, string | number | boolean | null>;
  readonly confirmation?: ActionConfirmationPolicy;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "squid-dispatch-"));
  const ledger = new InMemoryPredictionLedger();
  const runtime = new PredictionRuntime(
    new SquidCore(new InMemoryEventStore()),
    new PredictionCoordinator({
      provider: new FakePredictionProvider({
        candidates: [candidate("run_tests", 0.9, { path: "tests/x.test.ts" })],
      }),
      random: nextRequestId(),
    }),
    {
      ledger,
      runtimeSessionId: RUNTIME_SESSION,
      actionTrust: "trusted",
      egressPolicyId: SEARCH_EGRESS_DENY_ID,
    },
  );
  const gateway = new FakeCapabilityGateway({
    ...(options.gatewayOutcome === undefined ? {} : { outcome: options.gatewayOutcome }),
    ...(options.gatewayError === undefined ? {} : { error: options.gatewayError }),
    ...(options.gatewayDetails === undefined ? {} : { details: options.gatewayDetails }),
  });
  const dispatcher = new CapabilityDispatcher({
    runtime,
    gateway,
    ledger,
    ...(options.confirmation === undefined ? {} : { confirmation: options.confirmation }),
  });

  let outcome!: { readonly requestId: string; readonly candidates: readonly PredictionCandidate[] };
  for (const event of await savedInEditor(root)) {
    const ingested = await runtime.ingest(event);
    if (ingested.prediction !== null) {
      outcome = await ingested.prediction;
    }
  }
  await runtime.awaitIdle();

  const top = outcome.candidates[0]!;
  const candidateId = `${outcome.requestId}:candidate:0`;
  const planned = await planAction(
    {
      candidateId,
      attemptId: outcome.requestId,
      kind: top.kind,
      parameters: top.parameters,
    },
    { workingDirectory: root },
  );
  if (isPlanFailure(planned)) throw new Error(`planning failed: ${planned.reasonCode}`);

  const request: DispatchRequest = {
    plan: planned.plan,
    planDigest: planned.planDigest,
    candidateParametersDigest: planned.candidateParametersDigest,
    candidate: top,
    egressPolicy: DENY_POLICY,
  };
  return { runtime, ledger, gateway, dispatcher, request, candidateId, root };
}

describe("FakeCapabilityGateway", () => {
  const plan: ImmutableActionPlan = {
    planSchemaVersion: 1,
    kind: "run_tests",
    candidateId: "c-1",
    attemptId: "req-1",
    tool: "run_command",
    arguments: { command: "bun test" },
    summary: "bun test",
    confirmation: "required",
    canonicalWorkingDirectory: "/tmp",
    canonicalTarget: null,
  };

  it("records the exact plan it was given and returns the configured outcome", async () => {
    const gateway = new FakeCapabilityGateway({ id: "test" });
    const result = await gateway.invoke(plan);
    expect(result.outcome).toBe("succeeded");
    expect(result.planDigest).toBe(digestActionPlan(plan));
    expect(gateway.recordedInvocations).toHaveLength(1);
    expect(gateway.recordedInvocations[0]!.tool).toBe("run_command");
  });

  it("returns failure details when configured to fail", async () => {
    const gateway = new FakeCapabilityGateway({
      outcome: "failed",
      details: { reason: "no terminal" },
    });
    const result = await gateway.invoke(plan);
    expect(result.outcome).toBe("failed");
    expect(result.details).toEqual({ reason: "no terminal" });
  });

  it("rejects when configured to throw", async () => {
    const gateway = new FakeCapabilityGateway({ error: new Error("mcp down") });
    await expect(gateway.invoke(plan)).rejects.toThrow("mcp down");
  });
});

describe("CapabilityDispatcher", () => {
  it("records the plan, confirms, claims, and invokes exactly once", async () => {
    const confirmation = new ScriptedConfirmation({ outcome: "accepted", reason: "user_accepted" });
    const { runtime, ledger, gateway, dispatcher, request } = await setup({ confirmation });

    const result = await dispatcher.dispatch(request);

    expect(result.status).toBe("dispatched");
    expect(result.action?.outcome).toBe("succeeded");
    // The gateway saw the same frozen plan the user approved.
    expect(gateway.recordedInvocations).toHaveLength(1);
    expect(digestActionPlan(gateway.recordedInvocations[0]!)).toBe(request.planDigest);
    expect(confirmation.seen[0]!.summary).toBe(request.plan.summary);

    const records = await ledger.all();
    expect(records.filter((r) => r.recordType === "plan")).toHaveLength(1);
    expect(records.filter((r) => r.recordType === "plan_decision")).toHaveLength(1);
    const dispatch = records.filter((r) => r.recordType === "plan_dispatch");
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0]).toMatchObject({ completedOutcome: "succeeded" });
    await runtime.dispose();
  });

  it("never invokes the gateway when the user rejects the plan", async () => {
    const confirmation = new ScriptedConfirmation({ outcome: "rejected", reason: "user_rejected" });
    const { runtime, ledger, gateway, dispatcher, request } = await setup({ confirmation });

    const result = await dispatcher.dispatch(request);

    expect(result.status).toBe("not_accepted");
    expect(result.reasonCode).toBe("user_rejected");
    expect(gateway.recordedInvocations).toHaveLength(0);
    const records = await ledger.all();
    expect(records.filter((r) => r.recordType === "plan_dispatch")).toHaveLength(0);
    expect(records.filter((r) => r.recordType === "plan_decision")).toHaveLength(1);
    await runtime.dispose();
  });

  it("refuses a confirmation-required plan when no policy is wired", async () => {
    const { runtime, gateway, dispatcher, request } = await setup();

    const result = await dispatcher.dispatch(request);

    expect(result.status).toBe("not_accepted");
    expect(result.reasonCode).toBe("confirmation_policy_missing");
    expect(gateway.recordedInvocations).toHaveLength(0);
    await runtime.dispose();
  });

  it("records a structured tool failure as a terminal failed dispatch", async () => {
    const confirmation = new ScriptedConfirmation({ outcome: "accepted", reason: "user_accepted" });
    const { runtime, ledger, dispatcher, request } = await setup({
      confirmation,
      gatewayOutcome: "failed",
      gatewayDetails: { reason: "configured failure" },
    });

    const result = await dispatcher.dispatch(request);

    expect(result.status).toBe("dispatched");
    expect(result.action?.outcome).toBe("failed");
    const dispatch = (await ledger.all()).find((r) => r.recordType === "plan_dispatch");
    expect(dispatch).toMatchObject({ completedOutcome: "failed" });
    await runtime.dispose();
  });

  it("reports reconciliation_required — not failed — when the gateway throws after the claim", async () => {
    const confirmation = new ScriptedConfirmation({ outcome: "accepted", reason: "user_accepted" });
    const { runtime, ledger, dispatcher, request } = await setup({
      confirmation,
      gatewayError: new Error("mcp connection reset"),
    });

    const result = await dispatcher.dispatch(request);

    // The claim happened, so the action may have run. Fabricating "failed"
    // here would invite an automatic retry of a possibly-completed action.
    expect(result.status).toBe("reconciliation_required");
    expect(result.action).toBeNull();
    // A claimed record with no terminal state *is* the reconciliation signal:
    // it survives a crash, whereas a flag written after the fact would not.
    const dispatch = (await ledger.all()).find((r) => r.recordType === "plan_dispatch");
    expect(dispatch).toBeDefined();
    expect(dispatch).not.toHaveProperty("completedOutcome");
    await runtime.dispose();
  });

  it("claims once and refuses the second dispatch of the same plan", async () => {
    const confirmation = new ScriptedConfirmation({ outcome: "accepted", reason: "user_accepted" });
    const { runtime, gateway, dispatcher, request } = await setup({ confirmation });

    const first = await dispatcher.dispatch(request);
    const second = await dispatcher.dispatch(request);

    expect(first.status).toBe("dispatched");
    expect(second.status).toBe("terminal");
    // One claim means exactly one capability invocation, never two.
    expect(gateway.recordedInvocations).toHaveLength(1);
    await runtime.dispose();
  });

  it("refuses to claim when the attempt was never persisted", async () => {
    const confirmation = new ScriptedConfirmation({ outcome: "accepted", reason: "user_accepted" });
    const { runtime, gateway, dispatcher, request } = await setup({ confirmation });

    const unknown: DispatchRequest = {
      ...request,
      plan: { ...request.plan, attemptId: "never-recorded" },
    };
    const result = await dispatcher.dispatch(unknown);

    expect(result.status).toBe("not_admitted");
    expect(result.reasonCode).toBe("attempt_missing");
    expect(gateway.recordedInvocations).toHaveLength(0);
    await runtime.dispose();
  });

  it("keeps raw command text out of the ledger", async () => {
    const confirmation = new ScriptedConfirmation({ outcome: "accepted", reason: "user_accepted" });
    const { runtime, ledger, dispatcher, request, root } = await setup({ confirmation });

    await dispatcher.dispatch(request);

    // The plan's command names the temp root; no ledger record may contain it.
    const serialized = JSON.stringify(await ledger.all());
    expect(request.plan.summary).toContain(root);
    expect(serialized).not.toContain(root);
    await runtime.dispose();
  });

  it("dispatches nothing when the attempt write failed, with zero capability calls", async () => {
    // The prediction was delivered but its attempt never landed durably. There
    // is nothing for a claim to validate against, so the action is refused
    // outright rather than dispatched on an unauditable basis.
    const confirmation = new ScriptedConfirmation({ outcome: "accepted", reason: "user_accepted" });
    const { runtime, ledger, gateway, dispatcher, request } = await setup({ confirmation });

    const orphaned: DispatchRequest = {
      ...request,
      plan: { ...request.plan, attemptId: "attempt-that-never-persisted" },
    };
    const result = await dispatcher.dispatch(orphaned);

    expect(result.status).toBe("not_admitted");
    expect(result.reasonCode).toBe("attempt_missing");
    expect(gateway.recordedInvocations).toHaveLength(0);
    const records = await ledger.all();
    expect(records.filter((r) => r.recordType === "plan_dispatch")).toHaveLength(0);
    // Not even the plan is recorded: its reference could not be validated.
    expect(records.filter((r) => r.recordType === "plan")).toHaveLength(0);
    await runtime.dispose();
  });
});
