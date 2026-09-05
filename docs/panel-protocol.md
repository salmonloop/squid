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
- **Windows: a named pipe, `\\.\pipe\<name>`, and nothing else.** Both ends still
  say `Bun.listen({ unix })` and both still read one env variable; what changes is
  the spelling of the string and therefore the object the OS creates.
  - **The accepted spelling is Bun's, copied exactly.** Two separators, then `.`
    or `?`, a separator, the four bytes `pipe`, a separator, and at least one
    character behind it. Either separator works and both are normalized to `\`,
    so `//./pipe/squid-panel` and `\\.\pipe\squid-panel` name the same pipe — a
    user should not have to count backslash escapes through a shell, JSON, and
    PowerShell to be understood. `pipe` is matched byte-exactly: Bun's own
    detector is case-sensitive, so `\\.\PIPE\x` would fall back to AF_UNIX and
    bind a *file* by that name. Accepting a spelling Bun then interprets
    differently is the one failure this gate exists to prevent.
  - **The client is a `File`, not a socket.** `CreateFileW` on the pipe name is
    the documented way for a client in, and `std::fs::File` is the std type that
    wraps that handle. It is `Read + Write`, so the framing and the backoff
    ladder are written once for both platforms.
  - **The write direction is its own short-lived connection.** Unix parks a
    duplicated socket handle and writes past the parked reader. That does not
    hold here: `try_clone` is `DuplicateHandle`, yielding two handles to one
    *file object*, and a handle opened without `FILE_FLAG_OVERLAPPED` is a
    synchronous file object whose I/O the I/O manager serializes on that object's
    lock. The reader parked in `ReadFile` would hold it and a pause click would
    block behind it until the server next spoke — a panel frozen for exactly as
    long as the session is quiet. So the outgoing half parks the pipe's *name*
    and opens a connection per line. A refused open drops that line, the same as
    a failed write does.
  - **There is no access boundary here, and that is a known gap.** `uv_pipe_bind`
    calls `CreateNamedPipeW` with a `NULL` security descriptor, and Bun offers no
    way past it. The documented default DACL grants the creator and administrators
    full control and **grants `Everyone` and anonymous logon read access**. So any
    local user can read the world state this session pushes; only the write
    direction is theirs alone, which is why a click cannot be forged but a
    reading can be watched. This is weaker than the Unix `chmod 600` and is
    accepted deliberately at this stage — the pipe is not a substitute for the
    file mode, it is a transport that happens to leak reads.
  - `resolvePanel` refuses every other spelling on `win32`, and refuses the pipe
    spelling on every other platform — there a `\\.\pipe\x` string is just a
    filename with backslashes in it, and binding it would produce a
    group-readable socket in the working directory under a name that reads like a
    pipe.
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
  (Still unverified for named pipes, but no longer for want of a runner. Bun's own
  `test/js/bun/net/named-pipe-listen-error.test.ts` asserts a Node-shaped
  `EADDRINUSE` with `syscall === "listen"`, so the intended behaviour is clear —
  and `CreateNamedPipeW` does refuse a second *first instance* of a name. What
  blocks the measurement is the pinned Bun: before oven-sh/bun#29422 a *failed*
  named-pipe listen aborts the process instead of throwing, because the tagged
  union's tag is written before the payload and the `errdefer` cleanup then trips
  `bun.assert(this.listener == .none)`. The fix first shipped in Bun 1.3.13; the
  repo now pins 1.4.2, so the assertion runs. It lives in the Windows-only suite
  in `tests/panel-server.test.ts`, gated on that version.)
- `stop()` alone leaves connected sockets writable and their handles alive, so the
  process will not exit while a panel is attached. Close with `stop(true)`.

## Starting the panel

**The panel is the recommended entry point.** Unpack the release zip and
open `squid-ui`. When `SQUID_PANEL_SOCKET` is **unset**, that is not a missing
configuration: it means this is a panel-first run. The panel computes the
platform default endpoint, probes it for at most 1.5 seconds, and then does one
of two things:

1. **A session already answers the probe:** attach to it. The panel does not
   start a second `squid`, and it does not claim to supervise a process it did
   not start.
2. **Nothing answers:** start the sibling `squid` binary from the same directory,
   with `SQUID_PANEL_SOCKET=<computed endpoint>` and `SQUID_SUPERVISED=1`.
   The release zip deliberately puts the two binaries side by side so a
   double-click never needs a `PATH` search.

The probe is the double-start guard. It is deliberately a *connect*, rather than
trusting a bind failure: Bun's `listen({ unix })` does not reliably surface
`EADDRINUSE`, and two watch sessions pointed at one endpoint can both appear to
bind, then split panel connections unpredictably. A stale Unix socket file is
not a false positive — nothing accepts on it, so the probe fails; the brain's
own server startup clears the stale file before binding.

A supervisor starts its child with a deliberately narrow environment. It carries
only OS location/runtime variables, the optional `SQUID_CONFIG` **file locator**,
and the two supervision variables above. It does **not** carry `SQUID_WATCH_ROOT`,
`SQUID_BROWSER`, or any other business `SQUID_*` value: the config file is the
single authority for those values, and passing a parent environment through would
silently outrank the settings form. If that config file is absent, the supervised
brain writes an empty `{}` at the resolved location; CLI/manual brain launches do
not create it merely for being run. Existing files are always read first and are
never overwritten by this initialization — malformed JSON remains a startup
refusal.

A panel opened with `SQUID_PANEL_SOCKET` **set to a non-empty endpoint** is the
attached shape: it connects and renders, exactly as prior releases did. This is
how a person attaches to a session somebody else started. A value that is **set
but empty** is different from unset and is refused with exit code 2: it means a
launcher lost a value, and treating that failure as a panel-first request would
make a broken script look intentional.

The supervising panel owns only the brain it started. The brain sees
`SQUID_SUPERVISED=1`, accepts `{"type":"control","op":"restart"}`, runs its
ordinary ordered teardown, and exits **3**. The panel never signals it; exit 3
means start a replacement immediately. Exit 0 means a deliberate stop and is not
respawned. Exit 2 is a startup/configuration refusal and is terminal on the first
try. Other non-zero exits (including a signal death) retry after 250ms, doubling
to 8 seconds; three within 60 seconds stop the loop and leave the panel visible
with the reason. A restart requested by the user is not a crash and clears the
crash history.

The panel's SERVICE area shows two separate facts when it supervises: the process
state (`idle`, `running`, `restarting`, or `failed`) and the brain's own `service`
line (`ready` or `needs_config`). A process that is alive but has no configured
agent is not called healthy by implication. Attached panels show only the brain's
own state; they never guess the lifecycle of a process they did not create.

Two startup failures end the process before the event loop, each with its own code
so a launcher can tell them apart:

| Code | Meaning |
| --- | --- |
| `2` | `SQUID_PANEL_SOCKET` was set empty, or no live session and no sibling `squid` binary were found. |
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

### `service`

The brain's own standing state, announced to each panel **as it subscribes** —
not broadcast once at startup. A broadcast reaches only whoever is registered at
that instant, and a panel connects after the session starts, every time; so
standing facts are replayed per subscriber rather than shouted once into an empty
room. Keyed to `subscribe` and not to an accepted connection, for the reason in
*Panel → TS*: a Windows command write is a connection of its own, and a replay
into one is an `EPIPE` that provokes the next replay. The
Rust panel silently ignores this message until the panel-rendering phase wires
a UI for it.

```jsonc
{"type":"service","agentState":"needs_config"}
```

| field | type | required | notes |
|---|---|---|---|
| `type` | `"service"` | yes | |
| `agentState` | `"ready"` \| `"needs_config"` | yes | `needs_config` means no resident-agent model is configured; the settings form is the way out |

No user-derived text rides this line, so it carries no sanitization — the only
fields are fixed-vocabulary strings.

### `config`

One settings row per message, sent as the reply to `config_get` (a dump).
The schema rides the wire — `label`/`kind`/`values` come from the TS side's
one settings table, and so do the `group`/`description` display fields — so the
panel hardcodes no key and stays a dumb client across settings changes.

```jsonc
{"type":"config","id":"watchRoot","label":"Watch root","kind":"text","value":"/home/me","applies":"restart","overridden":1,"group":"Files","description":"The folder whose file activity Squid pays attention to."}
{"type":"config","id":"screenReader","label":"Screen reader","kind":"enum","value":"linux","applies":"restart","values":"synthetic;linux;windows","group":"Screen","description":"How Squid reads the words on your screen."}
{"type":"config","id":"apiKey","label":"API key","kind":"secret","value":"","applies":"restart","group":"Model","description":"The secret that lets Squid use that model on your behalf.","secretPresent":1}
{"type":"config_end","count":22}
```

| field | type | required | notes |
|---|---|---|---|
| `type` | `"config"` | yes | |
| `id` | string | yes | the key a `config_set` echoes back |
| `label` | string | yes | what the form shows, **sanitized** |
| `kind` | `"text"` \| `"int"` \| `"enum"` \| `"secret"` | yes | |
| `value` | string | yes | the file's value; `""` means unset. **A `secret` kind is always `""`.** |
| `applies` | `"now"` \| `"restart"` | yes | when a saved value takes effect |
| `overridden` | `0` \| `1` | no | present only when an env var is governing this run, so the file value shown is not the live one |
| `values` | string | no | `;`-joined enum choices, `enum` kind only |
| `group` | string | no | the capability this row belongs under, **sanitized** |
| `description` | string | no | one sentence on what it changes, **sanitized** |
| `secretPresent` | `0` \| `1` | no | present only when a credential is stored, `secret` kind only |

The dump shows the **file** value even when overridden: the form edits the
file, and `overridden: 1` is the disclosure that the live run disagrees.

**Grouping is metadata, not structure.** `group` is a scalar string the panel
buckets rows by; the wire never nests them. A tree here would mean teaching the
hand-written Rust parser arrays and nested objects — a second half-tested JSON
implementation — to express something a pass over flat rows already expresses.
Group names the user-facing capability ("Screen", "Pause control", "History"),
never the subsystem behind it, and there is deliberately no "Advanced": a row
that cannot be explained in one sentence is a row to reconsider offering, not to
file away. Rows of one group are **not** contiguous in dump order, so a renderer
must bucket by value rather than assume runs. Group *order* rides no field —
first appearance in the dump is the order, which puts the model rows first.

`group` and `description` are optional on the wire so a brain older than the
panel still produces a usable form: the Rust side reads them with the same
tolerant optional-text path as every other display field, and their absence
costs a heading, never the row. The same holds in reverse — the parser skips
scalar fields it does not know, which is why adding these was a wire change and
not a parser rewrite.

**The secret rule is structural, not a convention.** A credential never rides
the wire in either direction more than once: the dump reports a secret's value
as the empty string, and the only message that ever carries a real key is the
panel's `config_set` for it — which is never echoed back, never logged, and
never quoted in a diagnostic, on either side. There is no "show me the stored
key" operation at all.

`secretPresent` is the narrowest exception to that silence and is not one in
substance: it says a credential *exists*, and nothing about what it is. It
exists because the rule above hid an honest distinction — a stored key and no
key at all both render as an empty field, so the only way to tell them apart was
to save an empty value and read back either "kept" or "no API key is stored
yet", which is a probe in the one field where a mistaken save is least
recoverable. It is spelled `0`/`1` and omitted when false, exactly like
`overridden`, because it is the same kind of thing: a disclosure about the value
rather than the value.

### `config_result`

The verdict on one `config_set` — or, with `id` omitted, on a failed dump.

```jsonc
{"type":"config_result","id":"watchRoot","ok":1,"applies":"restart"}
{"type":"config_result","id":"retentionHours","ok":0,"error":"Retention (hours): must be a positive integer."}
{"type":"config_result","ok":0,"error":"The config file at … is not valid JSON: …"}
```

| field | type | required | notes |
|---|---|---|---|
| `type` | `"config_result"` | yes | |
| `id` | string | no | the key the set named; omitted for a dump-level failure |
| `ok` | `0` \| `1` | yes | |
| `applies` | `"now"` \| `"restart"` | no | present when `ok` is `1` |
| `error` | string | no | present when `ok` is `0`, **sanitized** — a filesystem refusal quoting a path must not smuggle anything onto the wire |

`applies: "now"` is possible only for a model setting saved while no agent is
running (the session starts the agent on the spot); a model setting saved while
the agent is live says `"restart"`, because Pi's session already holds the old
endpoint, and claiming otherwise would be a lie the panel renders as fact.

### `source`

One source row per message, sent as the reply to `source_get` (a dump). The
dump lists the whole catalog in declaration order — including capabilities this
run did not configure — so the panel shows the whole truth instead of hiding a
toggle the schema knows about.

```jsonc
{"type":"source","id":"filesystem-local","label":"Files","state":"running"}
{"type":"source","id":"browser-page-host","label":"Browser","state":"unsupported"}
{"type":"source_end","count":5}
```

| field | type | required | notes |
|---|---|---|---|
| `type` | `"source"` | yes | |
| `id` | string | yes | the id a `source_toggle` echoes back |
| `label` | string | yes | what the form shows, **sanitized** |
| `state` | `"running"` \| `"stopped"` \| `"unsupported"` | yes | `unsupported` = the capability exists but this run cannot start it; toggles are refused |

`count` on `source_end` tells the panel how many rows to expect — the same
sizing contract as `config_end`.

**The capture gate is not a source.** It is the pause switch, not an observer,
so it never appears in this dump and cannot be stopped by a panel. The last
running observer cannot be stopped either: a watch session with zero sources
is the exact state startup refuses, so the manager refuses it at runtime too.

### `source_result`

The verdict on one `source_toggle`.

```jsonc
{"type":"source_result","id":"browser-page-host","ok":1}
{"type":"source_result","id":"browser-page-host","ok":0,"error":"Source \"browser-page-host\" is not available in this run."}
```

| field | type | required | notes |
|---|---|---|---|
| `type` | `"source_result"` | yes | |
| `id` | string | no | the id the toggle named; omitted for a dump-level failure |
| `ok` | `0` \| `1` | yes | |
| `error` | string | no | present when `ok` is `0`, **sanitized** |

A toggle is a recipe rebuild, not a resurrection: starting a stopped source
builds a fresh instance from the catalog's `create`, because a source cannot
restart itself. Events emitted while a source drains during its stop are
delivered before the stop resolves, so nothing observed is lost.

### `prompt` / `cancel`

The confirmation area. No caller produces these today — tool-layer safety is Pi's
sandbox — and they are kept so an external confirmation can be wired later
without redesigning the transport.

```jsonc
{"type":"prompt","promptId":1,"kind":"run_tests","summary":"…","expiresAt":"2026-08-27T10:00:30.000Z"}
{"type":"prompt","promptId":2,"kind":"run_tests","summary":"bun test","expiresAt":"…","why":"The last edit touched the parser.","denyConsequence":"The change ships unverified."}
{"type":"cancel","promptId":1}
```

| field | type | required | notes |
|---|---|---|---|
| `type` | `"prompt"` | yes | |
| `promptId` | integer | yes | echoed by `answer` |
| `kind` | string | yes | |
| `summary` | string | yes | what will happen, **sanitized** |
| `expiresAt` | string | yes | after this, silence is a refusal |
| `why` | string | no | why it is being asked, **sanitized** |
| `denyConsequence` | string | no | what declining gives up, **sanitized** |

`promptId` is an integer. There is **no** `arguments` field and never will be: the
selection must not be able to reach this process at all.

`why` and `denyConsequence` exist because a dialog that states only what will
happen makes approval the cheaper answer: the user can see the command but not
what refusing costs, and "just approve it" is what that asymmetry teaches. Both
are optional and independent — a sender with a reason but no stated cost is the
ordinary case, and a consequence must never be invented to fill the field, since
the user would then be weighing a cost nobody claimed. A prompt carrying neither
is still a prompt and must still render; the panel reads both through the same
tolerant optional-text path as every other display field, so an absent
explanation costs a line of the dialog and never the ability to answer.

## Panel → TS

```jsonc
{"type":"subscribe"}
{"type":"control","op":"pause"}
{"type":"control","op":"resume"}
{"type":"control","op":"restart"}
{"type":"config_get"}
{"type":"config_set","id":"watchRoot","value":"/home/me"}
{"type":"source_get"}
{"type":"source_toggle","id":"browser-page-host","on":0}
{"type":"answer","promptId":1,"answer":"approved"}
```

`op` is exactly `pause`, `resume`, or `restart`. `answer` is exactly `approved`
or `declined`. An unrecognized value is dropped, not guessed at.

**`subscribe` is the first line a reading connection sends, and the server writes
nothing to a connection that has not sent it.** Accepting a connection and having
a reader behind it are different facts, and on Windows they are usually not the
same one: the write direction opens a connection *per line*, write-only, closed by
the end of the call. A server that replayed standing state at accept would write
into those and get `EPIPE` per click — and because the panel answers `service` by
pulling its two dumps, each `EPIPE` provokes two more connections. Measured on
Windows as a console filling with `Panel client dropped: EPIPE` at 2 → 4 → 8.

So the rule is the protocol's rather than a platform branch:

- The **reading** connection sends `subscribe` immediately after connecting, and
  sends it **on that connection**, never through the outgoing half — on Windows
  the outgoing half is a different connection that is already closing.
- A **command** connection never subscribes, is never written to, and its close is
  not a dropped panel. The supervisor's liveness probe is silent for the same
  reason: it connects, does not subscribe, and leaves.
- A second `subscribe` on a live connection is ignored with a diagnostic.
  Replaying standing state again would make the panel pull its dumps again, which
  is the same loop by a shorter route.
- Unix arrives at the same place by the same route: its one duplex socket
  subscribes once, then both reads and writes.

`onSubscribe` — not "on connect" — is where the server replays `service`.

**Pause and resume do not change capture state directly.** They append the
corresponding line to the existing capture-gate command path
(`SQUID_CONTROL_FIFO`), which `capture-gate-reader-fifo.ts` already reads. That
keeps one control path rather than two, and it means a pause still produces a
`capture_gate_changed` event in the timeline — the trace that distinguishes a
deliberate gap from an idle machine. A panel that mutated state directly would
lose that distinction.

**`config_get`** asks for a full settings dump: one `config` line per key, then
`config_end` with the count. The dump re-reads the config file on every call —
a set that landed mid-run is visible to the next get.

**`config_set`** writes one key's value. `id` is a non-empty string with no
control characters; `value` is a string with none either. The transport
validates only that shape — diagnostics name the key and never quote the
value, because the one `config_set` that carries a real API key must not be
able to echo it back through an error line. Everything semantic (which store,
which rules, what applies when) lives in the TS settings service.

The server's reply is exactly one `config_result` per set. A form with five
edits sends five messages and sees five verdicts, so every refusal is
attributable to the field being edited.

**`source_get`** asks for the source catalog dump: one `source` line per entry,
then `source_end` with the count.

**`source_toggle`** starts (`on: 1`) or stops (`on: 0`) one source. `id` is a
non-empty string with no control characters and `on` is exactly `0` or `1` —
a string `"1"` or a truthy cast is refused, because a malformed line must not
flip a source the panel never meant to flip. The server replies with exactly
one `source_result` per toggle. Toggles on one source are serialized in arrival
order, so a start and a stop cannot interleave; distinct sources are
independent. Starting an already-running source and stopping one that is not
running are honest refusals, not silent no-ops.

## Restart and the process contract

A `control` op of `restart` asks the brain to stop cleanly and be respawned
with the configuration as it now stands. It is **refused unless the run is
supervised** (`SQUID_SUPERVISED=1`): the supervisor is what respawns, and an
unsupervised exit would just be a crash to whoever started the process by
hand. The refusal is a diagnostic, not silence — and the panel learns nothing
from the silence either way, which is why the diagnostic is logged on the
brain's own error stream in this phase.

Exit codes a launcher can tell apart:

| Code | Meaning |
| --- | --- |
| `0` | clean shutdown (signal handler) |
| `1` | shutdown error |
| `2` | startup refused — a config error, terminal, not worth respawning |
| `3` | stopped cleanly at a supervisor's request — respawn with the new configuration |

The split matters: a supervisor that respawned a config error would crash-loop
on a typo, and one that did not respawn a restart would strand the user's
panel on a dead endpoint.

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
export type PanelMessage =
  | PanelWorldState
  | PanelAgentLine
  | PanelServiceLine
  | PanelConfigLine
  | PanelConfigEnd
  | PanelConfigResult
  | PanelSourceLine
  | PanelSourceEnd
  | PanelSourceResult;
export interface PanelServiceLine {
  readonly type: "service";
  readonly agentState: "ready" | "needs_config";
}
export interface PanelConfigLine {
  readonly type: "config";
  readonly id: string;
  readonly label: string;
  readonly kind: "text" | "int" | "enum" | "secret";
  readonly value: string;          // secret kind is always ""
  readonly applies: "now" | "restart";
  readonly overridden?: 0 | 1;     // present only when true
  readonly values?: string;        // ";"-joined, enum only
  readonly group?: string;         // capability heading, sanitized
  readonly description?: string;   // one sentence, sanitized
  readonly secretPresent?: 0 | 1;  // present only when true, secret kind only
}
export interface PanelConfigEnd {
  readonly type: "config_end";
  readonly count: number;
}
export interface PanelConfigResult {
  readonly type: "config_result";
  readonly id?: string;
  readonly ok: 0 | 1;
  readonly applies?: "now" | "restart";
  readonly error?: string;
}
export interface PanelSourceLine {
  readonly type: "source";
  readonly id: string;
  readonly label: string;
  readonly state: "running" | "stopped" | "unsupported";
}
export interface PanelSourceEnd {
  readonly type: "source_end";
  readonly count: number;
}
export interface PanelSourceResult {
  readonly type: "source_result";
  readonly id?: string;
  readonly ok: 0 | 1;
  readonly error?: string;
}
/** Absent fields are omitted from the object, never set to null/undefined keys. */
export function panelWorldState(state: WorldState): PanelWorldState | null;
export function panelAgentLine(input: {
  readonly status: "replied" | "failed";
  readonly text?: string;
  readonly at?: string;
}): PanelAgentLine;
/** The brain's standing state, replayed to each panel on connect. */
export function panelServiceLine(input: {
  readonly agentState: "ready" | "needs_config";
}): PanelServiceLine;
/** One settings row; sanitizes id/label/value, omits overridden when false. */
export function panelConfigLine(entry: {
  readonly id: string;
  readonly label: string;
  readonly kind: "text" | "int" | "enum" | "secret";
  readonly value: string;
  readonly applies: "now" | "restart";
  readonly overridden: boolean;
  readonly values?: readonly string[];
}): PanelConfigLine;
export function panelConfigEnd(count: number): PanelConfigEnd;
/** One set's verdict; id omitted means the dump itself failed. */
export function panelConfigResult(result: {
  readonly id?: string;
  readonly ok: boolean;
  readonly applies?: "now" | "restart";
  readonly error?: string;
}): PanelConfigResult;
/** One catalog row; sanitizes id and label like every wire string. */
export function panelSourceLine(entry: {
  readonly id: string;
  readonly label: string;
  readonly state: "running" | "stopped" | "unsupported";
}): PanelSourceLine;
export function panelSourceEnd(count: number): PanelSourceEnd;
/** One toggle's verdict; id omitted means the dump itself failed. */
export function panelSourceResult(result: {
  readonly id?: string;
  readonly ok: boolean;
  readonly error?: string;
}): PanelSourceResult;
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
  readonly onServiceControl?: (op: "restart") => void;
  readonly onAnswer?: (promptId: number, answer: "approved" | "declined") => void;
  readonly onConfigGet?: () => void;
  readonly onConfigSet?: (id: string, value: string) => void;
  readonly onDiagnostic?: (line: string) => void;
  /** Runs once per newly subscribed client, after it can receive broadcasts. */
  readonly onSubscribe?: (clientCount: number) => void;
}): Promise<PanelServer>;

// src/config-schema.ts — the one table of file-backed settings, and the
// closed vocabulary the form groups them by. "Advanced" is not in it: a row
// that needs no explanation does not need a group to hide under.
export type ConfigGroup =
  | "Model" | "Files" | "Screen" | "Browser" | "Terminal"
  | "Editor saves" | "Pause control" | "History" | "Privacy";

// src/config-service.ts — the semantics between the panel and the stores.
// File-backed keys go to the Squid config file; the three model keys go to
// Pi's own models.json/auth.json. The secret's value never leaves a set.
export interface ConfigDumpEntry {
  readonly id: string;
  readonly label: string;
  readonly group: ConfigGroup;    // required here; optional on the wire
  readonly description: string;   // required here; optional on the wire
  readonly kind: "text" | "int" | "enum" | "secret";
  readonly value: string;
  readonly applies: "now" | "restart";
  readonly overridden: boolean;
  readonly values?: readonly string[];
  readonly secretPresent?: boolean;  // secret kind only, and only when stored
}
export interface ConfigServiceOptions {
  readonly configPath: string | undefined;
  readonly env: Record<string, string | undefined>;
  readonly agentDir: string;
  readonly provider: string;
  readonly defaultModelId: string;
  readonly defaultBaseUrl: string;
  readonly agentLive: () => boolean;
}
export const MODEL_CONFIG_KEYS: readonly {
  readonly id: "modelBaseUrl" | "modelId" | "apiKey";
  readonly label: string;
  readonly group: ConfigGroup;
  readonly description: string;
  readonly kind: "text" | "secret";
}[];
export function isModelConfigKey(id: string): boolean;
export function configDumpEntries(options: ConfigServiceOptions):
  | { readonly ok: true; readonly entries: readonly ConfigDumpEntry[] }
  | { readonly ok: false; readonly error: string };
export function applyConfigSet(options: ConfigServiceOptions, id: string, value: string):
  | { readonly ok: true; readonly applies: "now" | "restart" }
  | { readonly ok: false; readonly error: string };

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
    Service { agent_state: String },
    Config(ConfigLine),
    ConfigEnd { count: i64 },
    ConfigResult(ConfigResultLine),
    Source(SourceLine),
    SourceEnd { count: i64 },
    SourceResult(SourceResultLine),
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
pub struct ConfigLine {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub value: String,
    pub applies: String,
    pub overridden: Option<i64>,
    pub values: Option<String>,
}
pub struct ConfigResultLine {
    pub id: Option<String>,
    pub ok: i64,
    pub applies: Option<String>,
    pub error: Option<String>,
}
pub struct SourceLine {
    pub id: String,
    pub label: String,
    pub state: String,
}
pub struct SourceResultLine {
    pub id: Option<String>,
    pub ok: i64,
    pub error: Option<String>,
}
pub fn parse_incoming(line: &str) -> Option<Incoming>;
pub fn subscribe_line() -> String;            // {"type":"subscribe"}
pub fn control_line(op: Control) -> String;   // {"type":"control","op":"pause"}
pub fn answer_line(prompt_id: i64, answer: Answer) -> String;
pub fn config_get_line() -> String;           // {"type":"config_get"}
pub fn config_set_line(id: &str, value: &str) -> String;
pub fn source_get_line() -> String;           // {"type":"source_get"}
pub fn source_toggle_line(id: &str, on: bool) -> String;
pub enum Control { Pause, Resume, Restart }
pub enum Answer { Approved, Declined }
```

Three rules the Rust half holds to that are not visible in the signatures:

* **`ok` is read strictly, display fields leniently.** `flag_field` accepts only
  `1` or `0` for `ok`, and a line carrying anything else is dropped — there is no
  third verdict to map a stray number onto, and mapping it would make the panel
  state an outcome the session never claimed. `overridden`, by contrast, is a
  disclosure: a malformed value reads as "not overridden" rather than costing the
  user the whole row.
* **Outgoing values are escaped, never filtered.** `config_set_line` is the first
  line the panel writes that carries text a person typed, so it escapes quotes,
  backslashes, and control characters per JSON. It does not *reject* anything: the
  session re-validates every value, and a panel-side refusal would be a second
  validator to drift from the one that writes the file. A control character
  therefore arrives as `\u0001` and comes back as a refusal naming the key, which
  the user can see — better than a silent cleanup that changes what was saved.
* **Dumps are pulled, and pulled again.** The session replays `service` to every
  client on connect but does not push the two lists, so the panel asks for both on
  hearing it. Every verdict that names an `id` triggers a fresh `config_get` or
  `source_get`: a `config_set` can change `overridden`, and a toggle's verdict says
  only whether it landed, never what the catalog now looks like. A dump-level
  refusal carries no `id` and so does not re-ask — otherwise it would answer itself
  forever. Rows are buffered until the `*_end` line and swapped in whole, and the
  `count` is compared against what arrived: the parser drops a row it cannot read,
  and a missing setting that looked like a setting which does not exist would be
  silence reading as an answer.

## Version 2 (nested UI protocol)

A subscriber may negotiate V2 with `{"type":"subscribe","protocolVersion":2}`. Omitting
`protocolVersion` remains V1. The server tracks the selected version per connection:
legacy subscribers receive the flat messages documented above, while V2 subscribers receive a
nested `snapshot` immediately followed by nested `event` envelopes for ordinary broadcasts.

```jsonc
{"type":"snapshot","protocolVersion":2,"state":{"connection":{"status":"connected"},
 "session":{},"activity":{},"sources":[],"config":[],"prompts":[]}}
```

An event has `{ "type":"event", "protocolVersion":2, "event": { "type": "world_state",
"data": { ... } } }`. The projection is display-safe: every string is sanitized; raw selections,
arguments, and secret values are never present. V2 config entries may carry `group`, `description`,
and `secretPresent` (without a secret value). Source entries may carry a plain-language `reason`
and a non-secret `repair` configuration descriptor. Prompt records may carry `why` and
`denyConsequence`. The current session does not expose every V2 fact, so absent information is
omitted rather than fabricated.

All control messages may include a non-empty string `requestId`; handlers propagate it to
config/source result messages when they have a result. This lets V2 consumers correlate concurrent
commands. Malformed or unwired commands remain diagnostics; integrations that can return a result
should send a failed correlated result instead of reporting only to stderr.
