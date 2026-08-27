import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createFifoCaptureGateReader } from "../src/capture-gate-reader-fifo.js";
import type { CaptureGateFrame } from "../src/capture-gate-source.js";
import { appendGateCommand } from "../src/panel-control.js";

/**
 * `appendGateCommand` writes the other end of an existing channel, so the tests
 * assert against that channel rather than against a restated format: the exact
 * bytes, and then the real reader's interpretation of them. A format change that
 * only this file knew about would pass a self-consistent test and still leave
 * the panel's pause button silently inert.
 */

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "squid-panel-control-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Drives the real FIFO reader over a file until `expected` frames land. */
async function readFrames(path: string, expected: number): Promise<CaptureGateFrame[]> {
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
  try {
    await done;
  } finally {
    reader.close();
  }
  expect(errors).toEqual([]);
  return frames;
}

describe("appendGateCommand", () => {
  it("writes exactly the bytes the gate reader's line protocol specifies", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "control.fifo");

      await appendGateCommand(path, "pause");

      // The exact bytes, not a reformatting of them: the shell alias in
      // `capture-gate-reader-fifo.ts` writes this literal string, and the panel
      // must be indistinguishable from the alias.
      expect(await readFile(path, "utf8")).toBe('{"op":"pause"}\n');
    });
  });

  it("writes the resume command in the same shape", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "control.fifo");

      await appendGateCommand(path, "resume");

      expect(await readFile(path, "utf8")).toBe('{"op":"resume"}\n');
    });
  });

  it("appends rather than overwriting, so a command log accumulates", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "control.fifo");

      await appendGateCommand(path, "pause");
      await appendGateCommand(path, "resume");

      // Overwriting would not just lose the first command: the reader tracks a
      // byte offset, and a shorter file reads as a truncation and replays.
      expect(await readFile(path, "utf8")).toBe('{"op":"pause"}\n{"op":"resume"}\n');
    });
  });

  it("appends after content another writer already put in the file", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "control.fifo");
      // A shell alias got there first. One control path means both writers
      // share the file, so the panel must not clobber what the alias wrote.
      await writeFile(path, '{"op":"pause"}\n', "utf8");

      await appendGateCommand(path, "resume");

      expect(await readFile(path, "utf8")).toBe('{"op":"pause"}\n{"op":"resume"}\n');
    });
  });

  it("produces a line the real FIFO gate reader turns into a paused frame", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "control.fifo");
      await appendGateCommand(path, "pause");

      const frames = await readFrames(path, 1);

      expect(frames).toEqual([{ paused: true }]);
    });
  });

  it("produces lines the reader delivers in written order", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "control.fifo");
      await appendGateCommand(path, "pause");
      await appendGateCommand(path, "resume");

      const frames = await readFrames(path, 2);

      // Order is the whole meaning of a gate log: a resume ahead of its pause
      // would leave capture running when the user believes it stopped.
      expect(frames.map((frame) => frame.paused)).toEqual([true, false]);
    });
  });

  it("rejects when the path cannot be written", async () => {
    await withTempDir(async (dir) => {
      // A directory component that does not exist. The user pressed pause and
      // is owed the failure rather than a silent success.
      const path = join(dir, "missing", "control.fifo");

      await expect(appendGateCommand(path, "pause")).rejects.toThrow();
    });
  });
});
