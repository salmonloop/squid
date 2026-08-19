import { describe, expect, it } from "bun:test";
import { InMemoryEventStore } from "../src/event-store.js";
import { FakePredictionProvider, candidate } from "../src/fake-prediction-provider.js";
import { PredictionCoordinator } from "../src/prediction-coordinator.js";
import { PredictionRuntime } from "../src/prediction-runtime.js";
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
});
