import { describe, expect, it } from "bun:test";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFifoTerminalCommandReader } from "../src/terminal-command-reader-fifo.js";
import { resolveTerminalReader } from "../src/resolve-terminal-reader.js";
import type { TerminalCommandFrame } from "../src/terminal-command-source.js";

async function scratchFile(name = "commands.jsonl"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "squid-terminal-"));
  return join(directory, name);
}

/** Long enough for a few poll ticks at the 5ms interval these tests use. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

async function reading(path: string) {
  const frames: TerminalCommandFrame[] = [];
  const errors: Error[] = [];
  const reader = createFifoTerminalCommandReader({ path, pollMs: 5 })({
    onFrame: (frame) => frames.push(frame),
    onError: (error) => errors.push(error),
  });
  return { frames, errors, close: () => reader.close() };
}

describe("createFifoTerminalCommandReader", () => {
  it("rejects a relative path at construction", () => {
    // A relative path would resolve against whatever directory the process
    // happened to start in, which is not a property a capability should have.
    expect(() => createFifoTerminalCommandReader({ path: "relative/fifo" }))
      .toThrow("must be absolute");
  });

  it("reads one completion per line", async () => {
    const path = await scratchFile();
    await writeFile(path, "", "utf8");
    const session = await reading(path);
    try {
      await appendFile(path, `${JSON.stringify({ command: "bun test", exitCode: 1 })}\n`, "utf8");
      await appendFile(path, `${JSON.stringify({ command: "make", exitCode: 0 })}\n`, "utf8");
      await settle();

      expect(session.frames.map((frame) => frame.command)).toEqual(["bun test", "make"]);
      expect(session.frames.map((frame) => frame.exitCode)).toEqual([1, 0]);
    } finally {
      session.close();
    }
  });

  it("waits for a complete line rather than parsing a partial write", async () => {
    const path = await scratchFile();
    await writeFile(path, "", "utf8");
    const session = await reading(path);
    try {
      // A hook's write is not guaranteed atomic, so a half-written line must be
      // held rather than parsed into a wrong frame.
      await appendFile(path, '{"command":"bun te', "utf8");
      await settle();
      expect(session.frames).toHaveLength(0);

      await appendFile(path, 'st","exitCode":1}\n', "utf8");
      await settle();
      expect(session.frames.map((frame) => frame.command)).toEqual(["bun test"]);
    } finally {
      session.close();
    }
  });

  it("skips a malformed line and keeps reading", async () => {
    const path = await scratchFile();
    await writeFile(path, "", "utf8");
    const session = await reading(path);
    try {
      await appendFile(path, "not json at all\n", "utf8");
      await appendFile(path, `${JSON.stringify({ noCommand: true })}\n`, "utf8");
      await appendFile(path, `${JSON.stringify({ command: "bun test", exitCode: 1 })}\n`, "utf8");
      await settle();

      // One lost completion is not a reason to stop reading. Note the malformed
      // line is also not reported as a diagnostic: its content is a raw command,
      // which must not reach a log.
      expect(session.frames.map((frame) => frame.command)).toEqual(["bun test"]);
      expect(session.errors).toHaveLength(0);
    } finally {
      session.close();
    }
  });

  it("treats a missing exit code as unknown rather than dropping the line", async () => {
    const path = await scratchFile();
    await writeFile(path, `${JSON.stringify({ command: "bun test" })}\n`, "utf8");
    const session = await reading(path);
    try {
      await settle();
      expect(session.frames).toHaveLength(1);
      // The source then treats unknown as failure, which is the surfacing
      // direction rather than the hiding one.
      expect(session.frames[0]!.exitCode).toBeNull();
    } finally {
      session.close();
    }
  });

  it("stays quiet while the file does not exist yet", async () => {
    const path = await scratchFile("never-created.jsonl");
    const session = await reading(path);
    try {
      await settle();
      // The normal state before the first shell writes. Reporting it every tick
      // would bury a real failure in noise.
      expect(session.errors).toHaveLength(0);
      expect(session.frames).toHaveLength(0);
    } finally {
      session.close();
    }
  });

  it("restarts from the beginning when the file is truncated", async () => {
    const path = await scratchFile();
    await writeFile(path, `${JSON.stringify({ command: "bun test", exitCode: 1 })}\n`, "utf8");
    const session = await reading(path);
    try {
      await settle();
      expect(session.frames).toHaveLength(1);

      // Log rotation, or a fresh shell session truncating the file. Reading from
      // the stale offset would slice mid-line and produce garbage.
      await writeFile(path, `${JSON.stringify({ command: "make", exitCode: 2 })}\n`, "utf8");
      await settle();
      expect(session.frames.map((frame) => frame.command)).toEqual(["bun test", "make"]);
    } finally {
      session.close();
    }
  });

  it("reads content written before it started", async () => {
    const path = await scratchFile();
    await writeFile(path, `${JSON.stringify({ command: "bun test", exitCode: 1 })}\n`, "utf8");
    const session = await reading(path);
    try {
      await settle();
      expect(session.frames).toHaveLength(1);
    } finally {
      session.close();
    }
  });

  it("stops reading after close", async () => {
    const path = await scratchFile();
    await writeFile(path, "", "utf8");
    const session = await reading(path);
    session.close();
    await appendFile(path, `${JSON.stringify({ command: "bun test", exitCode: 1 })}\n`, "utf8");
    await settle();
    expect(session.frames).toHaveLength(0);
  });
});

describe("resolveTerminalReader", () => {
  it("is off when unset", () => {
    expect(resolveTerminalReader({ env: {} })).toEqual({ enabled: false });
  });

  it("rejects near-miss values rather than defaulting", () => {
    for (const value of ["Fifo", "FIFO", "on", "true", "", "fifo "]) {
      const resolved = resolveTerminalReader({
        env: { SQUID_TERMINAL: value, SQUID_TERMINAL_FIFO: "/tmp/x" },
      });
      expect("configError" in resolved).toBe(true);
    }
  });

  it("requires an absolute path", () => {
    expect(resolveTerminalReader({ env: { SQUID_TERMINAL: "fifo" } }))
      .toMatchObject({ configError: expect.stringContaining("SQUID_TERMINAL_FIFO") });
    expect(resolveTerminalReader({
      env: { SQUID_TERMINAL: "fifo", SQUID_TERMINAL_FIFO: "" },
    })).toMatchObject({ configError: expect.stringContaining("SQUID_TERMINAL_FIFO") });
    expect(resolveTerminalReader({
      env: { SQUID_TERMINAL: "fifo", SQUID_TERMINAL_FIFO: "relative/path" },
    })).toMatchObject({ configError: expect.stringContaining("absolute") });
  });

  it("rejects a poll interval that is not a positive integer", () => {
    for (const value of ["0", "-1", "1.5", "abc"]) {
      const resolved = resolveTerminalReader({
        env: {
          SQUID_TERMINAL: "fifo",
          SQUID_TERMINAL_FIFO: "/tmp/squid.jsonl",
          SQUID_TERMINAL_POLL_MS: value,
        },
      });
      expect("configError" in resolved && resolved.configError)
        .toContain("SQUID_TERMINAL_POLL_MS");
    }
  });

  it("enables the fifo backend on an absolute path", () => {
    const resolved = resolveTerminalReader({
      env: { SQUID_TERMINAL: "fifo", SQUID_TERMINAL_FIFO: "/tmp/squid-commands.jsonl" },
    });
    if ("configError" in resolved) throw new Error(resolved.configError);
    expect(resolved.enabled).toBe(true);
  });

  it("ignores terminal variables entirely when the source is off", () => {
    // Nothing is being configured, so an unused or invalid companion value is not
    // an error — reporting one would block a run over a variable with no effect.
    expect(resolveTerminalReader({
      env: { SQUID_TERMINAL_FIFO: "relative", SQUID_TERMINAL_POLL_MS: "0" },
    })).toEqual({ enabled: false });
  });
});
