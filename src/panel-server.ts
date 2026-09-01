import { chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import type { Socket } from "bun";
import { describeErrorForAudit } from "./audit-text.js";
import type { PanelMessage } from "./panel-view.js";
import { panelLine } from "./panel-view.js";
import { isPanelNamedPipe } from "./resolve-panel.js";

/**
 * The watch session's listening end of the panel wire (`docs/panel-protocol.md`).
 *
 * On Unix this is a domain socket; on Windows a named pipe. Both bind through
 * the same `Bun.listen({ unix })` call: Bun inspects the string and takes its
 * named-pipe branch when the value spells one, so the endpoint names the
 * transport and there is exactly one listen path to reason about.
 *
 * TS listens rather than connects: the panel can start before or after the
 * session and reconnect on its own, so neither side's restart forces the other's.
 *
 * ## Neither transport is authenticated
 *
 * Anything that can connect can read the world state — foreground application,
 * sanitized window titles, agent replies — and can send `pause`.
 *
 * On Unix the file mode is the whole boundary. The measured default after
 * `Bun.listen({ unix })` is **775**, which lets any user in the group connect,
 * so `startPanelServer` chmods to **600** immediately after binding. Do not
 * remove that chmod and do not widen it.
 *
 * On Windows there is no equivalent. Bun binds through `uv_pipe_bind`, which
 * passes NULL security attributes, and exposes neither a chmod parameter nor the
 * pipe HANDLE — so the pipe carries the default named-pipe DACL, under which
 * **any local user can read it**. That is a known and accepted limitation of
 * this phase, not an oversight, and it is why the Windows spelling is the pipe
 * namespace rather than a loopback port: a port would have been reachable by
 * anything that could route to the host, where a pipe at least stays local.
 *
 * ## The bind path is cleared, not blindly overwritten — on Unix only
 *
 * `stop()` does not remove the socket file, so a crashed run leaves one behind
 * and it must be unlinked before re-binding. But measured: `Bun.listen({ unix })`
 * also binds over a **regular file** and destroys its contents with no error, so
 * a mistyped `SQUID_PANEL_SOCKET` naming real data would be silently lost.
 * `startPanelServer` therefore refuses to start when the path holds something
 * that is not a socket.
 *
 * A named pipe has no filesystem entry at all: nothing to stat, nothing to
 * unlink, nothing to chmod. Every one of those three steps is gated on the
 * endpoint spelling *and* the platform, via `isPanelNamedPipe` — the same
 * function the startup check reads, so “is this a pipe” has one answer in this
 * codebase rather than one per call site.
 *
 * ## A connection is not a panel until it says so
 *
 * Accepting a connection and having a reader on the other end are different
 * facts, and on Windows they are routinely not the same one. There the panel's
 * write direction opens a fresh connection **per line** — it has to, see
 * `ui/src/transport.rs` — and that connection is write-only and closed by the
 * end of the call. A server that counted every accepted connection as a panel
 * would push standing state into it and get `EPIPE`, once per click, and worse:
 * the replay makes the panel pull its dumps, each pull is another connection,
 * each connection another replay. Measured on Windows as a console filling with
 * `Panel client dropped: EPIPE` at 2 → 4 → 8.
 *
 * So a connection joins the broadcast set only when it sends `subscribe`, and
 * `onSubscribe` fires there rather than at `open`. A command connection never
 * subscribes and is therefore never written to; the supervisor's liveness probe,
 * which connects and drops, is silent for the same reason. Unix reaches the same
 * place by the same route — its one duplex socket subscribes once and then both
 * sends and receives — so the rule is the protocol's, not a platform branch.
 *
 * ## A dead panel must not take down the watch session
 *
 * The panel is an observer of a session that has real work to do. Every failure
 * here — a client that vanished mid-write, a line that will not parse, a
 * connection that floods the buffer — costs that one client and produces a
 * diagnostic. None of them throw into the session.
 *
 * ## Stream framing
 *
 * The transport delivers bytes, not lines. A single JSON object routinely arrives in two
 * chunks, so each connection carries its own buffer and lines are cut on `\n`.
 * The buffer is bounded: a client that sends megabytes with no newline is
 * dropped rather than allowed to grow the process without limit.
 */

export interface PanelServer {
  /** Sends to every connected panel. A write failure drops that client only. */
  broadcast(message: PanelMessage): void;
  readonly clientCount: number;
  close(): Promise<void>;
}

export interface PanelServerOptions {
  readonly socketPath: string;
  readonly onControl: (op: "pause" | "resume") => void;
  readonly onServiceControl?: (op: "restart") => void;
  readonly onAnswer?: (promptId: number, answer: "approved" | "declined") => void;
  readonly onConfigGet?: () => void;
  readonly onConfigSet?: (id: string, value: string) => void;
  readonly onSourceGet?: () => void;
  readonly onSourceToggle?: (id: string, on: boolean) => void;
  readonly onDiagnostic?: (line: string) => void;
  /**
   * Runs once per newly *subscribed* client, after it can receive broadcasts.
   * Standing state the panel must know from its first second — the `service`
   * line — is replayed here, not broadcast once at startup: broadcast reaches
   * only whoever is registered at that instant, and a panel connects after the
   * server starts, every time.
   *
   * Keyed to `subscribe` rather than to accepting a connection, because those
   * are different facts: on Windows a write-only connection arrives per outgoing
   * line and replaying into one is an `EPIPE` that provokes the next replay.
   */
  readonly onSubscribe?: (clientCount: number) => void;
}

/** Wire-illegal characters in a config_set field; the panel never sends them. */
const HAS_CONTROL_CHAR = /[\u0000-\u001F\u007F]/;

/**
 * Per-connection line-buffer ceiling. A panel's largest legal message is a
 * world-state line bounded by the audit-text cap, so anything approaching this
 * is not a slow line — it is a client with no newline in sight.
 */
const MAX_LINE_BYTES = 64 * 1024;

interface Client {
  readonly socket: Socket<undefined>;
  /** Bytes received since the last newline, awaiting a complete line. */
  buffer: string;
  /** Frames still owed to a socket that applied backpressure. */
  outbound: string;
  /** Set once the client is gone, so a queued drain does not resurrect it. */
  dropped: boolean;
  /**
   * Whether this connection asked to receive broadcasts. Only a subscriber is in
   * `clients`; a connection that only ever writes is tracked here and never
   * written to.
   */
  subscribed: boolean;
}

export async function startPanelServer(options: PanelServerOptions): Promise<PanelServer> {
  const { socketPath, onControl, onServiceControl, onAnswer, onConfigGet, onConfigSet, onSourceGet, onSourceToggle, onDiagnostic, onSubscribe } = options;
  const diagnostic = (line: string): void => {
    onDiagnostic?.(line);
  };

  // The spelling decides, not `process.platform`: it is what Bun itself reads to
  // choose a transport, so a value that is a pipe here is a pipe there.
  const isNamedPipe = isPanelNamedPipe(socketPath);
  if (!isNamedPipe) clearBindPath(socketPath);

  const clients = new Set<Client>();
  const clientOf = new WeakMap<Socket<undefined>, Client>();

  /**
   * Ends one connection and says why — but only for a connection that had
   * declared itself a panel.
   *
   * An unsubscribed connection ending is the ordinary shape of a Windows
   * command write and of the supervisor's liveness probe: both connect, do their
   * one thing, and close. Announcing those would report normal traffic as a
   * failure, at exactly the rate the user clicks.
   */
  const drop = (client: Client, reason: string): void => {
    if (client.dropped) return;
    client.dropped = true;
    clients.delete(client);
    if (client.subscribed) diagnostic(`Panel client dropped: ${reason}`);
    try {
      client.socket.end();
    } catch (error) {
      // The socket was already gone, which is the usual reason we are here.
      if (client.subscribed) {
        diagnostic(`Panel client close failed: ${describeErrorForAudit(error)}`);
      }
    }
  };

  /**
   * Writes as much of a client's outbound text as the socket accepts and keeps
   * the rest for `drain`. Bun's `write` returns a short count under
   * backpressure — measured at ~214KB per write — so a caller that ignores the
   * return value silently truncates a line and desynchronizes the framing.
   */
  const flush = (client: Client): void => {
    if (client.dropped || client.outbound.length === 0) return;
    let written: number;
    try {
      written = client.socket.write(client.outbound);
    } catch (error) {
      drop(client, describeErrorForAudit(error));
      return;
    }
    if (written < 0) {
      // Measured: a closed socket returns -1 rather than throwing.
      drop(client, "socket closed");
      return;
    }
    client.outbound = client.outbound.slice(written);
  };

  const handleLine = (client: Client, line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Dropped, not guessed at: a half-understood control op would toggle
      // capture on a coin flip.
      diagnostic("Panel line refused: not JSON.");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      diagnostic("Panel line refused: not a JSON object.");
      return;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type === "subscribe") {
      // The one message that changes what this connection *is*. Idempotent: a
      // second subscribe on a live connection would otherwise replay standing
      // state and, since the panel answers `service` by pulling its dumps,
      // invite the client to ask again forever.
      if (client.subscribed) {
        diagnostic("Panel subscribe ignored: this connection is already subscribed.");
        return;
      }
      client.subscribed = true;
      clients.add(client);
      // Registered first, then announced: the hook exists so standing state can
      // be replayed to the one client that just arrived, and a broadcast inside
      // it must reach that client.
      onSubscribe?.(clients.size);
      return;
    }
    if (record.type === "control") {
      const op = record.op;
      if (op === "restart") {
        if (onServiceControl === undefined) {
          diagnostic("Panel control refused: no service-control handler is wired.");
          return;
        }
        onServiceControl(op);
        return;
      }
      if (op !== "pause" && op !== "resume") {
        diagnostic("Panel control refused: op must be exactly pause, resume, or restart.");
        return;
      }
      onControl(op);
      return;
    }
    if (record.type === "config_get") {
      if (onConfigGet === undefined) {
        diagnostic("Panel config_get refused: no config handler is wired.");
        return;
      }
      onConfigGet();
      return;
    }
    if (record.type === "config_set") {
      const { id, value } = record;
      if (typeof id !== "string" || id.length === 0) {
        diagnostic("Panel config_set refused: id must be a non-empty string.");
        return;
      }
      if (typeof value !== "string") {
        diagnostic(`Panel config_set refused: value for "${id}" must be a string.`);
        return;
      }
      // The wire bans raw control characters outright; refusing here keeps the
      // handler's job semantic-only. Diagnostics name the key, never the value —
      // that value could be the API key's one trip across this socket.
      if (HAS_CONTROL_CHAR.test(id) || HAS_CONTROL_CHAR.test(value)) {
        diagnostic(`Panel config_set refused: value for "${id}" holds a control character.`);
        return;
      }
      if (onConfigSet === undefined) {
        diagnostic("Panel config_set refused: no config handler is wired.");
        return;
      }
      onConfigSet(id, value);
      return;
    }
    if (record.type === "source_get") {
      if (onSourceGet === undefined) {
        diagnostic("Panel source_get refused: no source handler is wired.");
        return;
      }
      onSourceGet();
      return;
    }
    if (record.type === "source_toggle") {
      const { id, on } = record;
      if (typeof id !== "string" || id.length === 0) {
        diagnostic("Panel source_toggle refused: id must be a non-empty string.");
        return;
      }
      // Booleans ride as 1|0 per the flat-wire rule; a string "1" or a truthy
      // cast would let a malformed line flip a source the panel never meant to.
      if (on !== 0 && on !== 1) {
        diagnostic(`Panel source_toggle refused: on for "${id}" must be 0 or 1.`);
        return;
      }
      // The same control-character ban config_set enforces: a dirty id never
      // reaches a handler, let alone a log line.
      if (HAS_CONTROL_CHAR.test(id)) {
        // The id is not quoted here: it holds the control byte, and a
        // diagnostic that echoes it would smuggle the byte into the log.
        diagnostic("Panel source_toggle refused: id holds a control character.");
        return;
      }
      if (onSourceToggle === undefined) {
        diagnostic("Panel source_toggle refused: no source handler is wired.");
        return;
      }
      onSourceToggle(id, on === 1);
      return;
    }
    if (record.type === "answer") {
      const { promptId, answer } = record;
      // Integer only, matching the protocol: a rounded correlation id would
      // answer a different prompt than the one the user looked at.
      if (typeof promptId !== "number" || !Number.isSafeInteger(promptId)) {
        diagnostic("Panel answer refused: promptId must be an integer.");
        return;
      }
      if (answer !== "approved" && answer !== "declined") {
        diagnostic("Panel answer refused: answer must be exactly approved or declined.");
        return;
      }
      if (onAnswer === undefined) {
        diagnostic("Panel answer refused: no confirmation handler is wired.");
        return;
      }
      onAnswer(promptId, answer);
      return;
    }
    diagnostic("Panel line refused: unrecognized type.");
  };

  const socketHandlers = {
    open: (socket: Socket<undefined>) => {
      // Tracked so its bytes can be framed, but deliberately *not* added to
      // `clients`: whether there is a reader behind this connection is not known
      // yet, and on Windows the answer is usually no. `subscribe` is what moves
      // it into the broadcast set.
      const client: Client = {
        socket,
        buffer: "",
        outbound: "",
        dropped: false,
        subscribed: false,
      };
      clientOf.set(socket, client);
    },
    data: (socket: Socket<undefined>, chunk: Uint8Array) => {
      const client = clientOf.get(socket);
      if (client === undefined || client.dropped) return;
      client.buffer += chunk.toString();
      // Bound first, then split: a client that never sends a newline must be
      // dropped rather than allowed to grow this string without limit.
      if (client.buffer.length > MAX_LINE_BYTES) {
        drop(client, `line exceeded ${MAX_LINE_BYTES} bytes without a newline`);
        return;
      }
      const parts = client.buffer.split("\n");
      // The tail is whatever follows the last newline — an incomplete line,
      // possibly empty. It waits for the next chunk instead of being parsed.
      client.buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (client.dropped) return;
        handleLine(client, part);
      }
    },
    drain: (socket: Socket<undefined>) => {
      const client = clientOf.get(socket);
      if (client !== undefined) flush(client);
    },
    close: (socket: Socket<undefined>) => {
      const client = clientOf.get(socket);
      if (client === undefined || client.dropped) return;
      client.dropped = true;
      clients.delete(client);
    },
    error: (socket: Socket<undefined>, error: Error) => {
      const client = clientOf.get(socket);
      if (client !== undefined) drop(client, describeErrorForAudit(error));
    },
  };

  // One call for both transports. On Windows, Bun matches the pipe prefix and
  // binds through libuv; anything else falls through to AF_UNIX.
  const server = Bun.listen<undefined>({ unix: socketPath, socket: socketHandlers });

  // Immediately after binding, before any client could have connected. Measured
  // default is 775; the mode is the only thing standing between this socket and
  // any other user in the group.
  if (!isNamedPipe) {
    try {
      chmodSync(socketPath, 0o600);
    } catch (error) {
      // A socket we cannot restrict is worse than no panel: it would hand the
      // world state to the group. Tear down rather than serve it.
      server.stop(true);
      removeOwnSocket(socketPath);
      throw new Error(`Panel socket could not be restricted to mode 600: ${describeErrorForAudit(error)}`);
    }
  }

  let closed = false;

  return {
    broadcast: (message: PanelMessage): void => {
      // Framed once for every client: the line is identical, and re-serializing
      // per client would let two panels disagree about what was sent.
      let line: string;
      try {
        line = panelLine(message);
      } catch (error) {
        diagnostic(`Panel message refused: ${describeErrorForAudit(error)}`);
        return;
      }
      for (const client of [...clients]) {
        client.outbound += line;
        flush(client);
      }
    },
    get clientCount(): number {
      return clients.size;
    },
    close: async (): Promise<void> => {
      // Idempotent: a session may close on its own path and again in a teardown
      // handler, and the second call must not unlink a socket a later server
      // has since bound at the same path.
      if (closed) return;
      closed = true;
      for (const client of [...clients]) {
        client.dropped = true;
        clients.delete(client);
        try {
          client.socket.end();
        } catch {
          // Already gone; nothing to release.
        }
      }
      // `true` closes live connections. Without it a panel holding the socket
      // keeps the listener's handles alive and the process will not exit.
      server.stop(true);
      // Measured: `stop()` does not remove the Unix socket file. Leaving it
      // behind makes the next run look like a server is already listening.
      if (!isNamedPipe) removeOwnSocket(socketPath);
      await Promise.resolve();
    },
  };
}

/**
 * Clears the bind path of a stale socket, refusing outright if what sits there
 * is not one.
 *
 * Measured, and the reason this is not a bare unlink: `Bun.listen({ unix })`
 * binds over a **regular file** and destroys its contents without an error. So a
 * mistyped `SQUID_PANEL_SOCKET` naming real data would be silently overwritten
 * whether or not we unlinked it first. The only safe posture is to refuse the
 * bind, which also means the refusal names the path instead of the user
 * discovering the loss later.
 */
function clearBindPath(socketPath: string): void {
  if (!existsSync(socketPath)) return;
  let isSocket: boolean;
  try {
    isSocket = statSync(socketPath).isSocket();
  } catch {
    // Raced with something removing it. Let the bind report the real problem.
    return;
  }
  if (!isSocket) {
    throw new Error(
      `Panel socket path already exists and is not a socket: ${socketPath}. `
      + "Binding would destroy that file, so refusing to start.",
    );
  }
  try {
    // Measured: `stop()` does not remove the socket file, so a crashed run
    // leaves one behind. Re-binding over it succeeds, but only after the unlink.
    unlinkSync(socketPath);
  } catch {
    // Raced with another process removing it; the bind below reports anything
    // that actually blocks us.
  }
}

/** Removes the socket file this server created. Never touches a non-socket. */
function removeOwnSocket(socketPath: string): void {
  try {
    if (existsSync(socketPath) && statSync(socketPath).isSocket()) {
      unlinkSync(socketPath);
    }
  } catch {
    // Already gone, or not ours to remove.
  }
}
