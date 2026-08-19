import { describe, expect, it } from "bun:test";
import { PredictionLog, toPredictionRecord } from "../src/prediction-log.js";
import { FakePredictionProvider, candidate } from "../src/fake-prediction-provider.js";
import { PredictionCoordinator } from "../src/prediction-coordinator.js";
import { emptyWorldState } from "../src/protocol.js";
import type { PredictionOutcome } from "../src/prediction-provider.js";

function makeState() {
  const state = emptyWorldState();
  state.episode = { id: "ep-1", startedAt: "2026-08-18T10:00:00.000Z", eventCount: 1 };
  state.updatedAt = "2026-08-18T10:00:00.000Z";
  return state;
}

describe("PredictionLog", () => {
  it("records outcomes as structured records", async () => {
    const log = new PredictionLog();
    const provider = new FakePredictionProvider({
      candidates: [candidate("run_tests", 0.9)],
      delayMs: 0,
      name: "pi",
    });
    const coordinator = new PredictionCoordinator({
      provider,
      onOutcome: (o) => log.record(o),
      random: () => "test-1",
    });

    await coordinator.request(makeState());
    expect(log.count).toBe(1);
    const record = log.all[0];
    expect(record.requestId).toBe("test-1");
    expect(record.provider).toBe("pi");
    expect(record.status).toBe("succeeded");
    expect(record.candidateKinds).toEqual(["run_tests"]);
    expect(record.timestamp).toBeTruthy();
  });

  it("records cancellations with fallback reason", async () => {
    const log = new PredictionLog();
    const provider = new FakePredictionProvider({
      candidates: [candidate("run_tests")],
      delayMs: 100,
      name: "pi",
    });
    const coordinator = new PredictionCoordinator({
      provider,
      onOutcome: (o) => log.record(o),
      random: () => "test-cancel",
    });

    const state = makeState();
    const pending = coordinator.request(state);
    coordinator.cancelActive("user-dismissed");
    await pending;

    // Should have both the cancelled outcome and the in-flight attempt outcome
    expect(log.count).toBeGreaterThanOrEqual(1);
    const cancelledRecords = log.filter((r) => r.status === "cancelled");
    expect(cancelledRecords.length).toBeGreaterThanOrEqual(1);
    expect(cancelledRecords[0].fallbackReason).toBeTruthy();
  });

  it("clear removes all records", () => {
    const log = new PredictionLog();
    const outcome: PredictionOutcome = {
      requestId: "x",
      provider: "test",
      status: "succeeded",
      candidates: [candidate("run_tests")],
      latencyMs: 5,
    };
    log.record(outcome);
    expect(log.count).toBe(1);
    log.clear();
    expect(log.count).toBe(0);
  });

  it("toPredictionRecord maps all fields", () => {
    const outcome: PredictionOutcome = {
      requestId: "req-42",
      provider: "pi",
      status: "failed",
      candidates: [candidate("inspect_error"), candidate("run_tests")],
      latencyMs: 1500,
      fallbackReason: "model unavailable",
    };
    const record = toPredictionRecord(outcome);
    expect(record.requestId).toBe("req-42");
    expect(record.provider).toBe("pi");
    expect(record.status).toBe("failed");
    expect(record.candidateKinds).toEqual(["inspect_error", "run_tests"]);
    expect(record.latencyMs).toBe(1500);
    expect(record.fallbackReason).toBe("model unavailable");
  });
});
