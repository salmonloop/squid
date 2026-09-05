import { describe, expect, test } from "bun:test";
import {
  parseIdentityFrame,
  pollingScreenTextReaderFactory,
  type ScreenTextSampler,
  type SubprocessSample,
} from "../src/screen-text-reader-subprocess.js";
import type { ScreenTextFrame } from "../src/screen-text-source.js";

const SEPARATOR = "\u001F";

/** A deferred sampler: the loop's in-flight query resolves only when released. */
function deferredSampler(): {
  run: ScreenTextSampler;
  release: (sample: SubprocessSample) => void;
  calls: () => number;
  killed: () => boolean;
} {
  let pending: ((sample: SubprocessSample) => void) | null = null;
  let callCount = 0;
  let wasKilled = false;
  return {
    run: (onSpawned) => {
      callCount += 1;
      onSpawned({ kill: () => (wasKilled = true) });
      return new Promise<SubprocessSample>((resolve) => {
        pending = resolve;
      });
    },
    release: (sample) => pending?.(sample),
    calls: () => callCount,
    killed: () => wasKilled,
  };
}

function completedSampler(samples: SubprocessSample[]): ScreenTextSampler {
  let index = 0;
  return (onSpawned) => {
    onSpawned({ kill: () => {} });
    const sample =
      samples[index] ?? samples[samples.length - 1] ?? { stdout: "", stderr: "", exitCode: 0 };
    index += 1;
    return Promise.resolve(sample);
  };
}

function identitySample(stdout: string, exitCode = 0, stderr = ""): SubprocessSample {
  return { stdout, stderr, exitCode };
}

function collect(
  pollMs: number,
  run: ScreenTextSampler,
  timeoutMs?: number,
): { frames: ScreenTextFrame[]; errors: string[]; close: () => void } {
  const frames: ScreenTextFrame[] = [];
  const errors: string[] = [];
  const close = pollingScreenTextReaderFactory({
    program: "fake",
    pollMs,
    run,
    parse: parseIdentityFrame,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })({
    onFrame: (frame) => frames.push(frame),
    onError: (error) => errors.push(error.message),
  }).close;
  return { frames, errors, close };
}

describe("pollingScreenTextReaderFactory", () => {
  test("samples immediately and delivers the parsed frame", async () => {
    const { frames, close } = collect(50, completedSampler([
      identitySample(`123${SEPARATOR}Editor${SEPARATOR}draft.md\n`),
    ]));
    try {
      await Bun.sleep(10);
      expect(frames.map((f) => f.applicationId)).toEqual(["123"]);
      expect(frames[0]?.windowTitle).toBe("draft.md");
    } finally {
      close();
    }
  });

  test("a non-zero exit reports the program and stderr, only on transition", async () => {
    const failing = identitySample("", 1, "permission denied");
    const { frames, errors, close } = collect(5, completedSampler([failing]));
    try {
      // Several polls of the same failure collapse to one diagnostic.
      await Bun.sleep(30);
      expect(frames).toEqual([]);
      expect(errors).toEqual(["fake exited 1: permission denied"]);
    } finally {
      close();
    }
  });

  test("stdout describing no addressable process is quiet, not an error", async () => {
    const { frames, errors, close } = collect(5, completedSampler([identitySample("\n")]));
    try {
      await Bun.sleep(20);
      expect(frames).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      close();
    }
  });

  test("close kills the in-flight sample and drops its result", async () => {
    const deferred = deferredSampler();
    const { frames, errors, close } = collect(50, deferred.run);
    // The first sample is in flight; ticks during it must not queue more polls.
    await Bun.sleep(20);
    expect(deferred.calls()).toBe(1);
    close();
    expect(deferred.killed()).toBe(true);
    deferred.release(identitySample(`999${SEPARATOR}Ghost${SEPARATOR}late\n`));
    await Bun.sleep(10);
    expect(frames).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("abandons a query that never answers, and keeps sampling", async () => {
    // The failure this exists for: `sampling` prevents overlap, and a query that
    // never resolves leaves it set. Every later interval then returns at that
    // guard, so the reader stays alive and observes nothing, forever, without
    // saying why.
    const deferred = deferredSampler();
    const { errors, close } = collect(5, deferred.run, 15);
    try {
      await Bun.sleep(60);

      expect(deferred.killed()).toBe(true);
      // A fresh query after the deadline is the whole point: the slot came back.
      expect(deferred.calls()).toBeGreaterThan(1);
      expect(errors.some((message) => message.includes("did not answer within 15ms"))).toBe(true);
    } finally {
      close();
      deferred.release(identitySample("\n"));
    }
  });

  test("an abandoned query's late answer is dropped", async () => {
    // It describes a screen the loop already gave up on, and a newer query owns
    // the slot by now.
    const deferred = deferredSampler();
    const { frames, close } = collect(1_000, deferred.run, 10);
    try {
      await Bun.sleep(40);
      deferred.release(identitySample(`999${SEPARATOR}Ghost${SEPARATOR}late\n`));
      await Bun.sleep(10);

      expect(frames).toEqual([]);
    } finally {
      close();
    }
  });

  test("polls do not overlap while a sample is in flight", async () => {
    const deferred = deferredSampler();
    const { close } = collect(5, deferred.run);
    await Bun.sleep(30);
    try {
      expect(deferred.calls()).toBe(1);
    } finally {
      close();
      deferred.release(identitySample("\n"));
    }
  });
});

describe("parseIdentityFrame", () => {
  const at = "2026-08-29T10:00:00.000Z";

  test("parses pid, process name, and title into a neutral frame", () => {
    expect(parseIdentityFrame(`4242${SEPARATOR}code${SEPARATOR}agent-tools.ts - Code\n`, at)).toEqual({
      applicationId: "4242",
      occurredAt: at,
      applicationName: "code",
      windowTitle: "agent-tools.ts - Code",
    });
  });

  test("accepts CRLF line endings without leaking CR into a field", () => {
    const frame = parseIdentityFrame(`7${SEPARATOR}shell${SEPARATOR}Terminal\r\n`, at);
    expect(frame?.windowTitle).toBe("Terminal");
  });

  test("a missing pid is no addressable process, and the frame is null", () => {
    expect(parseIdentityFrame(`${SEPARATOR}shell${SEPARATOR}Terminal\n`, at)).toBeNull();
    expect(parseIdentityFrame("\n", at)).toBeNull();
    expect(parseIdentityFrame("", at)).toBeNull();
  });

  test("empty fields become absent frame fields, not empty strings", () => {
    expect(parseIdentityFrame(`9${SEPARATOR}${SEPARATOR}\n`, at)).toEqual({
      applicationId: "9",
      occurredAt: at,
    });
  });

  test("a separator inside the title stays in the title", () => {
    const frame = parseIdentityFrame(`1${SEPARATOR}app${SEPARATOR}a${SEPARATOR}b\n`, at);
    expect(frame?.windowTitle).toBe(`a${SEPARATOR}b`);
  });
});
