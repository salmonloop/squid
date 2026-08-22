import { describe, expect, it, mock } from "bun:test";
import { HeuristicPredictor } from "../src/baseline-predictor.js";
import { emptyWorldState } from "../src/protocol.js";
import { PredictionCoordinator } from "../src/prediction-coordinator.js";
import {
  FakePredictionProvider,
  PredictionCancelledError,
  candidate,
} from "../src/fake-prediction-provider.js";
import type { PredictionOutcome, PredictionProvider } from "../src/prediction-provider.js";
import { SyncPredictorProvider } from "../src/prediction-provider.js";

function makeState(episodeId?: string) {
  const state = emptyWorldState();
  if (episodeId) {
    state.episode = { id: episodeId, startedAt: "2026-08-18T10:00:00.000Z", eventCount: 1 };
    state.updatedAt = "2026-08-18T10:00:00.000Z";
  }
  return state;
}

function makeProvider(candidates: readonly ReturnType<typeof candidate>[]) {
  return new FakePredictionProvider({ candidates, delayMs: 10, name: "pi" });
}

const counter = () => {
  let n = 0;
  return () => `req-${++n}`;
};

describe("PredictionCoordinator", () => {
  it("returns provider candidates on success", async () => {
    const outcomes: PredictionOutcome[] = [];
    const provider = new FakePredictionProvider({
      candidates: [candidate("run_tests", 0.8)],
      delayMs: 0,
      name: "pi",
    });
    const coordinator = new PredictionCoordinator({
      provider,
      onOutcome: (o) => outcomes.push(o),
      random: counter(),
    });

    const outcome = await coordinator.request(makeState("ep-1"));
    expect(outcome.status).toBe("succeeded");
    expect(outcome.provider).toBe("pi");
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.candidates[0].kind).toBe("run_tests");
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe("succeeded");
  });

  it("clears the timeout after a provider succeeds", async () => {
    let aborted = false;
    const coordinator = new PredictionCoordinator({
      provider: {
        name: "fast",
        predict: async (_request, signal) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          }, { once: true });
          return [candidate("run_tests")];
        },
      },
      timeoutMs: 10,
      random: counter(),
    });

    const outcome = await coordinator.request(makeState("ep-1"));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(outcome.status).toBe("succeeded");
    expect(aborted).toBe(false);
    coordinator.dispose();
  });

  it("falls back to heuristic predictor when the provider fails", async () => {
    const state = makeState("ep-1");
    state.lastCommandOutcome = {
      commandClass: "npm",
      succeeded: false,
      exitCode: 1,
    };
    state.lastEventKind = "terminal_command_completed";

    const provider = new FakePredictionProvider({
      candidates: [],
      delayMs: 0,
      error: new Error("model unavailable"),
      name: "pi",
    });

    const coordinator = new PredictionCoordinator({
      provider,
      fallback: new HeuristicPredictor(),
      timeoutMs: 5_000,
      random: counter(),
    });

    const outcome = await coordinator.request(state);
    expect(outcome.status).toBe("failed");
    expect(outcome.provider).toBe("pi");
    expect(outcome.candidates.some((c) => c.kind === "inspect_error")).toBe(true);
    expect(outcome.fallbackReason).toBe("model unavailable");
  });

  it("falls back when the provider times out", async () => {
    const state = makeState("ep-1");
    state.lastCommandOutcome = {
      commandClass: "npm",
      succeeded: false,
      exitCode: 1,
    };
    state.lastEventKind = "terminal_command_completed";

    const provider = new FakePredictionProvider({
      candidates: [candidate("run_tests", 0.9)],
      delayMs: 200,
      name: "pi",
    });

    const coordinator = new PredictionCoordinator({
      provider,
      fallback: new HeuristicPredictor(),
      timeoutMs: 50,
      random: counter(),
    });

    const outcome = await coordinator.request(state);
    expect(["timeout", "failed", "cancelled"]).toContain(outcome.status);
    expect(outcome.candidates.some((c) => c.kind === "inspect_error")).toBe(true);
  });

  it("cancels the old request when a new one arrives", async () => {
    const outcomes: PredictionOutcome[] = [];
    const provider = new FakePredictionProvider({
      candidates: [candidate("run_tests")],
      delayMs: 100,
      name: "pi",
    });

    let requestCount = 0;
    const coordinator = new PredictionCoordinator({
      provider: {
        name: "pi",
        predict: async (request, signal) => {
          requestCount++;
          // Return different candidates depending on request id
          if (requestCount === 1) {
            // First request: slow, should be cancelled
            return new Promise((_, reject) => {
              signal.addEventListener("abort", () =>
                reject(new PredictionCancelledError(request.id)),
              );
            });
          }
          // Second request: fast
          return [candidate("draft_completion", 0.7)];
        },
      },
      onOutcome: (o) => outcomes.push(o),
      random: counter(),
    });

    const state = makeState("ep-1");

    // Fire first request, don't await
    const first = coordinator.request(state);

    // Fire second request immediately — should cancel the first
    const second = await coordinator.request(state);

    expect(second.status).toBe("succeeded");
    expect(second.candidates[0].kind).toBe("draft_completion");

    // First request should resolve as stale (superseded by the second)
    const firstOutcome = await first;
    expect(firstOutcome.status === "stale").toBe(true);

    // Outcomes should contain a stale (superseded) and a succeeded
    expect(outcomes.some((o) => o.status === "stale")).toBe(true);
    expect(outcomes.some((o) => o.status === "succeeded")).toBe(true);
  });

  it("discards results from a stale episode", async () => {
    const outcomes: PredictionOutcome[] = [];

    let episodeIdForRequest: string | null = null;

    const coordinator = new PredictionCoordinator({
      provider: {
        name: "pi",
        predict: async (_request, _signal) => {
          // Simulate slow provider that will finish after episode changes
          await new Promise((resolve) => setTimeout(resolve, 50));
          return [candidate("run_tests", 0.8)];
        },
      },
      onOutcome: (o) => outcomes.push(o),
      random: counter(),
    });

    // Start a request in ep-1
    const firstRequest = coordinator.request(makeState("ep-1"));

    // Immediately start a new request in ep-2 (simulates episode boundary)
    await new Promise((resolve) => setTimeout(resolve, 5)); // ensure first is in flight
    const secondOutcome = await coordinator.request(makeState("ep-2"));

    expect(secondOutcome.status).toBe("succeeded");

    // Check the first outcome
    const firstOutcome = await firstRequest;
    expect(firstOutcome.status === "stale" || firstOutcome.status === "cancelled").toBe(true);
    expect(firstOutcome.candidates).toHaveLength(0);
  });

  it("cancelActive cancels an in-flight request", async () => {
    const outcomes: PredictionOutcome[] = [];
    const provider = new FakePredictionProvider({
      candidates: [candidate("run_tests")],
      delayMs: 100,
      name: "pi",
    });

    const coordinator = new PredictionCoordinator({
      provider,
      onOutcome: (o) => outcomes.push(o),
      random: counter(),
    });

    const state = makeState("ep-1");
    const pending = coordinator.request(state);

    coordinator.cancelActive("user-cancelled");

    const outcome = await pending;
    // cancelActive marks the request as explicitly cancelled, so the catch
    // block classifies it as "cancelled" (not "stale" or "failed").
    expect(outcome.status).toBe("cancelled");
    expect(outcome.fallbackReason).toBe("user-cancelled");

    // The explicitly cancelled outcome should also be recorded by onOutcome
    expect(outcomes.some((o) => o.status === "cancelled")).toBe(true);
  });

  it("dispose cancels active requests", async () => {
    const provider = new FakePredictionProvider({
      candidates: [candidate("run_tests")],
      delayMs: 200,
      name: "pi",
    });

    const coordinator = new PredictionCoordinator({
      provider,
      random: counter(),
    });

    const state = makeState("ep-1");
    const pending = coordinator.request(state);
    coordinator.dispose();

    const outcome = await pending;
    expect(["cancelled", "stale", "failed", "timeout"]).toContain(outcome.status);
  });

  it("is idempotent when there is no active request", () => {
    const provider = makeProvider([candidate("run_tests")]);
    const coordinator = new PredictionCoordinator({
      provider,
      random: counter(),
    });
    // Should not throw
    coordinator.cancelActive("nothing");
    coordinator.dispose();
  });

  it("does not publish success when an explicitly cancelled provider ignores abort", async () => {
    let resolveProvider: ((candidates: readonly ReturnType<typeof candidate>[]) => void) | undefined;
    const coordinator = new PredictionCoordinator({
      provider: {
        name: "ignores-abort",
        predict: async () => new Promise((resolve) => {
          resolveProvider = resolve;
        }),
      },
      random: counter(),
    });

    const pending = coordinator.request(makeState("ep-1"));
    coordinator.cancelActive("user-cancelled");
    resolveProvider!([candidate("run_tests")]);

    const outcome = await pending;
    expect(outcome.status).toBe("cancelled");
  });

  it("settles cancellation when a provider ignores abort and never resolves", async () => {
    const coordinator = new PredictionCoordinator({
      provider: {
        name: "hung",
        predict: async () => new Promise(() => undefined),
      },
      random: counter(),
    });

    const pending = coordinator.request(makeState("ep-1"));
    coordinator.cancelActive("shutdown");

    const outcome = await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cancel did not settle")), 100)),
    ]);
    expect(outcome.status).toBe("cancelled");
    expect(outcome.fallbackReason).toBe("shutdown");
  });

  it("skips fallback work for a request already superseded", async () => {
    const diagnostics: string[] = [];
    let call = 0;
    const coordinator = new PredictionCoordinator({
      provider: {
        name: "supersede",
        predict: async (request, signal) => {
          call += 1;
          if (call === 1) {
            return new Promise<readonly ReturnType<typeof candidate>[]>((_, reject) => {
              signal.addEventListener("abort", () => reject(new Error(`aborted ${request.id}`)), { once: true });
            });
          }
          return [candidate("run_tests")];
        },
      },
      fallback: {
        predict: () => {
          throw new Error("fallback should not run for stale work");
        },
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.kind),
      random: counter(),
    });

    const first = coordinator.request(makeState("ep-1"));
    const second = coordinator.request(makeState("ep-2"));

    expect((await second).status).toBe("succeeded");
    expect((await first).status).toBe("stale");
    expect(diagnostics).toEqual([]);
  });

  it("contains fallback and observer errors without rejecting", async () => {
    const diagnostics: string[] = [];
    const coordinator = new PredictionCoordinator({
      provider: {
        name: "failing",
        predict: async () => {
          throw new Error("provider failed");
        },
      },
      fallback: {
        predict: () => {
          throw new Error("fallback failed");
        },
      },
      onOutcome: () => {
        throw new Error("observer failed");
      },
      onDiagnostic: (diagnostic) => diagnostics.push(`${diagnostic.kind}:${diagnostic.message}`),
      random: counter(),
    });

    const outcome = await coordinator.request(makeState("ep-1"));

    expect(outcome.status).toBe("failed");
    expect(outcome.candidates).toEqual([]);
    expect(outcome.fallbackReason).toContain("fallback failed");
    expect(diagnostics).toEqual([
      "fallback_failed:fallback failed",
      "outcome_observer_failed:observer failed",
    ]);
  });
});

describe("SyncPredictorProvider", () => {
  it("wraps a sync predictor and ignores the signal", async () => {
    const heuristic = new HeuristicPredictor();
    const provider = new SyncPredictorProvider(heuristic, "baseline");

    const state = makeState("ep-1");
    state.lastCommandOutcome = {
      commandClass: "npm",
      succeeded: false,
      exitCode: 1,
    };
    state.lastEventKind = "terminal_command_completed";

    const controller = new AbortController();
    controller.abort();

    const request: PredictionRequest = {
      id: "test-1",
      worldState: state,
      episodeId: "ep-1",
      triggeredAt: "2026-08-18T10:00:00.000Z",
    };

    const candidates = await provider.predict(request, controller.signal);
    expect(candidates.some((c) => c.kind === "inspect_error")).toBe(true);
    expect(provider.name).toBe("baseline");
  });
});
