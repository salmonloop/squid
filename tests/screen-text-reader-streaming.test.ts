import { describe, expect, it } from "bun:test";
import { streamingScreenTextReaderFactory, type StreamingChild } from "../src/screen-text-reader-subprocess.js";
import type { ScreenTextFrame } from "../src/screen-text-source.js";

/**
 * The streaming loop, driven by a fake child.
 *
 * Same posture as the polling loop's tests: the loop is the thing under test, and
 * a real interpreter would only be testing the host. What matters here is what the
 * loop does with a byte stream that does not respect record boundaries, and what
 * it does with a child that leaves.
 */

interface FakeChild extends StreamingChild {
  /** Writes a chunk as if the child had. */
  emit(chunk: string): void;
  emitStderr(chunk: string): void;
  /** Ends the child with this exit code. */
  finish(code: number): void;
  readonly killed: () => boolean;
}

function fakeChild(): FakeChild {
  let stdout: ((chunk: string) => void) | undefined;
  let stderr: ((chunk: string) => void) | undefined;
  let settle: ((code: number) => void) | undefined;
  let wasKilled = false;
  const exited = new Promise<number>((resolve) => {
    settle = resolve;
  });
  return {
    kill: () => {
      wasKilled = true;
      settle?.(0);
    },
    exited,
    onStdout: (handler) => {
      stdout = handler;
    },
    onStderr: (handler) => {
      stderr = handler;
    },
    emit: (chunk) => stdout?.(chunk),
    emitStderr: (chunk) => stderr?.(chunk),
    finish: (code) => settle?.(code),
    killed: () => wasKilled,
  };
}

/** Every record is one field, so these tests are about framing, not parsing. */
const parseLine = (line: string, occurredAt: string): ScreenTextFrame | null =>
  line === "quiet" ? null : { applicationId: line, occurredAt };

function harness(restartMs = 5, stallMs?: number) {
  const children: FakeChild[] = [];
  const frames: ScreenTextFrame[] = [];
  const errors: string[] = [];
  const factory = streamingScreenTextReaderFactory({
    program: "fake",
    restartMs,
    ...(stallMs === undefined ? {} : { stallMs }),
    parse: parseLine,
    spawn: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  const reader = factory({
    onFrame: (frame) => frames.push(frame),
    onError: (error) => errors.push(error.message),
  });
  return { children, frames, errors, reader };
}

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 30));

/**
 * Polls until `probe` holds, or gives up.
 *
 * Polling rather than one `settle` for anything that waits on a chain of timers:
 * the platform's `setTimeout` granularity is coarser than its nominal argument —
 * around fifteen milliseconds on Windows — so a stall deadline plus a restart
 * deadline can land anywhere in a wide band, and a fixed sleep is a race with the
 * clock rather than a test of the loop.
 */
async function waitFor(probe: () => boolean, timeoutMs = 2_000): Promise<void> {
  for (let waited = 0; waited < timeoutMs && !probe(); waited += 5) {
    await new Promise((done) => setTimeout(done, 5));
  }
}

describe("streamingScreenTextReaderFactory", () => {
  it("spawns one child and turns each line into a frame", () => {
    const { children, frames, reader } = harness();
    expect(children.length).toBe(1);

    children[0]?.emit("first\nsecond\n");
    expect(frames.map((frame) => frame.applicationId)).toEqual(["first", "second"]);
    reader.close();
  });

  it("holds a record split across chunks until it is whole", () => {
    const { children, frames, reader } = harness();

    children[0]?.emit("half");
    expect(frames.length).toBe(0);
    children[0]?.emit("-and-half\n");
    expect(frames.map((frame) => frame.applicationId)).toEqual(["half-and-half"]);
    reader.close();
  });

  it("strips the carriage return PowerShell writes", () => {
    const { children, frames, reader } = harness();

    children[0]?.emit("windows\r\n");
    expect(frames[0]?.applicationId).toBe("windows");
    reader.close();
  });

  it("passes a quiet observation through without a frame or an error", () => {
    const { children, frames, errors, reader } = harness();

    children[0]?.emit("quiet\n");
    expect(frames.length).toBe(0);
    expect(errors).toEqual([]);
    reader.close();
  });

  it("reports stderr as a diagnostic rather than parsing it", () => {
    const { children, frames, errors, reader } = harness();

    children[0]?.emitStderr("automation client refused\n");
    expect(frames.length).toBe(0);
    expect(errors).toEqual(["fake: automation client refused"]);
    reader.close();
  });

  it("collapses a repeated diagnostic to one report", () => {
    const { children, errors, reader } = harness();

    children[0]?.emitStderr("same problem");
    children[0]?.emitStderr("same problem");
    expect(errors.length).toBe(1);
    reader.close();
  });

  it("restarts a child that exits on its own, and says why", async () => {
    const { children, frames, errors, reader } = harness();

    children[0]?.finish(1);
    await settle();

    expect(errors[0]).toContain("fake exited 1");
    expect(children.length).toBe(2);
    children[1]?.emit("after-restart\n");
    expect(frames.map((frame) => frame.applicationId)).toEqual(["after-restart"]);
    reader.close();
  });

  it("starts a restarted child on an empty buffer", async () => {
    const { children, frames, reader } = harness();

    // A child killed mid-record leaves a fragment. Carrying it into the next
    // child's first chunk would splice two samples into one record that describes
    // neither.
    children[0]?.emit("frag");
    children[0]?.finish(1);
    await settle();
    children[1]?.emit("ment\n");

    expect(frames.map((frame) => frame.applicationId)).toEqual(["ment"]);
    reader.close();
  });

  it("neither restarts nor reports a child that exited because it was closed", async () => {
    const { children, errors, reader } = harness();

    reader.close();
    await settle();

    expect(children[0]?.killed()).toBe(true);
    expect(children.length).toBe(1);
    expect(errors).toEqual([]);
  });

  it("ignores a closed reader's late output", () => {
    const { children, frames, reader } = harness();

    reader.close();
    children[0]?.emit("too-late\n");
    expect(frames.length).toBe(0);
  });

  it("restarts a living child that stopped writing records", async () => {
    // The gap the exit handler cannot see: the child prints one record per
    // interval whether or not anything changed, so silence is a sampler that
    // stopped sampling rather than a quiet desktop. Nothing restarts it, because
    // the process is still there.
    //
    // The child's stall deadline is 20ms and the restart deadline 5ms, so a fixed
    // sleep cannot be used to assert an exact total. It could not before either:
    // this asserted `children.length === 2` after 30ms, which held only when the
    // two platform timers happened to fire inside that window. On a host whose
    // timers round up to the system tick the kill lands at ~30ms and the spawn at
    // ~45ms, so the old assertion read 1 — and given a longer window it reads 7,
    // because this loop correctly restarts a child that stalls *again*. Neither
    // number is a property of the loop; "killed, said so, replaced" is.
    const { children, frames, errors, reader } = harness(5, 20);
    children[0]?.emit("before\n");

    await waitFor(() => children.length >= 2);

    expect(children[0]?.killed()).toBe(true);
    expect(errors.some((message) => message.includes("wrote no record for 20ms"))).toBe(true);
    expect(children.length).toBeGreaterThanOrEqual(2);

    // The newest child, whichever the loop is on: a child that stalls again is
    // restarted again, so "the second one" is not a stable thing to address.
    // Emitting is synchronous, so the frame is captured whichever child this is.
    const current = children[children.length - 1];
    current?.emit("after\n");
    expect(frames.map((frame) => frame.applicationId)).toEqual(["before", "after"]);
    reader.close();
  });

  it("does not restart a child that keeps writing", async () => {
    const { children, reader } = harness(5, 60);
    for (let tick = 0; tick < 4; tick += 1) {
      children[0]?.emit(`tick-${tick}\n`);
      await new Promise((done) => setTimeout(done, 20));
    }

    expect(children[0]?.killed()).toBe(false);
    expect(children.length).toBe(1);
    reader.close();
  });
});
