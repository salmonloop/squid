import { describe, expect, it } from "bun:test";
import { InMemoryEventStore } from "../src/event-store.js";
import { FakePredictionProvider, candidate } from "../src/fake-prediction-provider.js";
import { PredictionCoordinator } from "../src/prediction-coordinator.js";
import {
  CapabilityDispatcher,
  FakeCapabilityGateway,
} from "../src/capability-gateway.js";
import { InMemoryPredictionLedger } from "../src/prediction-ledger.js";
import { PredictionRuntime } from "../src/prediction-runtime.js";
import { createActivityEvent } from "../src/protocol.js";
import { SquidCore } from "../src/squid-core.js";

const nextRequestId = () => {
  let sequence = 0;
  return () => `dispatch-${++sequence}`;
};

const nextFeedbackId = () => {
  let sequence = 0;
  return () => `seq-${++sequence}`;
};

function savedFile(eventId = "saved-1") {
  return createActivityEvent({
    kind: "file_saved",
    eventId,
    payload: { path: "src/main.ts", applicationId: "editor" },
  });
}

async function setup(opts: {
  gatewayOutcome?: "succeeded" | "failed";
  gatewayError?: Error;
  gatewayDetails?: Record<string, string | number | boolean | null>;
} = {}) {
  const ledger = new InMemoryPredictionLedger();
  const runtime = new PredictionRuntime(
    new SquidCore(new InMemoryEventStore()),
    new PredictionCoordinator({
      provider: new FakePredictionProvider({ candidates: [candidate("run_tests")] }),
      random: nextRequestId(),
    }),
    { ledger, now: () => new Date("2026-08-19T10:00:00.000Z") },
  );
  const gateway = new FakeCapabilityGateway({
    outcome: opts.gatewayOutcome,
    error: opts.gatewayError,
    details: opts.gatewayDetails,
  });
  const dispatcher = new CapabilityDispatcher({
    runtime,
    gateway,
    ledger,
    random: nextFeedbackId(),
  });
  const result = await runtime.ingest(savedFile());
  const outcome = await result.prediction!;
  await runtime.awaitIdle();
  return { runtime, ledger, gateway, dispatcher, candidateId: `${outcome.requestId}:candidate:0` };
}

describe("FakeCapabilityGateway", () => {
  it("records invocations and returns the configured outcome", async () => {
    const gateway = new FakeCapabilityGateway({ id: "test" });
    const result = await gateway.invoke({
      candidateId: "c-1",
      kind: "run_tests",
      parameters: { target: "src/main.ts" },
    });
    expect(result.outcome).toBe("succeeded");
    expect(result.candidateId).toBe("c-1");
    expect(gateway.recordedInvocations).toHaveLength(1);
    expect(gateway.recordedInvocations[0].kind).toBe("run_tests");
  });

  it("returns failure details when configured to fail", async () => {
    const gateway = new FakeCapabilityGateway({
      outcome: "failed",
      details: { reason: "no terminal" },
    });
    const result = await gateway.invoke({ candidateId: "c-1", kind: "run_tests", parameters: {} });
    expect(result.outcome).toBe("failed");
    expect(result.details).toEqual({ reason: "no terminal" });
  });

  it("rejects when configured to throw", async () => {
    const gateway = new FakeCapabilityGateway({ error: new Error("mcp down") });
    await expect(gateway.invoke({ candidateId: "c-1", kind: "run_tests", parameters: {} }))
      .rejects.toThrow("mcp down");
  });
});

describe("CapabilityDispatcher", () => {
  it("dispatches an accepted candidate and records succeeded feedback", async () => {
    const { runtime, ledger, gateway, dispatcher, candidateId } = await setup();

    const result = await dispatcher.dispatch(candidateId);

    expect(result.outcome).toBe("succeeded");
    expect(gateway.recordedInvocations).toHaveLength(1);
    expect(gateway.recordedInvocations[0].candidateId).toBe(candidateId);
    expect(gateway.recordedInvocations[0].kind).toBe("run_tests");

    const feedback = (await ledger.all()).filter((r) => r.recordType === "feedback");
    expect(feedback.map((r) => r.feedback)).toEqual(["dispatched", "succeeded"]);
    expect(feedback.every((r) => r.candidateId === candidateId)).toBe(true);
    await runtime.dispose();
  });

  it("records failed feedback when the gateway fails", async () => {
    const { runtime, ledger, dispatcher, candidateId } = await setup({
      gatewayOutcome: "failed",
      gatewayDetails: { reason: "configured failure" },
    });

    const result = await dispatcher.dispatch(candidateId);

    expect(result.outcome).toBe("failed");
    const feedback = (await ledger.all()).filter((r) => r.recordType === "feedback");
    expect(feedback.map((r) => r.feedback)).toEqual(["dispatched", "failed"]);
    const failed = feedback.find((r) => r.feedback === "failed")!;
    expect(failed.details.gateway).toBe("fake-capability");
    expect(failed.details.reason).toBe("configured failure");
    await runtime.dispose();
  });

  it("turns a thrown gateway invocation into a failed result", async () => {
    const { runtime, ledger, dispatcher, candidateId } = await setup({
      gatewayError: new Error("mcp connection reset"),
    });

    const result = await dispatcher.dispatch(candidateId);

    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("mcp connection reset");
    const feedback = (await ledger.all()).filter((r) => r.recordType === "feedback");
    expect(feedback.map((r) => r.feedback)).toEqual(["dispatched", "failed"]);
    expect(feedback.find((r) => r.feedback === "failed")!.details.error).toBe("mcp connection reset");
    await runtime.dispose();
  });

  it("keeps its own attribution when a gateway reports conflicting details", async () => {
    const { runtime, ledger, dispatcher, candidateId } = await setup({
      gatewayOutcome: "failed",
      gatewayDetails: { gateway: "impersonated", reason: "kept" },
    });

    await dispatcher.dispatch(candidateId);

    const failed = (await ledger.all())
      .filter((r) => r.recordType === "feedback")
      .find((r) => r.feedback === "failed")!;
    expect(failed.details.gateway).toBe("fake-capability");
    expect(failed.details.reason).toBe("kept");
    await runtime.dispose();
  });

  it("rejects when the candidate is not in the ledger", async () => {
    const { runtime, dispatcher } = await setup();

    await expect(dispatcher.dispatch("missing:candidate:0")).rejects.toThrow(
      "No prediction candidate missing:candidate:0 recorded in the ledger.",
    );
    await runtime.dispose();
  });
});
