import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createFifoCaptureGateReader } from "../src/capture-gate-reader-fifo.js";
import type { CaptureGateFrame } from "../src/capture-gate-source.js";

/**
 * The reader polls on a timer, so every test writes the file first and waits
 * for frames to arrive — never for a wall-clock guess.
 */
async function withReader(
  lines: readonly string[],
  assertFrames: (frames: CaptureGateFrame[], errors: Error[]) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "capture-gate-"));
  const path = join(directory, "control.fifo");
  try {
    for (const line of lines) {
      await appendFile(path, line + "\n", "utf8");
    }
    const expected = lines.filter((line) => {
      try {
        const parsed = JSON.parse(line) as { op?: unknown };
        return parsed.op === "pause" || parsed.op === "resume";
      } catch {
        return false;
      }
    }).length;

    const frames: CaptureGateFrame[] = [];
    const errors: Error[] = [];
    let notify: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const reader = createFifoCaptureGateReader({ path, pollMs: 10 })({
      onFrame: (frame) => {
        frames.push(frame);
        if (frames.length >= expected) notify?.();
      },
      onError: (error) => errors.push(error),
    });
    await (expected === 0
      ? new Promise<void>((resolve) => setTimeout(resolve, 50))
      : done);
    reader.close();
    await assertFrames(frames, errors);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("createFifoCaptureGateReader", () => {
  it("delivers pause and resume in written order", async () => {
    await withReader(
      ['{"op":"pause"}', '{"op":"resume"}'],
      (frames) => {
        expect(frames.map((f) => f.paused)).toEqual([true, false]);
      },
    );
  });

  it("refuses an unknown op with a diagnostic that names no file", async () => {
    // The refusal is the point: silence would read as obedience to a pause the
    // user believes they issued. But the diagnostic must not echo the line —
    // it could name user paths.
    await withReader(
      ['{"op":"self-destruct"}', '{"op":"pause"}'],
      (frames, errors) => {
        expect(frames.map((f) => f.paused)).toEqual([true]);
        expect(errors).toHaveLength(1);
        expect(errors[0]!.message).not.toContain("self-destruct");
      },
    );
  });

  it("skips blank lines and survives malformed JSON", async () => {
    await withReader(
      ["", '{"op":"pause"}', "{broken", '{"op":"resume"}'],
      (frames, errors) => {
        // A malformed line is one lost command with its diagnostic, not a
        // reason to stop reading — later commands still land.
        expect(frames.map((f) => f.paused)).toEqual([true, false]);
        expect(errors.length).toBeGreaterThanOrEqual(1);
      },
    );
  });

  it("reads nothing when the file does not exist yet", async () => {
    // ENOENT is the normal pre-first-write state; it must not even produce a
    // diagnostic storm.
    await withReader([], (frames, errors) => {
      expect(frames).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });
  });

  it("carries a partial trailing line until it completes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "capture-gate-"));
    const path = join(directory, "control.fifo");
    try {
      // Write half a line, let a poll cycle see it, then finish it.
      await appendFile(path, '{"op":"pa', "utf8");
      const frames: CaptureGateFrame[] = [];
      const reader = createFifoCaptureGateReader({ path, pollMs: 10 })({
        onFrame: (frame) => frames.push(frame),
        onError: () => undefined,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      expect(frames).toHaveLength(0); // half a line parses as nothing

      await appendFile(path, 'use"}\n', "utf8");
      await new Promise<void>((resolve) => setTimeout(resolve, 60));
      reader.close();
      expect(frames.map((f) => f.paused)).toEqual([true]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a relative path at factory time", () => {
    expect(() => createFifoCaptureGateReader({ path: "relative/fifo" })).toThrow(/absolute/);
  });
});
