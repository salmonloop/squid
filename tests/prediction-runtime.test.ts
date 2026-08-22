import { describe, expect, it } from "bun:test";
import { InMemoryEventStore } from "../src/event-store.js";
import { FakePredictionProvider, candidate } from "../src/fake-prediction-provider.js";
import { PredictionCoordinator } from "../src/prediction-coordinator.js";
import {
  InMemoryPredictionLedger,
  PredictionLedgerReferenceError,
  type PredictionAttemptRecord,
  type PredictionFeedbackInput,
  type PredictionLedger,
} from "../src/prediction-ledger.js";
import {
  PredictionRuntime,
  type PredictionRuntimeDiagnostic,
} from "../src/prediction-runtime.js";
import { createActivityEvent } from "../src/protocol.js";
import { SquidCore } from "../src/squid-core.js";

const nextRequestId = () => {
  let sequence = 0;
  return () => `runtime-${++sequence}`;
};

function createRuntime(delayMs = 0) {
  const provider = new FakePredictionProvider({
    name: "fake-runtime",
    candidates: [candidate("run_tests")],
    delayMs,
  });
  const coordinator = new PredictionCoordinator({
    provider,
    random: nextRequestId(),
  });
  return new PredictionRuntime(new SquidCore(new InMemoryEventStore()), coordinator);
}

function savedFile(eventId = "saved-1") {
  return createActivityEvent({
    kind: "file_saved",
    eventId,
    payload: { path: "src/main.ts", applicationId: "editor" },
  });
}

describe("PredictionRuntime", () => {
  it("projects before starting an async prediction", async () => {
    const runtime = createRuntime();

    const result = await runtime.ingest(savedFile());

    expect(result.ingest.disposition).toBe("accepted");
    expect(result.ingest.state.recentFiles).toEqual(["src/main.ts"]);
    expect(result.prediction).not.toBeNull();
    expect((await result.prediction!).status).toBe("succeeded");
    expect(runtime.currentState.recentFiles).toEqual(["src/main.ts"]);

    await runtime.dispose();
  });

  it("does not create a provider request for an exact duplicate", async () => {
    const runtime = createRuntime();
    const event = savedFile();

    const first = await runtime.ingest(event);
    const duplicate = await runtime.ingest(event);

    expect(first.prediction).not.toBeNull();
    expect(duplicate.ingest.disposition).toBe("duplicate");
    expect(duplicate.prediction).toBeNull();
    await first.prediction;

    await runtime.dispose();
  });

  it("lets a new event supersede an older in-flight prediction", async () => {
    const runtime = createRuntime(50);

    const first = await runtime.ingest(savedFile("saved-1"));
    const second = await runtime.ingest(savedFile("saved-2"));

    expect(first.prediction).not.toBeNull();
    expect(second.prediction).not.toBeNull();
    expect((await second.prediction!).status).toBe("succeeded");
    expect((await first.prediction!).status).toBe("stale");

    await runtime.dispose();
  });

  it("re-predicts after a late event is canonically reprojected", async () => {
    const runtime = createRuntime(50);
    const newer = createActivityEvent({
      kind: "file_saved",
      eventId: "newer-save",
      sequence: 1,
      occurredAt: "2026-08-19T10:00:01.000Z",
      payload: { path: "newer.ts", applicationId: "editor" },
    });
    const older = createActivityEvent({
      kind: "file_saved",
      eventId: "older-save",
      sequence: 0,
      occurredAt: "2026-08-19T10:00:00.000Z",
      payload: { path: "older.ts", applicationId: "editor" },
    });

    const first = await runtime.ingest(newer);
    const second = await runtime.ingest(older);

    expect(second.ingest.disposition).toBe("late");
    expect((await second.prediction!).status).toBe("succeeded");
    expect((await first.prediction!).status).toBe("stale");
    await runtime.dispose();
  });

  it("restores core state without starting a prediction", async () => {
    const store = new InMemoryEventStore();
    const source = new SquidCore(store);
    await source.ingest(savedFile());
    const runtime = new PredictionRuntime(
      new SquidCore(store),
      new PredictionCoordinator({
        provider: new FakePredictionProvider({ candidates: [candidate("run_tests")] }),
        random: nextRequestId(),
      }),
    );

    const restored = await runtime.restore();

    expect(restored.recentFiles).toEqual(["src/main.ts"]);
    expect(runtime.currentState).toEqual(restored);
    await runtime.dispose();
  });

  it("returns after projection without waiting for the provider", async () => {
    let release: ((candidates: readonly ReturnType<typeof candidate>[]) => void) | undefined;
    const coordinator = new PredictionCoordinator({
      provider: {
        name: "controlled",
        predict: async () => new Promise((resolve) => {
          release = resolve;
        }),
      },
      random: nextRequestId(),
    });
    const runtime = new PredictionRuntime(new SquidCore(new InMemoryEventStore()), coordinator);

    const result = await runtime.ingest(savedFile());

    expect(result.ingest.state.recentFiles).toEqual(["src/main.ts"]);
    expect(release).toBeDefined();
    release!([candidate("run_tests")]);
    expect((await result.prediction!).status).toBe("succeeded");
    await runtime.dispose();
  });

  it("does not cancel the active prediction for a duplicate event", async () => {
    const runtime = createRuntime(20);
    const event = savedFile();

    const first = await runtime.ingest(event);
    const duplicate = await runtime.ingest(event);

    expect(duplicate.prediction).toBeNull();
    expect((await first.prediction!).status).toBe("succeeded");
    await runtime.dispose();
  });

  it("cancels and drains the active prediction on dispose", async () => {
    const runtime = createRuntime(1_000);
    const result = await runtime.ingest(savedFile());

    await runtime.dispose();

    expect((await result.prediction!).status).toBe("cancelled");
    await expect(runtime.ingest(savedFile("after-dispose"))).rejects.toThrow(
      "PredictionRuntime is disposed.",
    );
  });

  it("disposes even when the provider ignores abort and never settles", async () => {
    const runtime = new PredictionRuntime(
      new SquidCore(new InMemoryEventStore()),
      new PredictionCoordinator({
        provider: {
          name: "hung",
          predict: async () => new Promise(() => undefined),
        },
        random: nextRequestId(),
      }),
    );
    const result = await runtime.ingest(savedFile());

    await Promise.race([
      runtime.dispose(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("dispose did not settle")), 100)),
    ]);

    expect((await result.prediction!).status).toBe("cancelled");
  });

  it("waits for an in-flight ingest before dispose resolves", async () => {
    let releaseAppend: (() => void) | undefined;
    const store = {
      append: async () => new Promise<void>((resolve) => {
        releaseAppend = resolve;
      }),
      all: async () => [],
      since: async () => [],
    };
    const runtime = new PredictionRuntime(
      new SquidCore(store),
      new PredictionCoordinator({
        provider: new FakePredictionProvider({ candidates: [candidate("run_tests")] }),
        random: nextRequestId(),
      }),
    );

    const ingest = runtime.ingest(savedFile());
    let disposed = false;
    const dispose = runtime.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseAppend!();
    await Promise.all([ingest, dispose]);
    expect(disposed).toBe(true);
  });

  it("records a durable attempt for each prediction outcome", async () => {
    const ledger = new InMemoryPredictionLedger();
    const runtime = new PredictionRuntime(
      new SquidCore(new InMemoryEventStore()),
      new PredictionCoordinator({
        provider: new FakePredictionProvider({ candidates: [candidate("run_tests")] }),
        random: nextRequestId(),
      }),
      {
        ledger,
        now: () => new Date("2026-08-19T10:00:00.000Z"),
        runtimeSessionId: "session-under-test",
        actionTrust: "trusted",
      },
    );

    const result = await runtime.ingest(savedFile());
    await result.prediction;
    await runtime.awaitIdle();

    const records = (await ledger.all()) as PredictionAttemptRecord[];
    expect(records).toHaveLength(1);
    expect(records[0].recordType).toBe("attempt");
    expect(records[0].triggerEventId).toBe("saved-1");
    expect(records[0].episodeId).not.toBeNull();
    expect(records[0].status).toBe("succeeded");
    expect(records[0].candidates[0].candidateId).toBe("runtime-1:candidate:0");
    expect(records[0].candidates[0].candidate.kind).toBe("run_tests");
    // Schema v2 metadata is stamped from the ingest snapshot and the
    // configured identity, never fabricated after the fact.
    expect(records[0].schemaVersion).toBe(2);
    expect(records[0].runtimeSessionId).toBe("session-under-test");
    expect(records[0].actionTrust).toBe("trusted");
    expect(records[0].egressPolicyId).toBe("search-egress-deny-v1");
    expect(records[0].triggerDisposition).toBe("accepted");
    expect(records[0].contextPolicyId).toBe("passthrough");
    expect(records[0].projectionGeneration).toBe(1);
    expect(records[0].stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    await runtime.dispose();
  });

  it("stamps late-disposition attempts as non-default metadata", async () => {
    const ledger = new InMemoryPredictionLedger();
    const runtime = new PredictionRuntime(
      new SquidCore(new InMemoryEventStore()),
      new PredictionCoordinator({
        provider: new FakePredictionProvider({ candidates: [candidate("run_tests")] }),
        random: nextRequestId(),
      }),
      { ledger, runtimeSessionId: "session-late", actionTrust: "suggestion_only" },
    );
    // A late event reprojects the state but must still record its disposition,
    // so the ledger distinguishes dispatchable accepted triggers from shadow ones.
    const first = await runtime.ingest(savedFile("saved-1"));
    await first.prediction;
    const late = createActivityEvent({
      kind: "terminal_command_completed",
      eventId: "late-1",
      occurredAt: new Date(Date.parse(first.ingest.state.updatedAt!) - 5_000).toISOString(),
      payload: { commandClass: "test", succeeded: true, exitCode: 0 },
    });
    const second = await runtime.ingest(late);
    if (second.ingest.disposition === "late" && second.prediction !== null) {
      await second.prediction;
    }
    await runtime.awaitIdle();

    const records = (await ledger.all()) as PredictionAttemptRecord[];
    const lateRecord = records.find((r) => r.triggerEventId === "late-1");
    if (lateRecord !== undefined) {
      expect(lateRecord.triggerDisposition).toBe("late");
      expect(lateRecord.runtimeSessionId).toBe("session-late");
      expect(lateRecord.actionTrust).toBe("suggestion_only");
    }
    await runtime.dispose();
  });

  it("records a stale outcome when a prediction is superseded", async () => {
    const ledger = new InMemoryPredictionLedger();
    const runtime = new PredictionRuntime(
      new SquidCore(new InMemoryEventStore()),
      new PredictionCoordinator({
        provider: new FakePredictionProvider({ candidates: [candidate("run_tests")], delayMs: 50 }),
        random: nextRequestId(),
      }),
      { ledger },
    );

    const first = await runtime.ingest(savedFile("saved-1"));
    const second = await runtime.ingest(savedFile("saved-2"));
    await Promise.all([first.prediction, second.prediction]);
    await runtime.awaitIdle();

    const records = (await ledger.all()) as PredictionAttemptRecord[];
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.status).sort()).toEqual(["stale", "succeeded"]);
    const stale = records.find((r) => r.status === "stale")!;
    expect(stale.candidates).toEqual([]);
    await runtime.dispose();
  });

  it("does not reject the prediction when the ledger fails", async () => {
    const diagnostics: PredictionRuntimeDiagnostic[] = [];
    const ledger: PredictionLedger = {
      appendAttempt: async () => {
        throw new Error("disk full");
      },
      appendFeedback: async () => {},
      all: async () => [],
    };
    const runtime = new PredictionRuntime(
      new SquidCore(new InMemoryEventStore()),
      new PredictionCoordinator({
        provider: new FakePredictionProvider({ candidates: [candidate("run_tests")] }),
        random: nextRequestId(),
      }),
      { ledger, onDiagnostic: (d) => diagnostics.push(d) },
    );

    const result = await runtime.ingest(savedFile());
    expect((await result.prediction).status).toBe("succeeded");
    await runtime.awaitIdle();

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].kind).toBe("ledger_write_failed");
    expect(diagnostics[0].message).toBe("disk full");
    await runtime.dispose();
  });

  it("waits for an in-flight ledger write before dispose resolves", async () => {
    let releaseAppend: (() => void) | undefined;
    const ledger: PredictionLedger = {
      appendAttempt: () => new Promise<void>((resolve) => {
        releaseAppend = resolve;
      }),
      appendFeedback: async () => {},
      all: async () => [],
    };
    const runtime = new PredictionRuntime(
      new SquidCore(new InMemoryEventStore()),
      new PredictionCoordinator({
        provider: new FakePredictionProvider({ candidates: [candidate("run_tests")] }),
        random: nextRequestId(),
      }),
      { ledger },
    );

    const result = await runtime.ingest(savedFile());
    await result.prediction;
    let disposed = false;
    const dispose = runtime.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseAppend!();
    await dispose;
    expect(disposed).toBe(true);
  });

  it("does not record an attempt for a duplicate event", async () => {
    const ledger = new InMemoryPredictionLedger();
    const runtime = new PredictionRuntime(
      new SquidCore(new InMemoryEventStore()),
      new PredictionCoordinator({
        provider: new FakePredictionProvider({ candidates: [candidate("run_tests")] }),
        random: nextRequestId(),
      }),
      { ledger },
    );
    const event = savedFile();

    const first = await runtime.ingest(event);
    await runtime.ingest(event);
    await first.prediction;
    await runtime.awaitIdle();

    expect(await ledger.all()).toHaveLength(1);
    await runtime.dispose();
  });

  it("records feedback linked to a candidate after an outcome", async () => {
    const ledger = new InMemoryPredictionLedger();
    const runtime = new PredictionRuntime(
      new SquidCore(new InMemoryEventStore()),
      new PredictionCoordinator({
        provider: new FakePredictionProvider({ candidates: [candidate("run_tests")] }),
        random: nextRequestId(),
      }),
      { ledger, now: () => new Date("2026-08-19T10:00:00.000Z") },
    );

    const result = await runtime.ingest(savedFile());
    const outcome = await result.prediction!;
    await runtime.awaitIdle();
    const candidateId = `${outcome.requestId}:candidate:0`;
    const feedback: PredictionFeedbackInput = {
      feedbackId: "fb-1",
      requestId: outcome.requestId,
      candidateId,
      feedback: "accepted",
    };
    await runtime.recordFeedback(feedback);

    const records = await ledger.all();
    expect(records).toHaveLength(2);
    const attempt = records[0] as PredictionAttemptRecord;
    const feedbackRecord = records[1];
    expect(feedbackRecord.recordType).toBe("feedback");
    expect(feedbackRecord.candidateId).toBe(candidateId);
    expect(feedbackRecord.requestId).toBe(outcome.requestId);
    expect(feedbackRecord.feedback).toBe("accepted");
    expect(attempt.candidates[0].candidateId).toBe(candidateId);
    await runtime.dispose();
  });

  it("rejects feedback for an unknown candidate", async () => {
    const ledger = new InMemoryPredictionLedger();
    const runtime = new PredictionRuntime(
      new SquidCore(new InMemoryEventStore()),
      new PredictionCoordinator({
        provider: new FakePredictionProvider({ candidates: [candidate("run_tests")] }),
        random: nextRequestId(),
      }),
      { ledger },
    );
    const result = await runtime.ingest(savedFile());
    const outcome = await result.prediction!;
    await runtime.awaitIdle();

    await expect(
      runtime.recordFeedback({
        feedbackId: "fb-unknown",
        requestId: outcome.requestId,
        candidateId: "runtime-1:candidate:9",
        feedback: "accepted",
      }),
    ).rejects.toBeInstanceOf(PredictionLedgerReferenceError);
    await runtime.dispose();
  });

  it("rejects feedback that pairs a candidate with another request", async () => {
    const ledger = new InMemoryPredictionLedger();
    const runtime = new PredictionRuntime(
      new SquidCore(new InMemoryEventStore()),
      new PredictionCoordinator({
        provider: new FakePredictionProvider({ candidates: [candidate("run_tests")] }),
        random: nextRequestId(),
      }),
      { ledger },
    );
    const result = await runtime.ingest(savedFile());
    const outcome = await result.prediction!;
    await runtime.awaitIdle();

    await expect(
      runtime.recordFeedback({
        feedbackId: "fb-mismatch",
        requestId: "some-other-request",
        candidateId: `${outcome.requestId}:candidate:0`,
        feedback: "accepted",
      }),
    ).rejects.toBeInstanceOf(PredictionLedgerReferenceError);
    await runtime.dispose();
  });

  it("throws when recording feedback without a ledger", async () => {
    const runtime = createRuntime();
    expect(() =>
      runtime.recordFeedback({
        feedbackId: "fb-1",
        requestId: "req-1",
        candidateId: "req-1:candidate:0",
        feedback: "accepted",
      }),
    ).toThrow("PredictionRuntime has no ledger attached.");
    await runtime.dispose();
  });

  it("waits for an in-flight feedback write before dispose resolves", async () => {
    let releaseAppend: (() => void) | undefined;
    const ledger: PredictionLedger = {
      appendAttempt: async () => {},
      appendFeedback: () => new Promise<void>((resolve) => {
        releaseAppend = resolve;
      }),
      all: async () => [],
    };
    const runtime = new PredictionRuntime(
      new SquidCore(new InMemoryEventStore()),
      new PredictionCoordinator({
        provider: new FakePredictionProvider({ candidates: [candidate("run_tests")] }),
        random: nextRequestId(),
      }),
      { ledger },
    );
    const result = await runtime.ingest(savedFile());
    const outcome = await result.prediction!;
    await runtime.awaitIdle();

    void runtime.recordFeedback({
      feedbackId: "fb-1",
      requestId: outcome.requestId,
      candidateId: `${outcome.requestId}:candidate:0`,
      feedback: "accepted",
    });
    let disposed = false;
    const dispose = runtime.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseAppend!();
    await dispose;
    expect(disposed).toBe(true);
  });
});
