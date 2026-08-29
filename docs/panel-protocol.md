# Panel wire protocol

The contract between the watch session (TypeScript, server) and the control panel
(Rust + Slint, client). Written down because both sides are implemented
independently against it, and a protocol that lives only in two implementations is
a protocol that has already diverged.

## Transport

TS listens, the panel connects and retries — so the panel can start before or
after the watch session, and a restart of either reconnects rather than requiring
a restart of the other.

The endpoint comes from `SQUID_PANEL_SOCKET`. **Off by default**, like every
capability variable: opening a panel declares that this run can be observed and
controlled. The spelling names the transport, and each platform accepts exactly
one:

- **Unix: a filesystem socket path** (absolute). The server unlinks a stale
  socket file before binding (`stop()` does not remove it) and unlinks again on
  close.
  - **The server must refuse to start when the path exists and is not a socket.**
    Measured: `Bun.listen({ unix })` binds over a regular file, destroys its
    contents, and reports no error. Unlinking first does not help — the overwrite
    happens either way. So a mistyped `SQUID_PANEL_SOCKET` naming real data must
    fail loudly rather than eat the file.
  - **The server must `chmod 600` the socket immediately after binding.**
    Measured default is `775`, which lets any user in the group connect. The file
    mode is the access boundary; there is no other authentication.
  - Socket paths are limited to roughly 108 bytes by `sun_path`; a longer one
    fails as an ordinary bind error.
- **Windows: `tcp://127.0.0.1:<port>`, and nothing else.** `std::os::unix` does
  not exist there, so the Rust panel builds a `TcpStream` against a loopback
  endpoint and the TS side binds the same spelling. Loopback only is the
  boundary: there is no file mode to chmod, and the control wire is
  unauthenticated, so a general host would turn the panel into a network
  service. `resolvePanel` refuses every other spelling on `win32`, and refuses
  the `tcp://` spelling on every other platform — the two ends pick their
  transport from the same string, so letting either guess would let them
  disagree.
- Both directions: **one JSON object per line**, `\n`-terminated, UTF-8.
- **A writer must honour short writes.** Measured: `socket.write()` accepts about
  214 KB per call under backpressure and returns the count actually taken, or `-1`
  on a closed socket — it does not throw. A broadcast that ignored the return value
  would truncate a line mid-JSON and desynchronize framing for the rest of that
  connection, which is far worse than dropping the message. Keep a per-client
  remainder and finish it on `drain`.
- **Bun does not report `EADDRINUSE` for a live listener on the same path.** Two
  watch sessions pointed at one socket path both appear to bind and split
  connections unpredictably. Not enforced today; worth knowing before running two.
  (TCP does refuse a second bind at the same loopback endpoint; the TCP tests
  assert it.)
- `stop()` alone leaves connected sockets writable and their handles alive, so the
  process will not exit while a panel is attached. Close with `stop(true)`.

## Starting the panel

Because the endpoint is off by default, the panel with no `SQUID_PANEL_SOCKET`
has nothing to render and no session to control. It says so and exits `2` rather
than opening a window: a panel that is up but attached to nothing looks like a
watch session that has stopped reporting, and the shape rules below exist to keep
this surface from telling that kind of lie.

Two startup failures therefore end the process before the event loop, each with
its own code so a launcher can tell them apart:

| Code | Meaning |
| --- | --- |
| `2` | `SQUID_PANEL_SOCKET` is unset — no endpoint to connect to. |
| `3` | The window could not be created — no display, or no OpenGL for femtovg. |

Both print the reason to stderr. On Windows they also raise a message box, but
only when `GetConsoleProcessList` reports this process alone in its console —
that is the double-clicked case, where the console dies with the process and
stderr dies with it. Launched from a shell the count is at least two and stderr
is already readable; launched with no console at all it is zero, and a modal
dialog no one can dismiss would hang the process instead of reporting anything.

## Message shape rules

These are enforced by `ui/src/protocol.rs` and must not be relaxed. Each exists
because of a specific failure:

- **Flat objects only.** No nested objects, no arrays. Supporting them would grow
  a second, half-tested JSON implementation inside the panel.
- **First occurrence of a key wins.** A crafted line cannot append a second
  `"kind"` to override the one already read.
- **Trailing content after the closing brace is rejected.** Two objects on one
  line is not a message, and taking the first would let a sender smuggle a second.
- **Integers only for numeric fields** — no fractions, no exponents. `promptId` is
  a correlation id, and a rounded id would answer the wrong question.
- **Raw control characters are illegal.** A lone surrogate is refused rather than
  replaced with U+FFFD: this text goes on screen next to what the machine
  observed, and a silent replacement would be a small lie about what was sent.
- **Absent fields are omitted, never sent as `null`.** "No foreground application
  has been observed yet" is a real state, and the panel renders it as `—`. A
  `null` would make the whole line unparseable on the Rust side.

## TS → panel

### `world_state`

Pushed after each observation that changed the projection.

```jsonc
{"type":"world_state","updatedAt":"2026-08-27T10:00:00.000Z","lastEvent":"file_saved",
 "application":"Code","window":"main.ts","gate":"open","selectionLength":42,
 "recentActions":"copy;file_saved","episodeEvents":17}
```

| field | type | required | notes |
|---|---|---|---|
| `type` | `"world_state"` | yes | |
| `updatedAt` | string | yes | ISO instant from the projection |
| `lastEvent` | string | no | activity kind |
| `application` | string | no | foreground application **name** |
| `window` | string | no | **sanitized** window title |
| `gate` | `"open"` \| `"paused"` | no | absent until a gate event is seen |
| `selectionLength` | integer | no | **length only, never the text** |
| `recentActions` | string | no | `;`-joined `kind` values, newest last |
| `episodeEvents` | integer | no | event count in the current episode |

`recentActions` is a joined string rather than an array specifically to keep the
parser flat. Do not "improve" this into a JSON array.

### `agent`

Pushed when the agent finishes a turn.

```jsonc
{"type":"agent","at":"2026-08-27T10:00:01.000Z","status":"replied","text":"ran the tests; they pass"}
```

| field | type | required | notes |
|---|---|---|---|
| `type` | `"agent"` | yes | |
| `at` | string | yes | ISO instant |
| `status` | `"replied"` \| `"failed"` | yes | |
| `text` | string | no | **sanitized** assistant text or error |

### `prompt` / `cancel`

The confirmation area. No caller produces these today — tool-layer safety is Pi's
sandbox — and they are kept so an external confirmation can be wired later
without redesigning the transport.

```jsonc
{"type":"prompt","promptId":1,"kind":"run_tests","summary":"…","expiresAt":"2026-08-27T10:00:30.000Z"}
{"type":"cancel","promptId":1}
```

`promptId` is an integer. There is **no** `arguments` field and never will be: the
selection must not be able to reach this process at all.

## Panel → TS

```jsonc
{"type":"control","op":"pause"}
{"type":"control","op":"resume"}
{"type":"answer","promptId":1,"answer":"approved"}
```

`op` is exactly `pause` or `resume`. `answer` is exactly `approved` or `declined`.
An unrecognized value is dropped, not guessed at.

**Pause and resume do not change capture state directly.** They append the
corresponding line to the existing capture-gate command path
(`SQUID_CONTROL_FIFO`), which `capture-gate-reader-fifo.ts` already reads. That
keeps one control path rather than two, and it means a pause still produces a
`capture_gate_changed` event in the timeline — the trace that distinguishes a
deliberate gap from an idle machine. A panel that mutated state directly would
lose that distinction.

## Privacy boundary

Every field the panel displays has already passed through the TS side's
sanitizers, because what the panel shows is what the sensors just read.

- **`textContext.selection` never crosses this wire.** Only
  `sanitizeAuditText(selection, "selection").originalLength` does. The selection
  is the one piece of text that needs explicit consent to leave the machine.
- **Window titles go through `sanitizeAuditText(title, "diagnostic")`** — a title
  can hold a credential.
- **Agent text goes through `sanitizeAuditText(text, "rationale")`.**
- Read the **projection** (`ingest.state`), never `event.payload`: the projection
  is built from the captured event, so anything the capture policy redacted stays
  redacted. An application excluded by `SQUID_EXCLUDE` never reaches history and
  so can never reach the panel.

## Module contract (TypeScript)

Implemented independently, so the signatures are fixed here.

```ts
// src/panel-view.ts — pure, no I/O
export interface PanelWorldState {
  readonly type: "world_state";
  readonly updatedAt: string;
  readonly lastEvent?: string;
  readonly application?: string;
  readonly window?: string;
  readonly gate?: "open" | "paused";
  readonly selectionLength?: number;
  readonly recentActions?: string;
  readonly episodeEvents?: number;
}
export interface PanelAgentLine {
  readonly type: "agent";
  readonly at: string;
  readonly status: "replied" | "failed";
  readonly text?: string;
}
export type PanelMessage = PanelWorldState | PanelAgentLine;
/** Absent fields are omitted from the object, never set to null/undefined keys. */
export function panelWorldState(state: WorldState): PanelWorldState | null;
export function panelAgentLine(input: {
  readonly status: "replied" | "failed";
  readonly text?: string;
  readonly at?: string;
}): PanelAgentLine;
/** One line, newline-terminated. The only sanctioned way to frame a message. */
export function panelLine(message: PanelMessage): string;

// src/resolve-panel.ts
export type PanelResolution =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly socketPath: string }
  | { readonly configError: string };
export function resolvePanel(options?: {
  readonly env?: Record<string, string | undefined>;
}): PanelResolution;

// src/panel-server.ts
export interface PanelServer {
  /** Sends to every connected panel. A write failure drops that client only. */
  broadcast(message: PanelMessage): void;
  readonly clientCount: number;
  close(): Promise<void>;
}
export function startPanelServer(options: {
  readonly socketPath: string;
  readonly onControl: (op: "pause" | "resume") => void;
  readonly onAnswer?: (promptId: number, answer: "approved" | "declined") => void;
  readonly onDiagnostic?: (line: string) => void;
}): Promise<PanelServer>;

// src/panel-control.ts
/** Appends one gate command line to the capture-gate command path. */
export function appendGateCommand(
  commandPath: string,
  op: "pause" | "resume",
): Promise<void>;
```

`panelWorldState` returns `null` when the projection has no `updatedAt` — there is
nothing to report yet, and inventing a timestamp would misdate the first
observation.

## Module contract (Rust)

```rust
// ui/src/protocol.rs
pub enum Incoming {
    WorldState(WorldState),
    Agent(AgentLine),
    Prompt(Prompt),
    Cancel { prompt_id: i64 },
}
pub struct WorldState {
    pub updated_at: String,
    pub last_event: Option<String>,
    pub application: Option<String>,
    pub window: Option<String>,
    pub gate: Option<String>,
    pub selection_length: Option<i64>,
    pub recent_actions: Option<String>,
    pub episode_events: Option<i64>,
}
pub struct AgentLine {
    pub at: String,
    pub status: String,
    pub text: Option<String>,
}
pub fn parse_incoming(line: &str) -> Option<Incoming>;
pub fn control_line(op: Control) -> String;   // {"type":"control","op":"pause"}
pub fn answer_line(prompt_id: i64, answer: Answer) -> String;
pub enum Control { Pause, Resume }
pub enum Answer { Approved, Declined }
```
