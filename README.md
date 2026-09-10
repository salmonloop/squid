# Squid

Squid is a desktop assistant prototype built around the Pi agent runtime. It watches
what happens on the machine, projects it into a world state, and hands that state to
one long-lived agent that decides for itself what to do.

```text
activity event -> append-only store -> episode-scoped world state -> resident agent
```

The agent is the subject, not a service Squid calls. Squid owns the senses — capture,
history, projection — and the agent owns the judgement and the acting. What the agent
may reach is governed by Pi's sandbox, which is why there is no tool registry, no
admission rule engine, and no confirmation surface in this repository.

The store and the projection work with no model at all, so capture and replay stay
testable offline. Everything except the agent's own turns runs without one.

## Requirements

- Bun `1.4.2` or later
- A configured Pi model, for anything that starts a resident agent. The store, the
  projection, and the whole test suite are offline.

## Commands

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun run start
bun run dev
bun run history:delete -- /absolute/path/events.db <from> <until>
bun run watch:desktop -- /absolute/project/root
bun run watch:files -- /absolute/project/root
bun run watch:screen
```

`bun run start` is the app: it watches the home directory, computes the platform
panel endpoint, finds the panel binary — beside the executable in a release, in
`ui/target/release` from a checkout — and needs no environment. `bun run dev` is a
forty-line demo that ingests three invented events and prints the world state they
build up; it starts no sensors and no agent.

The screen backend defaults to whatever the host can actually read: UI Automation on
Windows, `xdotool` on Linux, the accessibility API on macOS. `SQUID_SCREEN_READER=synthetic`
asks for the built-in demo script by name, which is what the tests and an offline
demo want — it is deliberately no longer what an unconfigured run gets, because demo
frames presented as observations of this machine are a lie nothing downstream can
see through.

Squid speaks up wherever the host can show a notice. When a reply lands, what the
agent said also goes to the host's own notification mechanism, so a person who
closed the window still learns it spoke. `SQUID_NOTIFY=off` (or `"notify": "off"`
in the config file — the settings form's switch) declines it; `desktop` says the
default out loud. Linux speaks through `notify-send`; Windows speaks through a
`Shell_NotifyIcon` balloon shown by a Windows PowerShell helper, which needs no
installer and no AppUserModelID — the transient tray icon is its own identity, and
the toast is attributed to the messenger. A host with no backend starts quiet when
nothing was asked, and the refusals in `resolve-desktop-notice.ts` name what is
missing when `desktop` is asked for by name.

### Visual panel smoke harness

`bun run ui:smoke` runs the real release panel against an in-process fixture
speaking the production wire, waits for its window, saves PNGs, and drives its
buttons with real clicks. Build the binary first:

```bash
cargo build --release --manifest-path ui/Cargo.toml
bun run ui:smoke
# Or test a different binary:
bun run ui:smoke -- /absolute/path/to/squid-ui
```

The assertions are the test and they are platform-free; what the machine has to
provide — where a fixture can listen, how a window is found, how a control is
pressed, how the result is photographed — is a `SmokeHost`, one file per platform.
A host it has none for is refused rather than approximated.

**Linux** (`ui-smoke-host-x11.ts`) starts an isolated Xvfb and needs `Xvfb`,
`xdotool`, `xwininfo` (`x11-utils`), and `ffmpeg` — the last grabs and crops the
window from the same `xwininfo` geometry that proved it viewable. Missing commands
are detected up front with an actionable error rather than assumed present. Because
the display is private to the run, no other Squid window can exist on it.

**Windows** (`ui-smoke-host-windows.ts`) works the interactive desktop, since there
is no Xvfb equivalent a compiled winit window will draw into. It needs no measured
coordinates: controls are found by accessible name through UI Automation and clicked
at the rectangle it reports for them, which exercises the accessibility tree and
keeps hit-testing in the test in a way `InvokePattern.Invoke` would not. Sharing a
desktop costs three guards Xvfb makes unnecessary — the window is matched by process
id so a leaked window from an earlier run cannot be tested instead, every click and
screenshot raises the panel and then verifies the pixel under the cursor still
belongs to it, and the run refuses a non-interactive session outright. It also reads
the status header's own words, so the header's claims are asserted rather than left
to the screenshots.

Output goes to a unique temporary directory; every screenshot path is printed, and
the panel's own stdout and stderr land in `panel.log` beside them. The run polls for
the fixture subscription, the window, and each reply instead of sleeping; cleanup
terminates the panel, releases the host, and closes the endpoint on both success and
failure.

The run asserts three things about a confirmation: **Later** does not answer, a
deferred decision can be brought back, and a settled prompt refuses a second
answer. On Linux it drives the buttons with clicks at window-relative coordinates,
and the reason is measured rather than preferred: under a bare Xvfb there is no
window manager to give the window focus, so a synthetic `Return` is delivered to
nothing. Each coordinate asserts *which* answer it produced, so a layout change that
moves a button makes the expected answer wrong or absent instead of silently hitting
a neighbour.

Two things the harness therefore cannot claim. On Linux the header assertions the
Windows host makes now run too — the X11 host reads the panel's AT-SPI cache off
the session bus (enabled by flipping `org.a11y.Status.IsEnabled`, whose order
relative to the panel launch does not matter). What it still cannot verify is the
no-default-button rule — a `Return` that produces no answer here proves only that
no key arrived — so that rule is enforced in `ui/confirmation.slint`, where no
button is `primary` and none is given focus. And it renders in whatever colour
scheme the display reports, which under Xvfb is the light one: there is no desktop
portal to ask, and Slint 1.17 exposes no environment override, so dark mode is
verified by reading `ui/theme.slint` rather than by screenshot.

`typecheck` covers `src` and `tests` in two passes. The build config compiles only
`src`, so checking the suites needs its own config — without it a test could assert
against a type that no longer existed and still pass.

## Architecture

### Contracts and history

- `src/protocol.ts` — versioned activity contracts plus compiled runtime validation at
  every ingress boundary. `PredictionKind` survives as a *vocabulary*: a supplementary
  tool declares which kind of work it does, so the agent can tell "run the tests" from
  "look at the error". It no longer names a ranked proposal.
- `src/chronicle-ordering.ts` — canonical event identity and stable replay ordering.
- `src/event-store.ts` — the `EventStore` contract plus in-memory and JSONL append-only
  stores, including recovery diagnostics for an interrupted final JSONL record.
- `src/sqlite-event-store.ts` — append-only store on SQLite, with structural uniqueness
  on both `eventId` and source-local event identity.
- `src/episode.ts` — deterministic, time-gap-based episode projection.
- `src/world-state.ts` — deterministic, ownership-safe reducer from events to world state.
- `src/state-digest.ts` — canonical JSON over the full `WorldState` and its `sha256:`
  digest. Identical across ordered, late, and restored replays.
- `src/squid-core.ts` — serializes ingestion and state reduction. Holds the projection
  and hands out only isolated snapshots.

### The agent

- `src/resident-agent.ts` — the resident agent: one long-lived Pi session that is the
  system's subject. Owns the lifecycle shell (prompt, observe, idle, abort, dispose)
  and the system prompt. `observe(state)` updates the live sense buffer and appends a
  breadcrumb to history without triggering a turn, so an event arriving mid-turn still
  reaches the agent's view of the world.
- `src/agent-senses.ts` — the agent's eyes and ears: a pure `(WorldState, tools) ->
  string[]` rendering, injected before every LLM call. Line-oriented and labelled
  rather than a JSON dump. It reports state and nothing else — no instructions, no
  "you should" — because those belong in the system prompt.
- `src/tool-catalog.ts` — the prompt-facing view of any *supplementary* capability, as
  data. `ToolSummary` carries an id, a title, a category, the argument schema verbatim,
  and a risk class. No `render`, no `guard`: Pi's own tools are the execution surface
  and its sandbox is the safety boundary, so there is nothing here to build or police.
- `src/pi-session-factory.ts` — the shared spine of every Squid-Pi session: resolve the
  model, load resources with a system prompt, create the session, bind disposal. The
  `history` option decides where the conversation is kept, and that is not a
  convenience: **the agent's session history is the audit trail**. A durable run
  continues the most recent session for its working directory, so a restart resumes the
  agent's memory rather than waking it up amnesiac.

  Two model resolutions live here, and the distinction is load-bearing.
  `resolvePiModel` is the **default** — what a write falls back to and what
  first-run offers as a suggestion. `resolveConfiguredModel` is the **answer**:
  the id stored in Pi's `models.json` for the provider, which is what the
  settings form writes and therefore what a session must open. Conflating them
  made the form's `modelId` field save successfully and then stop the agent from
  starting, because the lookup used a default the write had just replaced. An
  explicit `modelId` still outranks both — a caller that knows which model it
  means is not second-guessed by a file.

### Capture and the watch loop

- `src/activity-source.ts` — the source contract every capture adapter implements.
- `src/capture-policy.ts` — ingress boundary for capture: `CapturePolicy`,
  `PassthroughCapturePolicy`, and `RedactingCapturePolicy`, which strips credential
  content before an event reaches the store. Capture is irreversible, so this narrows
  what is *persisted*.
- `src/capture-exclusion.ts` — `ExcludingCapturePolicy`, per-application exclusion at
  the ingress boundary, wrapping redaction. The unit of exclusion is the **foreground**:
  only `application_activated` carries a name, so an activation latches the answer and
  every later event describing the foreground — window title, focused control, selection,
  page, keyframe — is dropped until another activation says otherwise. Facts from watching
  a path or a pipe pass through. A matched event is dropped outright and diagnostics carry
  counts only: recording "excluded app X" would recreate exactly what the user asked to
  hide. `resolveCaptureExclusion` fails closed on a malformed list.
- `src/prediction-runtime.ts` — the capture boundary in front of the core: apply the
  policy, then ingest. Nothing more. It used to own prediction requests, attempt
  records, and an `admitAndClaim` linearization point, all of which assumed Squid
  decided what happened next.
- `src/create-watch-runtime.ts` — the store, core, and capture runtime every watch entry
  point needs, built once. Carries no source-specific assumptions and touches no
  `process.env`.
- `src/watch-session.ts` — everything a watch entry point does apart from choosing
  sources: retention, restore, agent creation, the ingest loop, and shutdown ordering.
  Sources are a **list**, because what the agent can conclude is a function of the whole
  projection — telling "the tests just failed" from "a file changed" needs a terminal
  source and a filesystem source feeding one core. Sources start one at a time and a
  failure unwinds the ones already running; stop runs in reverse start order.
- `src/audit-text.ts` — `sanitizeAuditText` and `describeErrorForAudit`, the deterministic
  choke point for any text reaching a log: control characters stripped, credentials
  redacted, fixed length ceiling. Load-bearing because an error message routinely quotes
  the thing that failed — a path, a window title, a tool's own stderr.
- `src/resolve-retention.ts` — resolves `SQUID_RETENTION_HOURS`. Off by default, and a
  malformed value fails startup rather than running a session whose deletion policy was
  silently not applied.
- `src/retention-prune.ts` — ranged deletion of captured events, shared by the startup
  retention pass and `history:delete`.
- `src/history-delete.ts` — `bun run history:delete`, the stated interface for deleting a
  time range. Requires an absolute database path: deleting the wrong file's history is
  not recoverable, so the command refuses to guess which file is meant.

### Sources

- `src/filesystem-source.ts` — filesystem watcher emitting validated file activity for
  one project root.
- `src/screen-text-source.ts` — the `ScreenTextReader` seam, the neutral
  `ScreenTextFrame` shape, and the adapter projecting frames onto host activity events.
- `src/screen-text-reader-macos.ts` — macOS accessibility backend over `osascript`.
  Real, darwin-only, not exercised by the offline suite.
- `src/screen-text-reader-synthetic.ts` — scripted frame replay plus the built-in demo
  script. Zero OS calls, so the screen-text path is reproducible anywhere.
- `src/resolve-screen-reader.ts` — chooses a backend from `SQUID_SCREEN_READER` /
  `SQUID_SCREEN_POLL_MS`, defaulting to whichever real backend the host has and
  falling back to the demo script only where there is none.
- `src/screen-text-reader-linux.ts` — `xdotool` backend; window identity only.
- `src/screen-text-reader-windows.ts` — UI Automation backend over a long-lived
  PowerShell child: focused control type, element name, and selection.
- `src/terminal-command-source.ts` — the `TerminalCommandReader` seam and the adapter
  projecting completed shell commands onto `terminal_command_completed`.
  `classifyCommand` reduces a raw command line to one of a closed set of classes, and
  that reduction *is* the capture boundary: the raw line is classified and discarded,
  never emitted. A closed vocabulary rather than "the first word", because the first
  word is user text — `./deploy-to-prod-acme-corp.sh` names a client and
  `psql postgres://user:pw@host/db` is a credential. `succeeded` is derived from the
  exit code rather than trusted, and an unreadable exit code counts as failure.
- `src/endpoint-transport.ts` — the transport seam the FIFO-shaped readers share:
  an endpoint names its transport by spelling, POSIX-absolute path or Windows
  named pipe, and one line-reader call serves either. The pipe dialect exists
  because `mkfifo` has no Windows equivalent — without it the three
  FIFO-backed capabilities were unusable on the platform the product ships to.
- `src/terminal-command-reader-fifo.ts` — reads one JSON completion per line from a path
  a shell hook appends to. A file rather than a wrapper process, so a crashed
  integration cannot take the user's terminal with it. The module doc carries a working
  zsh hook.
- `src/resolve-terminal-reader.ts` — resolves `SQUID_TERMINAL` / `SQUID_TERMINAL_FIFO` /
  `SQUID_TERMINAL_POLL_MS`. Off by default: observing a shell is a capability a run asks
  for.
- `src/browser-page-source.ts` — the `BrowserPageReader` seam, the neutral
  `BrowserPageFrame` shape, and the adapter projecting frames onto `browser_navigated`.
  A frame whose URL yields no host is refused rather than given an invented host, and a
  backend that cannot tell which window owns a tab omits the owner instead of guessing.
- `src/browser-page-reader-macos.ts` — macOS accessibility backend over `osascript`:
  owning pid, window title, active-tab URL in one poll. Darwin-only; the parser is
  tested.
- `src/browser-page-reader-synthetic.ts` — scripted page replay whose owner matches the
  screen demo's final window.
- `src/resolve-browser-reader.ts` — resolves `SQUID_BROWSER` / `SQUID_BROWSER_POLL_MS`.
  Off by default.
- `src/editor-save-source.ts` — the `EditorSaveReader` seam and the adapter projecting an
  editor's own save reports onto `file_saved` with `source.kind: "ide"`. The only source
  that reports *ownership* rather than observation: the editor names itself as writer,
  so its saves carry a real `applicationId`. Frames are refused, never repaired.
- `src/editor-save-reader-fifo.ts` — reads one save report per line from a path an editor
  extension appends to. The module doc carries a VS Code snippet; no packaged extension
  ships here.
- `src/resolve-editor-save-reader.ts` — resolves `SQUID_EDITOR_SAVES` / `SQUID_EDITOR_FIFO`
  / `SQUID_EDITOR_POLL_MS`. Off by default.
- `src/capture-gate-source.ts` — the `CaptureGateReader` seam and the adapter projecting
  control commands onto `capture_gate_changed`. The pause event is the trace that makes
  a deliberate gap distinguishable from an idle machine.
- `src/capture-gate-reader-fifo.ts` — reads one gate command per line from a path a shell
  alias appends to.
- `src/resolve-capture-gate.ts` — resolves `SQUID_CONTROL` / `SQUID_CONTROL_FIFO` /
  `SQUID_CONTROL_POLL_MS`. Off by default; enabling it declares that this run can be
  controlled.
- `src/path-containment.ts` — whether a path resolves inside a root.
- `src/project-detect.ts` — what a project declares it can run, read from its manifest.

### Speaking up

The senses are inputs; this is the one capability that talks. It exists because the
panel was the only surface Squid had, so an agent reply reached a row in a window
nobody had open and stopped there.

- `src/desktop-notice.ts` — the `DesktopNotifier` seam and the `DesktopNotice`
  shape. A notice carries no action and no button on purpose: a consequential
  answer belongs on the confirmation surface, which has one-answer-per-prompt
  correlation, an expiry, and a decline on close. Delivery failure is a diagnostic,
  never an exception — the turn's work is already done and recorded.
- `src/desktop-notice-command.ts` — the shared loop for every host that can be
  asked from a child process: one delivery at a time with the newest notice winning
  the slot, one diagnostic per failure transition, and a deadline on each delivery.
  The deadline is not defensive: with no notification daemon, `notify-send` waits
  out D-Bus's 120-second activation timeout before failing, which would otherwise
  hold the slot through hundreds of turns and present as silence.
- `src/desktop-notice-linux.ts` — the `notify-send` arguments. `--` terminates the
  options before any text, because a summary beginning with a dash is otherwise
  parsed as short flags, and a model summarising its work routinely starts with one.
- `src/desktop-notice-windows.ts` — the Windows balloon, shown by a PowerShell
  helper the seam resolves from `%SystemRoot%`. The script is a constant and the
  notice travels on stdin as one JSON line decoded as UTF-8 — no user text reaches
  the PowerShell parser, and none of it is decoded in the OEM code page. The
  helper outlives the system's ten-second balloon floor, then removes its icon.
- `src/resolve-desktop-notice.ts` — resolves `SQUID_NOTIFY`. On by default wherever
  the host has a backend, `off` the explicit decline on every host; unset on a host
  with no backend starts quiet, while `desktop` asked for by name there refuses
  rather than resolving to off: a run that asked to be interrupted and silently
  was not is indistinguishable from a sleeping daemon.

Where the popup appears is the desktop's decision, not Squid's. The notification
spec describes passive popups and says nothing about placement — the daemon decides,
and it is also what honours do-not-disturb and keeps a missed notice in a history.
Drawing our own window in a chosen corner would give up all three, and on Wayland a
client cannot position its own window at all.

### The tray

`ui/tray.slint` puts a `SystemTrayIcon` beside the panel window — a Slint 1.17
element with real backends on all three platforms (`Shell_NotifyIcon` on Windows,
`NSStatusItem` on macOS, `StatusNotifierItem` over D-Bus on Linux), which is why it
costs no new crate on the ship target.

It answers what the window cannot while it is buried under other windows: whether
Squid is running, and what it is doing. The hover text is the status card's own
sentence, published by `panel.slint` as `status-title` from the one expression in
`status.slint` that decides what Squid is doing, so the two surfaces cannot come to
different conclusions. The icon is drawn in Rust rather than shipped as a file: the
repository has no asset pipeline, and a dome with three tapering tentacles is small
enough that the code is the source.

**Closing the window is putting it away, not ending the run.** A visible tray icon
keeps Slint's event loop alive by itself, so a hidden window is still a live panel
with a way back and a way out: the tray menu carries **Show Squid** and **Quit
Squid**. The menu was measured to export on Linux — an earlier "the menu is empty
on Linux" verdict turned out to be the test stand-in's own doing (it answered the
panel's handshake so late that the tray never finished spawning, then reported the
empty menu it had caused), and once the stand-in answered first, the same panel
returned both entries. The whole chain was then measured end to end on a stand-in
host: real `Window::hide()` unmaps the panel while the process stays alive, a
dbusmenu click on "Show Squid" brings the window back, and a click on "Quit Squid"
ends the run — quitting without first hunting for a window behind six others.

Pause is not offered in the tray: it stays in the panel's Recording section, which
owns the prose that goes with it, because pause control is FIFO-backed and
unavailable on Windows entirely.

### Entry points

- `src/watch-desktop.ts` — the only entry point observing more than one part of the
  desktop: filesystem saves, foreground window text, and (opt-in) browser pages,
  terminal commands, and editor saves into one core.
- `src/watch-files.ts` — live filesystem ingestion; durable when `SQUID_DB` is set.
- `src/watch-screen.ts` — live foreground-window-text ingestion.
- `eval/eval-agent.ts` — the live corpus runner (`bun run eval:agent`): each scenario's
  events project through a real core, and a fresh toolless resident agent is asked what
  the user is doing; its answer prints beside the scenario's expected reading. A
  hand-run harness — live judgment is not a CI assertion.
- `src/main.ts` — demo: three events through the core, printing the projection each one
  builds.

## The closed loop

One ingest does three things:

1. **Capture and project.** The capture policy runs first — it is the last chance to
   redact before history — then `core.ingest` reduces the event into the projection.
2. **Observe.** `agent.observe(state)` updates the live sense buffer and appends a
   one-line breadcrumb to the agent's session history. This happens for every event that
   survives capture and changed something, including events arriving while a turn is
   already running.
3. **Prompt.** The agent takes a turn.

Turns are serialized. Two prompts overlapping on one session is not two opinions — it is
one conversation with interleaved turns, and the agent would be reasoning about a
half-written history. Events keep arriving during the wait and land in the sense buffer,
so a busy agent sees the *latest* world when it next thinks rather than a queue of stale
ones. For a sensor stream that is the right trade: the newest observation is the useful
one.

A duplicate event gets no turn — it changed nothing, so there is nothing to think about.
An excluded event reaches neither history nor the agent's senses, and the log line says
only that something was excluded.

The turn prompt deliberately carries no task. The world state and the tool catalog
arrive through the sense injection, so restating them would give the model two versions
of the same facts. What the prompt supplies is the one thing the injection cannot:
*permission to do nothing*. Without it, a model handed a fresh observation every few
seconds reads each one as a request for action, and the loop's steady state becomes
activity rather than attention.

### Shutdown ordering

`stop()` runs in exactly one order, and each step is needed for a different reason:

1. **Sources**, in reverse start order, so a later source never emits into one already
   torn down.
2. **In-flight agent turns**, while the session is still open. A turn cut off mid-flight
   loses whatever the agent was doing, and its session history is the only record that
   it happened.
3. **The agent.**
4. **The store**, last — an in-flight ingest still needs somewhere to land.

## Persistence

Three `EventStore` implementations satisfy one contract. `all()` returns every appended
event exactly once, but **return order is not part of the contract** — callers that need
a timeline apply `orderActivityEvents`, which is total on events with distinct
`eventId`s. `since()` compares epoch milliseconds on both sides, so timezone spellings
of the same instant are equal.

`SqliteEventStore` stores the full event as JSON and rehydrates every read through
`parseActivityEvent`, so `ingestedAt`, `correlationId`, and sub-millisecond `occurredAt`
spellings survive a round trip. Its scalar columns are a lossy projection kept for
filtering and integrity only. A primary key on `eventId` and a unique index mirroring
source-local event identity make duplicates a structural error rather than a convention:
both raise `EventStoreConstraintError`. That is deliberately one error type rather than
two, because a row violating both constraints reports only the identity index's `UNIQUE`
violation — the error code cannot tell "same event twice" from "identity reused by a
different event".

`journal_mode = WAL` with `synchronous = NORMAL` means committed events survive process
death without an explicit checkpoint. They are **not** guaranteed to survive OS or power
loss — that would need `synchronous = FULL`.

`JsonlEventStore` has no production caller. It is kept because it exercises the contract
under a different failure model — partial line writes and crash-tail repair — which the
SQLite implementation never encounters.

The watch entry points use `SqliteEventStore` when `SQUID_DB` names an absolute path, and
`InMemoryEventStore` otherwise. `restore()` runs before observing, so a restart rebuilds
the dedupe index and projection from history instead of re-ingesting it. `main.ts` is a
demo and stays in memory.

A database inside the watched root would feed its own writes back into the timeline: each
append updates `-wal`, the watcher reports that write, and ingesting it appends again.
`sqliteWatchExclusions` returns the root-relative paths of the database and its two WAL
sidecars so the watcher skips them; it returns nothing when the database lives outside
the root, so an unrelated sibling path can never be excluded by accident.

**The agent's history is persisted separately, by Pi.** Squid keeps one durable store of
its own — the event timeline — and does not maintain a second record of what the agent
did. That record is the Pi session, which is why a durable run continues its most recent
session rather than starting a fresh one.

## Episode projection

Episodes are derived, not stored: a gap longer than the threshold between consecutive
canonical events starts a new one. The projection is therefore a pure function of
history, and a replay reconstructs the same episodes without a second source of truth.

## Capture policy: exclusion, pause, and retention

Three independent controls, resolved before any sink opens so a typo fails startup rather
than silently running a session whose policy was never applied:

```bash
# Drop everything observed while a named application is in front, before the store.
SQUID_EXCLUDE='1Password,Vault' bun run watch:desktop -- /absolute/project/root

# Let the run be paused and resumed through a FIFO a shell alias appends to.
SQUID_CONTROL=fifo SQUID_CONTROL_FIFO=/tmp/squid-control bun run watch:screen

# Delete history older than the bound, once, at startup.
SQUID_RETENTION_HOURS=24 SQUID_DB=/absolute/path/events.db bun run watch:files -- /root
```

Retention prunes *before* restore, so the projection is rebuilt from the history that
actually remains — an event the policy deleted must not be re-ingested into world state.
The prune runs once per process start; there is no in-run timer, because a long-running
session would otherwise delete under the user's feet mid-episode.

Deleting a specific range is a separate, deliberate act:

```bash
bun run history:delete -- /absolute/path/events.db \
  2026-08-21T12:00:00.000Z 2026-08-21T13:00:00.000Z
```

Both bounds are inclusive, so an event landing exactly at the end of the range goes.

## Testing

`bun test` is offline and starts no model runtime. Every suite either exercises a pure
function or injects a seam:

- The resident agent takes a `ResidentSessionFactory`, so its tests drive a recording
  fake rather than a live Pi session.
- `startWatchSession` takes the same factory, which is what makes the closed loop
  assertable end to end: an event arrives, the agent's senses are updated, and it is
  given a turn — in that order.
- The sense rendering and the tool catalog are pure functions of their inputs, so what a
  model is told is asserted without loading a model.

That last point is worth stating as a rule. A green gate cannot see a requirement that
was never wired: every module could typecheck and every other suite pass while the ingest
closure quietly never reached the agent. The loop tests exist to assert the wiring itself.

The panel's supervision path is held to the same rule, because it was the clearest
example of the failure. `spawn_brain`, `supervise`, and the probe had no test caller at
all: the retry ladder and the crash window were covered as pure functions, while the
process handling around them rested on review. Three things are asserted against real
behavior now. `child_env` states the inherited environment as data, so the allowlist
that makes the settings file the authority — a stray `SQUID_BROWSER` in the parent must
not outrank the form — is checkable without a child. `supervise` runs actual children
that exit 1 and 2, proving a refused startup is not retried and a crash loop stops at
the guard. And the probe is exercised against a live Unix listener and a stale socket
file, since it is the double-start guard and a false positive there would put two brains
on one endpoint.

## Continuous integration and releases

Two workflows, and the split between them matters. `.github/workflows/ci.yml` runs the
gate on every pull request and every push to `main`: `typecheck`, `bun test`, and
`bun run build` on the TypeScript side, and `cargo fmt`, `cargo clippy -D warnings`, and
`cargo test` on the panel. Both halves run as separate jobs so a red run names which one
broke. The whole gate is offline and needs no secret, which is what lets it run on a
pull request from a fork.

`.github/workflows/release.yml` triggers on a tag matching `v*.*.*-*` — semver with a
mandatory pre-release suffix, so a tag claiming stability has to change that file first.
It re-runs the same gate on its own checkout, builds the panel in release profile, and
publishes a GitHub pre-release carrying the binary plus a `sha256` of it:

```bash
# Bump `version` in package.json and ui/Cargo.toml to the exact release, commit,
# then tag that commit.
git tag v0.1.0-alpha.1
git push origin v0.1.0-alpha.1
```

The tag is the version ledger. A `version` job reconciles it against the two manifests
before anything is built — the tag minus its leading `v` must equal what `package.json`
and `ui/Cargo.toml` already say, or the run goes red in seconds and nothing ships. The
panel binary itself answers `--version` with the version compiled in from `Cargo.toml`,
so a downloaded binary can say which release it belongs to without trusting the filename.

The gate runs again there rather than trusting the pull request's green run, because this
workflow builds the binary it uploads. A tag can be pushed at any commit; without its own
gate, the release job would be publishing an artifact built from code nothing had tested.
`workflow_dispatch` runs everything except the publish step, which is how the build gets
proven on a clean runner without spending a tag on it.

Only the publish job holds `contents: write`, and it shells out to the `gh` already on
the runner instead of delegating that token to a third-party action. Every action that
is third-party is pinned by commit SHA. This is the argument `ui/Cargo.toml` makes about
the panel's own dependencies, applied to the pipeline that signs its releases.

The published assets are one zip per platform — `x86_64-unknown-linux-gnu` and
`x86_64-pc-windows-msvc`, each with a `sha256` beside it. The zip holds two
binaries side by side: `squid`, the watch session compiled to a standalone
executable, and `squid-ui`, the panel. The Linux panel needs `libfontconfig1`,
`libfreetype6`, and `libxkbcommon0` at runtime — femtovg and winit link them, and
the workflow installs the matching `-dev` packages to build. The Windows build
needs no runtime packages; its panel transport is a named pipe
(`SQUID_PANEL_SOCKET=\\.\pipe\squid-panel`), where Unix uses a filesystem socket
— the protocol document names the spelling each platform accepts, and why the
pipe carries no access boundary the way the socket's file mode does.

**Unpack the zip and open `squid-ui`; that is the whole download.** It needs
no arguments and is the recommended way in. With `SQUID_PANEL_SOCKET` unset the
panel computes the platform endpoint, makes a short probe to avoid a double
start, then starts the sibling `squid` beside it. The supervised brain watches
the user's home directory by default, writes an empty Squid settings file only
when none exists yet, and leaves every business setting to that file — no parent
environment silently wins over what the form saves.

With no model configured, the panel starts the sensors in `needs configuration`
mode. Fill the model base URL, model id, and API key in **SETTINGS**; the key goes
only to Pi's `models.json`/`auth.json` and is never displayed back. **Model
provider** names the key those two files are stored under, so it lives in
Squid's config file rather than in Pi's — storing a key name is not keeping a
copy of what it addresses — and it takes effect on restart, because it decides
which entry the settings service reads before that service is built. Everything
else lives in Squid's own config file. A saved setting that says `restart` takes
effect when you click **Restart brain**; the brain drains in its ordinary order
and the panel starts its replacement. Three crashes inside a minute stop the
retries and leave the service reading `failed` — a broken install should not
burn a battery being respawned. That is terminal for a round of supervision,
not for the panel: **Start brain** takes the place of Restart there and begins
a fresh round with a clean crash log, because the user asking again is the
signal the guard was holding out for. Restart is hidden in that state, since
it writes to a socket with no brain on it and an unconnected write is dropped. The **SOURCES** list independently starts
and stops observers, except the last running observer (the session needs one)
and the capture gate (which is a pause switch, not a source).

The three FIFO-backed capabilities — capture gate, terminal commands, editor
saves — each take a backend and the endpoint path it reads, and both halves are
rows in the same form. They have to be: each backend offers exactly one value,
and that value is refused at startup without its path, so a form that offered
the backend alone could write a setting that stopped the brain from starting —
and with no brain there is no dump, so no form to undo it in. An endpoint names
its transport by its spelling — a POSIX-absolute path is tailed as an
append-only file, the Windows named-pipe spelling `\\.\pipe\<name>` is served
as a pipe listener — and the path rows accept both dialects on every host,
because the config file is written in one dialect no matter which platform
reads it. The pipe dialect is what makes the three capabilities exist on
Windows at all: `mkfifo` has no equivalent there.

You can still run `squid` by hand. Its panel child attaches normally. You can
also start `squid-ui` with a non-empty `SQUID_PANEL_SOCKET` to attach to a session
someone else started. An endpoint set to an empty string is refused rather than
guessed at, because that is a launcher losing a value, not a panel-first request.
If neither a live session nor the sibling `squid` binary exists, the panel names
what it looked for and exits 2. A window that cannot be created — no display, no
OpenGL — exits 3. On Windows these failures also appear in a dialog when the
panel owns its short-lived double-click console.

## What is not yet implemented

- No supplementary tools ship. The agent works with Pi's built-ins plus its own
  `query_recent_events` sensory-history tool; `ToolSummary` is the shape a run would
  describe extras in, and the catalog renders a stated absence when none arrive.
- Browser page reading is darwin-only; the synthetic backend covers the path anywhere.
  Screen text reads on all three platforms, and no longer reads the same amount on
  each. Windows runs full UI Automation — focused control type, element name, and
  selected text where the element exposes a text pattern — from one long-lived
  PowerShell child (`streamingScreenTextReaderFactory`), because a per-sample spawn
  costs twenty times the automation query it wraps. macOS and Linux still share the
  poll loop (`screen-text-reader-subprocess.ts`), and Linux on `xdotool` still
  reports window identity only: its focus roles and selection text wait for an
  AT-SPI backend. What a Windows selection actually yields depends on the
  application — a native edit control answers fully, Chromium exposes the pattern
  and ignores a programmatic selection.
- The evaluation corpus (`eval/corpus.ts`) is a start, not an endpoint: five scenarios
  with a deterministic CI consumer and a live runner (`bun run eval:agent`) that prints
  a real agent's reading beside each expected one. What no run has yet measured is a
  second model: on the current default, the agent reads every scenario's state correctly
  but answers in conversation rather than the requested reading phrase, so the runner
  records the mismatch and a human judges.

## Archived documents

`docs/architecture-hardening-plan.md` describes the architecture this one replaced —
a five-step dispatch pipeline over one-shot model calls, with a prediction ledger
recording why each one ran. Kept for the reasoning, not as a description of the code.
