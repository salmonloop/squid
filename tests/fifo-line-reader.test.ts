import { spawnSync } from "node:child_process";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { startFifoLineReader } from "../src/fifo-line-reader.js";

/**
 * The transport tests that feed an append-only file never exercise the half of
 * the endpoint contract the name promises: a real named pipe. On a pipe `stat`
 * always reports size 0, so an offset-based reader reads nothing forever — the
 * exact failure the live E2E caught. These tests create a real `mkfifo` and
 * prove the drain path against it; on systems without `mkfifo` they are skipped.
 */

let dir: string | undefined;

afterAll(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

async function makeFifoPath(name: string): Promise<string | null> {
  const base = (dir ??= await mkdtemp(join(tmpdir(), "squid-fifo-")));
  const path = join(base, name);
  const created = spawnSync("mkfifo", [path]);
  return created.status === 0 ? path : null;
}

describe("startFifoLineReader", () => {
  test("delivers lines written to a real named pipe", async () => {
    const path = await makeFifoPath("terminal.fifo");
    if (path === null) return; // no mkfifo on this platform

    const lines: string[] = [];
    const reader = startFifoLineReader({
      path,
      pollMs: 5,
      onLine: (line) => lines.push(line),
      onError: (error) => {
        throw error;
      },
    });
    try {
      // The shell hook's write shape: open-append, write, close. The append
      // blocks until a reader opens, which the poll loop does every tick.
      await appendFile(path, '{"command":"bun test"}\n{"command":"make"}\n');
      await waitFor(() => lines.length >= 2);
      expect(lines).toEqual(['{"command":"bun test"}', '{"command":"make"}']);
    } finally {
      reader.close();
    }
  });

  test("keeps draining a pipe across writes with gaps", async () => {
    const path = await makeFifoPath("terminal-gaps.fifo");
    if (path === null) return;

    const lines: string[] = [];
    const reader = startFifoLineReader({
      path,
      pollMs: 5,
      onLine: (line) => lines.push(line),
      onError: (error) => {
        throw error;
      },
    });
    try {
      await appendFile(path, "first\n");
      await waitFor(() => lines.length >= 1);
      // A second, later write must land too: the drain reads per tick, it
      // does not assume one open serves the pipe's whole life.
      await appendFile(path, "second\n");
      await waitFor(() => lines.length >= 2);
      expect(lines).toEqual(["first", "second"]);
    } finally {
      reader.close();
    }
  });
});

/** Polls until the probe passes; a live reader's delivery is asynchronous. */
async function waitFor(probe: () => boolean): Promise<void> {
  for (let waited = 0; waited < 2000 && !probe(); waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
