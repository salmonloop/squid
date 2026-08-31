import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import { describe, expect, it } from "bun:test";
import type { PanelMessage } from "../src/panel-view.js";
import { startPanelServer, type PanelServer } from "../src/panel-server.js";

/**
 * Every test here opens a real Unix socket, so every one of them closes it in a
 * `finally`. A leaked listener keeps handles alive and `bun test` hangs instead
 * of failing, which reads as an infrastructure problem rather than a bug.
 *
 * Nothing waits on a wall clock for an expected outcome: a test that sleeps 50ms
 * and hopes passes on a fast machine and fails on a loaded one. Arrivals are
 * awaited through a promise the handler resolves; only the deliberate
 * *nothing-should-arrive* assertions use a bounded settle.
 */

const WORLD_LINE: PanelMessage = {
  type: "world_state",
  updatedAt: "2026-08-27T10:00:00.000Z",
  application: "Code",
  gate: "open",
};

interface Harness {
  readonly socketPath: string;
  /** Connects a client and collects whole lines it receives. */
  connect(): Promise<TestClient>;
  /** The wire the onConnect tests announce standing state through. */
  announce: PanelServer["broadcast"];
  /** Replaceable so a test can supply its own onConnect hook. */
  onConnect?: (clientCount: number) => void;
  start(options?: {
    readonly onControl?: (op: "pause" | "resume") => void;
    readonly onAnswer?: (promptId: number, answer: "approved" | "declined") => void;
    readonly onDiagnostic?: (line: string) => void;
    /** Bind at a path other than the harness default. */
    readonly socketPath?: string;
  }): Promise<PanelServer>;
}

interface TestClient {
  readonly socket: Socket<undefined>;
  readonly lines: string[];
  /** Resolves once `count` whole lines have arrived. */
  waitFor(count: number): Promise<void>;
  close(): void;
}

/**
 * Runs `body` against a fresh temp directory, closing every server and client it
 * opened. Cleanup runs even when an assertion throws — otherwise one failure
 * would hang the rest of the file.
 */
async function withHarness(body: (harness: Harness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "squid-panel-server-"));
  const servers: PanelServer[] = [];
  const clients: TestClient[] = [];
  const socketPath = join(dir, "panel.sock");

  const harness: Harness = {
    socketPath,
    announce: () => undefined,
    start: async (options = {}) => {
      const server = await startPanelServer({
        socketPath: options.socketPath ?? socketPath,
        onControl: options.onControl ?? (() => undefined),
        ...(options.onAnswer === undefined ? {} : { onAnswer: options.onAnswer }),
        ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
        ...(harness.onConnect === undefined ? {} : { onConnect: harness.onConnect }),
      });
      servers.push(server);
      // Late-bound so a test can set `harness.onConnect` between start calls.
      harness.announce = server.broadcast;
      return server;
    },
    connect: async () => {
      const lines: string[] = [];
      let carry = "";
      let want = Number.POSITIVE_INFINITY;
      let notify: (() => void) | null = null;
      const socket = await Bun.connect<undefined>({
        unix: socketPath,
        socket: {
          data: (_socket, chunk) => {
            carry += chunk.toString("utf8");
            const parts = carry.split("\n");
            carry = parts.pop() ?? "";
            for (const part of parts) lines.push(part);
            if (lines.length >= want) notify?.();
          },
          open: () => undefined,
          close: () => undefined,
          error: () => undefined,
        },
      });
      const client: TestClient = {
        socket,
        lines,
        waitFor: async (count) => {
          if (lines.length >= count) return;
          want = count;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        },
        close: () => socket.end(),
      };
      clients.push(client);
      return client;
    },
  };

  try {
    await body(harness);
  } finally {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // Already gone.
      }
    }
    for (const server of servers) await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

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

/**
 * The Unix transport's *filesystem* contract: a mode, an unlink, a refusal to
 * overwrite. Every assertion here is about the socket file, which is why the
 * whole group is gated on Unix rather than each test guarding itself — on
 * Windows there is no socket file to have a mode, and `withHarness` builds a
 * path under `tmpdir()` that `Bun.listen` would bind as a pipe-less AF_UNIX
 * name if it could. Measured on the Windows runner: `stat` of it fails EACCES,
 * `existsSync` reports false for a bound one, and the chmod has nothing to act
 * on. Skipping says that plainly; running them there produced four failures
 * that named a platform mismatch rather than a defect.
 *
 * The named-pipe group at the bottom of this file is the Windows counterpart.
 */
describe.skipIf(process.platform === "win32")("startPanelServer transport", () => {
  it("restricts the socket file to mode 600 after binding", async () => {
    await withHarness(async (harness) => {
      await harness.start();

      // Measured default is 775, which lets any user in the group read the world
      // state and send pause. The file mode is the only access control on this
      // socket, so this assertion is the security boundary.
      expect(statSync(harness.socketPath).mode & 0o777).toBe(0o600);
    });
  });

  it("binds over a stale socket file left by an earlier run", async () => {
    await withHarness(async (harness) => {
      // A previous server's file: `stop()` does not remove it, so a crashed run
      // leaves one behind and a fresh start must not be blocked by it.
      const stale = await harness.start();
      await stale.close();
      const orphan = await startPanelServer({
        socketPath: harness.socketPath,
        onControl: () => undefined,
      });
      // Leave the file on disk, exactly as a killed process would.
      expect(existsSync(harness.socketPath)).toBe(true);

      const server = await harness.start();
      try {
        const client = await harness.connect();
        server.broadcast(WORLD_LINE);
        await client.waitFor(1);

        expect(client.lines[0]).toContain('"type":"world_state"');
      } finally {
        await orphan.close();
      }
    });
  });

  it("leaves a non-socket file at the path alone rather than destroying it", async () => {
    await withHarness(async (harness) => {
      // Measured: `Bun.listen({ unix })` binds over a regular file and destroys
      // its contents, so a mistyped SQUID_PANEL_SOCKET pointing at real data
      // must fail rather than unlink it.
      const occupied = join(harness.socketPath, "..", "not-a-socket.txt");
      await writeFile(occupied, "user data\n", "utf8");

      await expect(harness.start({ socketPath: occupied })).rejects.toThrow();
      expect(existsSync(occupied)).toBe(true);
    });
  });

  it("close() removes the socket file and is idempotent", async () => {
    await withHarness(async (harness) => {
      const server = await harness.start();
      expect(existsSync(harness.socketPath)).toBe(true);

      await server.close();
      expect(existsSync(harness.socketPath)).toBe(false);

      // A session may close on its own path and again in a teardown handler.
      await server.close();
      expect(existsSync(harness.socketPath)).toBe(false);
    });
  });

  it("does not unlink a socket a later server bound at the same path", async () => {
    await withHarness(async (harness) => {
      const first = await harness.start();
      await first.close();
      const second = await harness.start();

      // The second `close()` on a already-closed server must be inert, not a
      // delayed unlink that pulls the live server's socket out from under it.
      await first.close();

      expect(existsSync(harness.socketPath)).toBe(true);
      await second.close();
    });
  });
});

describe("startPanelServer broadcast", () => {
  it("delivers a broadcast line to a connected client", async () => {
    await withHarness(async (harness) => {
      const server = await harness.start();
      const client = await harness.connect();
      await until(() => server.clientCount === 1, "the client to register");

      server.broadcast(WORLD_LINE);
      await client.waitFor(1);

      expect(JSON.parse(client.lines[0] ?? "")).toEqual(WORLD_LINE);
    });
  });

  it("delivers the same line to two clients", async () => {
    await withHarness(async (harness) => {
      const server = await harness.start();
      const first = await harness.connect();
      const second = await harness.connect();
      await until(() => server.clientCount === 2, "both clients to register");

      server.broadcast(WORLD_LINE);
      await first.waitFor(1);
      await second.waitFor(1);

      expect(first.lines[0]).toBe(second.lines[0]);
      expect(JSON.parse(first.lines[0] ?? "")).toEqual(WORLD_LINE);
    });
  });

  it("frames each message as its own newline-terminated line", async () => {
    await withHarness(async (harness) => {
      const server = await harness.start();
      const client = await harness.connect();
      await until(() => server.clientCount === 1, "the client to register");

      server.broadcast(WORLD_LINE);
      server.broadcast({
        type: "agent",
        at: "2026-08-27T10:00:01.000Z",
        status: "replied",
        text: "ran the tests",
      });
      await client.waitFor(2);

      // Two broadcasts back to back must not coalesce into one unparseable
      // line, whatever the kernel does with the two writes.
      expect(client.lines.map((line) => JSON.parse(line).type)).toEqual([
        "world_state",
        "agent",
      ]);
    });
  });

  it("reports zero clients before any connection and after one leaves", async () => {
    await withHarness(async (harness) => {
      const server = await harness.start();
      expect(server.clientCount).toBe(0);

      const client = await harness.connect();
      await until(() => server.clientCount === 1, "the client to register");

      client.close();
      await until(() => server.clientCount === 0, "the client to deregister");
    });
  });

  it("broadcasting with no clients is a no-op, not a failure", async () => {
    await withHarness(async (harness) => {
      const server = await harness.start();

      expect(() => server.broadcast(WORLD_LINE)).not.toThrow();
    });
  });

  it("a client that disappears is dropped without failing the broadcast", async () => {
    await withHarness(async (harness) => {
      const diagnostics: string[] = [];
      const server = await harness.start({ onDiagnostic: (line) => diagnostics.push(line) });
      const survivor = await harness.connect();
      const doomed = await harness.connect();
      await until(() => server.clientCount === 2, "both clients to register");

      doomed.close();
      await until(() => server.clientCount === 1, "the dead client to deregister");

      // The surviving panel still gets its line: one dead observer must not
      // take down the watch session's reporting.
      expect(() => server.broadcast(WORLD_LINE)).not.toThrow();
      await survivor.waitFor(1);
      expect(JSON.parse(survivor.lines[0] ?? "")).toEqual(WORLD_LINE);
    });
  });
});

describe("startPanelServer incoming control", () => {
  it("invokes onControl with pause", async () => {
    await withHarness(async (harness) => {
      const ops: string[] = [];
      const server = await harness.start({ onControl: (op) => ops.push(op) });
      const client = await harness.connect();
      await until(() => server.clientCount === 1, "the client to register");

      client.socket.write('{"type":"control","op":"pause"}\n');
      await until(() => ops.length === 1, "the control op to arrive");

      expect(ops).toEqual(["pause"]);
    });
  });

  it("invokes onControl with resume", async () => {
    await withHarness(async (harness) => {
      const ops: string[] = [];
      const server = await harness.start({ onControl: (op) => ops.push(op) });
      const client = await harness.connect();
      await until(() => server.clientCount === 1, "the client to register");

      client.socket.write('{"type":"control","op":"resume"}\n');
      await until(() => ops.length === 1, "the control op to arrive");

      expect(ops).toEqual(["resume"]);
    });
  });

  it("parses a line split across two writes", async () => {
    await withHarness(async (harness) => {
      const ops: string[] = [];
      const server = await harness.start({ onControl: (op) => ops.push(op) });
      const client = await harness.connect();
      await until(() => server.clientCount === 1, "the client to register");

      // UDS delivers bytes, not lines. Measured: these arrive as two separate
      // `data` callbacks, so a handler that parsed each chunk would see two
      // unparseable fragments and drop a pause the user pressed.
      client.socket.write('{"type":"cont');
      await settle();
      client.socket.write('rol","op":"pause"}\n');
      await until(() => ops.length === 1, "the split control op to arrive");

      expect(ops).toEqual(["pause"]);
    });
  });

  it("parses two lines arriving in one chunk", async () => {
    await withHarness(async (harness) => {
      const ops: string[] = [];
      const server = await harness.start({ onControl: (op) => ops.push(op) });
      const client = await harness.connect();
      await until(() => server.clientCount === 1, "the client to register");

      client.socket.write('{"type":"control","op":"pause"}\n{"type":"control","op":"resume"}\n');
      await until(() => ops.length === 2, "both control ops to arrive");

      expect(ops).toEqual(["pause", "resume"]);
    });
  });

  it("invokes onAnswer with an integer promptId", async () => {
    await withHarness(async (harness) => {
      const answers: (readonly [number, string])[] = [];
      const server = await harness.start({
        onAnswer: (promptId, answer) => answers.push([promptId, answer]),
      });
      const client = await harness.connect();
      await until(() => server.clientCount === 1, "the client to register");

      client.socket.write('{"type":"answer","promptId":7,"answer":"approved"}\n');
      await until(() => answers.length === 1, "the answer to arrive");

      expect(answers).toEqual([[7, "approved"]]);
    });
  });

  it("drops lines it cannot parse or does not recognize", async () => {
    await withHarness(async (harness) => {
      const ops: string[] = [];
      const answers: number[] = [];
      const diagnostics: string[] = [];
      const server = await harness.start({
        onControl: (op) => ops.push(op),
        onAnswer: (promptId) => answers.push(promptId),
        onDiagnostic: (line) => diagnostics.push(line),
      });
      const client = await harness.connect();
      await until(() => server.clientCount === 1, "the client to register");

      client.socket.write("not json at all\n");
      client.socket.write('["type","control"]\n');
      client.socket.write('{"type":"control"}\n');
      client.socket.write('{"type":"control","op":"halt"}\n');
      client.socket.write('{"type":"control","op":"PAUSE"}\n');
      client.socket.write('{"type":"answer","promptId":1.5,"answer":"approved"}\n');
      client.socket.write('{"type":"answer","promptId":1,"answer":"maybe"}\n');
      client.socket.write('{"type":"whatever"}\n');
      // A blank line is not an error, just nothing.
      client.socket.write("\n");
      // Then a good one, so the assertion proves the connection still works
      // rather than that everything after the first bad line was lost.
      client.socket.write('{"type":"control","op":"pause"}\n');
      await until(() => ops.length === 1, "the trailing valid op to arrive");
      await settle();

      // Nothing was guessed at: an unrecognized op must not toggle capture.
      expect(ops).toEqual(["pause"]);
      expect(answers).toEqual([]);
      // Each refusal is visible; silence would read as obedience.
      expect(diagnostics.length).toBeGreaterThanOrEqual(8);
    });
  });

  it("refuses an answer when no confirmation handler is wired", async () => {
    await withHarness(async (harness) => {
      const diagnostics: string[] = [];
      const server = await harness.start({ onDiagnostic: (line) => diagnostics.push(line) });
      const client = await harness.connect();
      await until(() => server.clientCount === 1, "the client to register");

      client.socket.write('{"type":"answer","promptId":1,"answer":"approved"}\n');
      await until(() => diagnostics.length >= 1, "the refusal diagnostic");

      expect(diagnostics.some((line) => line.includes("confirmation handler"))).toBe(true);
    });
  });

  it("drops a client that floods the buffer with no newline", async () => {
    await withHarness(async (harness) => {
      const diagnostics: string[] = [];
      const server = await harness.start({ onDiagnostic: (line) => diagnostics.push(line) });
      const client = await harness.connect();
      await until(() => server.clientCount === 1, "the client to register");

      // 256KB with no newline. Buffering it would let any connecting process
      // grow the watch session's memory without limit.
      const flood = "z".repeat(256 * 1024);
      client.socket.write(flood);
      await until(() => server.clientCount === 0, "the flooding client to be dropped");

      expect(diagnostics.some((line) => line.includes("without a newline"))).toBe(true);
    });
  });

  it("keeps serving other clients after one is dropped for flooding", async () => {
    await withHarness(async (harness) => {
      const ops: string[] = [];
      const server = await harness.start({ onControl: (op) => ops.push(op) });
      const wellBehaved = await harness.connect();
      const flooder = await harness.connect();
      await until(() => server.clientCount === 2, "both clients to register");

      flooder.socket.write("z".repeat(256 * 1024));
      await until(() => server.clientCount === 1, "the flooder to be dropped");

      wellBehaved.socket.write('{"type":"control","op":"resume"}\n');
      await until(() => ops.length === 1, "the surviving client's op");
      server.broadcast(WORLD_LINE);
      await wellBehaved.waitFor(1);

      expect(ops).toEqual(["resume"]);
      expect(JSON.parse(wellBehaved.lines[0] ?? "")).toEqual(WORLD_LINE);
    });
  });
});

/**
 * The Windows panel transport: the same server code, the same `Bun.listen`
 * call, bound at a named pipe instead of a filesystem socket.
 *
 * Skipped rather than emulated off Windows, and that is the whole point. Bun's
 * named-pipe listen branch is `#[cfg(windows)]`, so on Linux the identical
 * endpoint string falls through to AF_UNIX — a suite that "passed" here would
 * be asserting against a Unix socket wearing a pipe's name, which is precisely
 * the confusion `isPanelNamedPipe` exists to prevent. These assertions are real
 * on the platform that has pipes and honest about being unmeasured elsewhere.
 */
describe.skipIf(process.platform !== "win32")("startPanelServer named pipe", () => {
  /**
   * Whether this Bun would *panic* rather than throw on a failed named-pipe
   * listen, which decides whether the duplicate-bind assertion below can run at
   * all.
   *
   * Before oven-sh/bun#29422 the assignment is `this.listener = .{ .namedPipe =
   * listen(...) catch return throw(...) }`, and Zig writes a tagged union's tag
   * to the result location *before* evaluating the payload. So a failed listen
   * leaves the tag at `.namedPipe` over garbage payload bytes, the registered
   * `errdefer this.deinit()` fires, and `deinit` walks straight into
   * `bun.assert(this.listener == .none)`. That is an abort, not an exception:
   * `expect(...).rejects` never sees anything, and every later test in this file
   * dies with the process.
   *
   * The fix landed 2026-04-18 and first shipped in Bun 1.3.13; this repo pins
   * 1.3.11 (2026-03-18), a month older. Gating on the version rather than
   * deleting the test keeps the assertion — and this reasoning — in the file,
   * and hands it back the day the pin moves past 1.3.13.
   */
  const BUN_WITH_NAMED_PIPE_LISTEN_ERROR_FIX = "1.3.13";
  const bunPanicsOnFailedPipeListen = ((): boolean => {
    // `Bun.version` can carry a suffix ("1.3.11-canary.42"); `parseInt` stops at
    // it, and a component that is not a number at all counts as 0, which errs
    // toward skipping rather than toward crashing the run.
    const components = (text: string): [number, number, number] => {
      const [major = 0, minor = 0, patch = 0] = text
        .split(".")
        .map((part) => Number.parseInt(part, 10) || 0);
      return [major, minor, patch];
    };
    const have = components(Bun.version);
    const need = components(BUN_WITH_NAMED_PIPE_LISTEN_ERROR_FIX);
    for (let index = 0; index < have.length; index += 1) {
      const haveComponent = have[index] ?? 0;
      const needComponent = need[index] ?? 0;
      if (haveComponent !== needComponent) return haveComponent < needComponent;
    }
    return false;
  })();

  /** A pipe name no other test or run can collide with. */
  const freePipeName = (): string =>
    `\\\\.\\pipe\\squid-panel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;

  const pipeConnect = async (
    pipeName: string,
    lines: string[],
    notify: { fn: (() => void) | null; want: number },
  ) =>
    Bun.connect<undefined>({
      unix: pipeName,
      socket: {
        data: (_socket, chunk) => {
          lines.push(...chunk.toString("utf8").split("\n").filter((part) => part.length > 0));
          if (lines.length >= notify.want) notify.fn?.();
        },
        open: () => undefined,
        close: () => undefined,
        error: () => undefined,
      },
    });

  it("serves the same protocol over a named pipe", async () => {
    const pipeName = freePipeName();
    const ops: string[] = [];
    const server = await startPanelServer({
      socketPath: pipeName,
      onControl: (op) => ops.push(op),
    });
    try {
      const lines: string[] = [];
      const notify = { fn: null as (() => void) | null, want: Number.POSITIVE_INFINITY };
      const client = await pipeConnect(pipeName, lines, notify);
      await until(() => server.clientCount === 1, "the pipe client to register");

      server.broadcast(WORLD_LINE);
      notify.want = 1;
      await new Promise<void>((resolve) => {
        notify.fn = resolve;
      });
      expect(JSON.parse(lines[0] ?? "")).toEqual(WORLD_LINE);

      // Byte mode on both ends, so newline framing means the same thing in both
      // directions; a control op is the round trip that proves it.
      client.write('{"type":"control","op":"pause"}\n');
      await until(() => ops.length === 1, "the pipe control op to arrive");
      expect(ops).toEqual(["pause"]);

      client.end();
    } finally {
      await server.close();
    }
  });

  it("touches the filesystem for neither the bind nor the close", async () => {
    // A pipe lives in the pipe namespace, so `clearBindPath`, the chmod, and the
    // unlink-on-close are all gated off for it. The assertion cannot be
    // `existsSync(pipeName)`: measured on Windows, `stat` of a *live* pipe
    // succeeds, so that would report `true` for a correctly-bound pipe and
    // `false` only once it closed — the exact inverse of the intent. What is
    // actually claimed is that no directory entry appears, so this watches the
    // directory a `\\.\pipe\` path would land in if the name were ever
    // treated as a filesystem path relative to the cwd.
    const pipeName = freePipeName();
    const strayPath = join(process.cwd(), pipeName.replace(/^\\\\[.?]\\pipe\\/, ""));
    expect(existsSync(strayPath)).toBe(false);

    const server = await startPanelServer({ socketPath: pipeName, onControl: () => undefined });
    try {
      expect(existsSync(strayPath)).toBe(false);
    } finally {
      await server.close();
    }
    expect(existsSync(strayPath)).toBe(false);
  });

  it.skipIf(bunPanicsOnFailedPipeListen)("refuses a second bind of the same pipe name", async () => {
    // Bun surfaces this as a Node-shaped EADDRINUSE with syscall "listen"
    // (asserted by Bun's own test/js/bun/net/named-pipe-listen-error.test.ts).
    // Worth pinning here because the Unix socket does *not* refuse a duplicate
    // bind, so the two transports differ and the difference should be recorded
    // where someone reading the transport tests will find it.
    const pipeName = freePipeName();
    const first = await startPanelServer({ socketPath: pipeName, onControl: () => undefined });
    try {
      await expect(
        startPanelServer({ socketPath: pipeName, onControl: () => undefined }),
      ).rejects.toThrow();
    } finally {
      await first.close();
    }
  });
});

describe("startPanelServer onConnect", () => {
  it("delivers standing state to a client that connects after the server started", async () => {
    // The reason the hook exists: broadcast is a one-shot pass over whoever is
    // registered at that instant, and a panel attaches after the server starts,
    // every time. The replay inside onConnect is what the late client hears.
    await withHarness(async (harness) => {
      harness.onConnect = () => harness.announce(WORLD_LINE);
      await harness.start();

      const client = await harness.connect();
      await client.waitFor(1);
      expect(JSON.parse(client.lines[0] ?? "")).toEqual(WORLD_LINE);
      client.close();
    });
  });

  it("runs once per connect, and only after that client is registered", async () => {
    await withHarness(async (harness) => {
      const connects: number[] = [];
      harness.onConnect = (count) => {
        // `count` proves registration happened first: the hook runs with the
        // new client already in the set, so a broadcast inside it reaches it.
        connects.push(count);
        harness.announce(WORLD_LINE);
      };
      const server = await harness.start();

      const first = await harness.connect();
      await first.waitFor(1);
      const second = await harness.connect();
      await second.waitFor(1);

      expect(connects).toEqual([1, 2]);
      expect(JSON.parse(first.lines[0] ?? "")).toEqual(WORLD_LINE);
      // Each client's first line is the replay it triggered itself; the second
      // client never sees the first client's replay.
      expect(JSON.parse(second.lines[0] ?? "")).toEqual(WORLD_LINE);
      first.close();
      second.close();
    });
  });
});
