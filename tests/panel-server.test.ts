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
    start: async (options = {}) => {
      const server = await startPanelServer({
        socketPath: options.socketPath ?? socketPath,
        onControl: options.onControl ?? (() => undefined),
        ...(options.onAnswer === undefined ? {} : { onAnswer: options.onAnswer }),
        ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
      });
      servers.push(server);
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

describe("startPanelServer transport", () => {
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
 * The Windows panel transport: the same server code, bound at an explicit
 * loopback `tcp://` endpoint instead of a filesystem socket. TCP listen is
 * platform-independent, so these run everywhere — they exercise the exact
 * branch Windows takes, including that none of the Unix socket's file-based
 * behaviors (clear-bind-path, chmod, unlink-on-close) fire on it.
 */
describe("startPanelServer tcp transport", () => {
  /** Claims an ephemeral port by binding and immediately releasing it. */
  const freeLoopbackPort = async (): Promise<number> => {
    const probe = Bun.listen<number>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (_socket) => undefined,
        data: (_socket, _chunk) => undefined,
        close: (_socket) => undefined,
        error: (_socket, _error) => undefined,
      },
    });
    const port = probe.port;
    probe.stop(true);
    await Bun.sleep(10);
    return port;
  };

  const tcpConnect = async (
    port: number,
    lines: string[],
    notify: { fn: (() => void) | null; want: number },
  ) =>
    Bun.connect<undefined>({
      hostname: "127.0.0.1",
      port,
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

  it("serves the same protocol over tcp://127.0.0.1:<port>", async () => {
    const port = await freeLoopbackPort();
    const endpoint = `tcp://127.0.0.1:${port}`;
    const ops: string[] = [];
    const server = await startPanelServer({
      socketPath: endpoint,
      onControl: (op) => ops.push(op),
    });
    try {
      const lines: string[] = [];
      const notify = { fn: null as (() => void) | null, want: Number.POSITIVE_INFINITY };
      const client = await tcpConnect(port, lines, notify);
      await until(() => server.clientCount === 1, "the tcp client to register");

      server.broadcast(WORLD_LINE);
      notify.want = 1;
      await new Promise<void>((resolve) => {
        notify.fn = resolve;
      });
      expect(JSON.parse(lines[0] ?? "")).toEqual(WORLD_LINE);

      client.write('{"type":"control","op":"pause"}\n');
      await until(() => ops.length === 1, "the tcp control op to arrive");
      expect(ops).toEqual(["pause"]);

      client.end();
    } finally {
      await server.close();
    }
  });

  it("does not create or remove any file for a tcp endpoint", async () => {
    // The endpoint is not a path. Any file bookkeeping on it would be a bug:
    // either a stray artifact next to the cwd, or an unlink of a path that was
    // never a socket.
    const port = await freeLoopbackPort();
    const sentinel = join(tmpdir(), `squid-panel-tcp-${port}`);
    try {
      const server = await startPanelServer({
        socketPath: `tcp://127.0.0.1:${port}`,
        onControl: () => undefined,
      });
      await server.close();
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      await rm(sentinel, { force: true });
    }
  });

  it("two servers cannot bind the same tcp endpoint", async () => {
    // On Unix, the file mode and the refusal-to-clobber are the boundary; on
    // TCP the equivalent guarantee is that a second bind at a live endpoint
    // fails loudly rather than silently stealing the port.
    const port = await freeLoopbackPort();
    const first = await startPanelServer({
      socketPath: `tcp://127.0.0.1:${port}`,
      onControl: () => undefined,
    });
    try {
      await expect(
        startPanelServer({ socketPath: `tcp://127.0.0.1:${port}`, onControl: () => undefined }),
      ).rejects.toThrow();
    } finally {
      await first.close();
    }
  });
});
