import { describe, expect, it } from "bun:test";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePipeEndpoint,
  startEndpointLineReader,
} from "../src/endpoint-transport.js";

/** Waits until `predicate` holds, so no test asserts on a fixed sleep. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/** A bounded pause, only for asserting that nothing arrives. */
const settle = (): Promise<void> => Bun.sleep(60);

/** A pipe name no other test or run can collide with. */
const freePipeName = (): string =>
  `\\\\.\\pipe\\squid-endpoint-test-${process.pid}-${Math.random().toString(36).slice(2)}`;

/** One writer's whole write: connect, send the framed lines, close. */
async function pipeWrite(pipeName: string, text: string): Promise<void> {
  const socket = await Bun.connect<undefined>({
    unix: pipeName,
    socket: {
      data: () => undefined,
      open: () => undefined,
      close: () => undefined,
      error: () => undefined,
    },
  });
  socket.write(text);
  socket.end();
}

async function scratchFile(name = "lines.jsonl"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "squid-endpoint-"));
  return join(directory, name);
}

describe("parsePipeEndpoint", () => {
  it("accepts both pipe spellings and rejects everything a resolver reads as a path", () => {
    expect(parsePipeEndpoint("\\\\.\\pipe\\squid-gate")).toBe("\\\\.\\pipe\\squid-gate");
    // The slash spelling is normalized to the canonical dot form, the same
    // normalization the panel endpoint applies — one vocabulary, not two.
    expect(parsePipeEndpoint("//./pipe/squid-gate")).toBe("\\\\.\\pipe\\squid-gate");
    expect(parsePipeEndpoint("/run/squid/gate")).toBeUndefined();
    expect(parsePipeEndpoint("C:\\pipe\\gate")).toBeUndefined();
    expect(parsePipeEndpoint("gate.fifo")).toBeUndefined();
  });
});

describe("startEndpointLineReader", () => {
  it("serves a pipe endpoint from one connection's single write", async () => {
    const pipeName = freePipeName();
    const lines: string[] = [];
    const errors: Error[] = [];
    const reader = startEndpointLineReader({
      path: pipeName,
      onLine: (line) => lines.push(line),
      onError: (error) => errors.push(error),
    });
    try {
      await pipeWrite(pipeName, '{"op":"pause"}\n{"op":"resume"}\n');
      await until(() => lines.length === 2, "both lines to arrive");
      expect(lines).toEqual(['{"op":"pause"}', '{"op":"resume"}']);
      expect(errors).toEqual([]);
    } finally {
      reader.close();
    }
  });

  it("holds a half-written line until the rest of it arrives", async () => {
    // A hook's write is not atomic over a pipe either; the listener must carry
    // the fragment per connection rather than parse it early or lose it.
    const pipeName = freePipeName();
    const lines: string[] = [];
    const reader = startEndpointLineReader({
      path: pipeName,
      onLine: (line) => lines.push(line),
      onError: () => undefined,
    });
    try {
      // One connection, two writes: the split the carry exists for.
      const socket = await Bun.connect<undefined>({
        unix: pipeName,
        socket: {
          data: () => undefined,
          open: () => undefined,
          close: () => undefined,
          error: () => undefined,
        },
      });
      socket.write('{"command":"bun te');
      await settle();
      expect(lines).toEqual([]);
      socket.write('st","exitCode":1}\n');
      socket.end();
      await until(() => lines.length === 1, "the completed line to arrive");
      expect(lines).toEqual(['{"command":"bun test","exitCode":1}']);
    } finally {
      reader.close();
    }
  });

  it("drops a fragment abandoned by a writer that closed mid-line", async () => {
    // A writer that crashes mid-write costs one lost line, not a wrong frame:
    // a half-object parsed as JSON would be worse than silence.
    const pipeName = freePipeName();
    const lines: string[] = [];
    const reader = startEndpointLineReader({
      path: pipeName,
      onLine: (line) => lines.push(line),
      onError: () => undefined,
    });
    try {
      const socket = await Bun.connect<undefined>({
        unix: pipeName,
        socket: {
          data: () => undefined,
          open: () => undefined,
          close: () => undefined,
          error: () => undefined,
        },
      });
      socket.write('{"command":"bu');
      socket.end();
      await settle();
      expect(lines).toEqual([]);
    } finally {
      reader.close();
    }
  });

  it("keeps two connections' lines separate", async () => {
    // Two shell hooks firing at once must not fuse into one malformed line —
    // the per-connection carry is what prevents it, and this is the assertion
    // that fails if the buffer ever becomes shared.
    const pipeName = freePipeName();
    const lines: string[] = [];
    const reader = startEndpointLineReader({
      path: pipeName,
      onLine: (line) => lines.push(line),
      onError: () => undefined,
    });
    try {
      // Connection one writes a fragment and dies with it; connection two
      // writes a complete line of its own. A shared buffer would fuse them
      // into '{"command":"bun test"}' — a line neither writer wrote.
      await pipeWrite(pipeName, '{"command":"bu');
      await pipeWrite(pipeName, '{"command":"make"}\n');
      await until(() => lines.length === 1, "the second connection's line to arrive");
      // The first connection's fragment died with its close: half of one
      // writer's line plus half of another's is not a line anybody wrote.
      expect(lines).toEqual(['{"command":"make"}']);
    } finally {
      reader.close();
    }
  });

  it("stops listening after close", async () => {
    const pipeName = freePipeName();
    const lines: string[] = [];
    const reader = startEndpointLineReader({
      path: pipeName,
      onLine: (line) => lines.push(line),
      onError: () => undefined,
    });
    reader.close();
    await expect(pipeWrite(pipeName, '{"op":"pause"}\n')).rejects.toThrow();
    await settle();
    expect(lines).toEqual([]);
  });

  it("still reads the file dialect unchanged", async () => {
    // The dispatch must not change the existing transport: a POSIX path is
    // tailed exactly as `fifo-line-reader` always tailed it, pre-existing
    // content included.
    const path = await scratchFile();
    await writeFile(path, '{"op":"pause"}\n', "utf8");
    const lines: string[] = [];
    const reader = startEndpointLineReader({
      path,
      pollMs: 5,
      onLine: (line) => lines.push(line),
      onError: () => undefined,
    });
    try {
      await until(() => lines.length === 1, "the seeded line to arrive");
      await appendFile(path, '{"op":"resume"}\n', "utf8");
      await until(() => lines.length === 2, "the appended line to arrive");
      expect(lines).toEqual(['{"op":"pause"}', '{"op":"resume"}']);
    } finally {
      reader.close();
    }
  });
});
