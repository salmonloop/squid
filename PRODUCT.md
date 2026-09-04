# Product

<!-- impeccable:product-schema 1 -->

## Platform

desktop

<!-- The schema enumerates web | ios | android | adaptive; none names a native
desktop binary. Squid's panel is a Rust + Slint executable (`ui/src/main.rs`,
shipped as `squid-ui`) that travels in a zip beside the watch session, so
`desktop` is recorded rather than forced into a value that would misroute later
work. Ship target is Windows (x86_64-pc-windows-msvc); development and CI
verification happen on Linux. -->

## Stack

Answered by the existing codebase. Watch session: TypeScript on Bun 1.3.11.
Panel: Rust 2021 + Slint 1.17.1 with `default-features = false` and features
`compat-1-2`, `std`, `backend-winit`, `renderer-femtovg` — native rendering
only, enforced in `ui/Cargo.toml` so the binary cannot silently fall back to a
webview. The panel carries exactly one runtime dependency on purpose: it is the
process that turns a click into permission to run a command, so its own supply
chain is part of its threat model.

## Users

**Confirmed:** a non-technical consumer. Someone who does not know what a model
base URL, a socket, a FIFO, or an API key is, and who must still be able to
reach those things when a capability they want depends on one.

That person arrives in one of three situations, and the panel today serves all
three through one flat list:

- glancing to see whether Squid is watching, and what it last saw;
- answering a decision Squid is blocked on;
- repairing something, or changing what Squid is allowed to see.

**Assumed, not confirmed:** that this consumer is also whoever installs Squid.
Nothing in the repository describes a separate installer or administrator role.

## Product Purpose

Squid watches what happens on the machine, projects it into a world state, and
hands that state to one long-lived Pi agent that decides for itself what to do.
The panel is the only surface where a person can see what Squid observed, stop it
observing, answer a request to act, and change its configuration.

Success for the panel: a novice can answer "is it watching, and did it see
anything?" at a glance; can answer a permission request without first being
taught the system's vocabulary; and can find and fix a broken capability without
being told where to look.

## Positioning

The agent is the subject, not a service Squid calls. Squid owns the senses —
capture, history, projection — and the agent owns judgement and acting. What the
agent may reach is governed by Pi's sandbox, which is why there is no tool
registry and no admission rule engine in this repository.

Two consequences bind the panel's design:

- **Capture is irreversible.** Redaction and exclusion sit before the store, and
  a pause must leave a visible trace (`capture_gate_changed`) rather than a
  silent gap in history.
- **The agent's Pi session history is the audit trail.** Squid keeps one durable
  store of its own — the event timeline — and no second record of what the agent
  did.

## Operating Context

- Every capability is **off by default**. Enabling one declares that this run may
  observe that thing.
- The panel is a **separate process** from the watch session. TypeScript listens;
  the panel connects and retries, so either side restarts without the other. The
  endpoint spelling names the transport: a Unix socket path, or a Windows named
  pipe (`\\.\pipe\squid-panel`).
- The panel may **supervise** the watch session — spawn it, probe for a double
  start, retry on failure, stop at a crash guard — or merely observe one already
  running. Both modes ship.
- Five senses exist: Files, Screen, Browser, Terminal, Editor saves. A sense
  whose configuration is absent is *declared but unstartable*, so the catalog
  shows that the capability exists and that this run cannot use it.
- **The last running sense cannot be stopped** (`src/source-manager.ts`). A
  session with no observer at all is refused.
- 23 settings reach the panel as a schema-carrying wire dump. The panel holds no
  list of setting names and no notion of which ones need a restart.

## Capabilities and Constraints

Confirmed scope for this redesign: all layers are in scope — `ui/panel.slint`,
the Rust side's structure and property plumbing, additional windows or forms, and
backward-compatible additions to the panel wire protocol and its TypeScript half.

Binding constraints:

- **Progressive disclosure is a requirement, and an "Advanced" toggle or tab is
  ruled out as the mechanism.** The interface must be simple enough for a novice
  and must still let someone reach an advanced control when they go looking.
- Slint 1.17.1 is the ceiling. A feature that landed later cannot be used.
- Ship target Windows; development and verification on Linux. macOS has capture
  backends but no released panel artifact.
- The panel must not become a second copy of the brain's config schema. Labels,
  kinds, enum choices, and restart-vs-now all arrive on the wire.
- The CI gate is offline and stays offline: `cargo fmt`, `cargo clippy -D
  warnings`, `cargo test` on the panel; `typecheck`, `bun test`, `bun run build`
  on the TypeScript side.

Decided since: the resident form is the window **and** a tray presence. Slint 1.17
ships `SystemTrayIcon` with native backends on all three platforms, and on Windows it
costs no dependency at all. The tray reports presence and state; it does not yet make
closing the window mean "put away", because Slint 1.17.1 exports an empty tray menu on
Linux and a hidden window with no reachable way out is worse than no hiding. Still
undecided: whether approval arrives in its own window. New windows and forms are permitted; which ones exist is a design decision,
not a settled fact.

## Evidence on Hand

Real, in the repository:

- `docs/panel-protocol.md` — the wire contract, with measured platform behaviour
  (socket mode defaults, named-pipe DACL, the write-connection feedback loop).
- `src/config-schema.ts`, `src/config-service.ts` — the 23 settings with their
  real labels, kinds, enum values, and validation messages.
- `ui/src/supervisor.rs` — the real service-state labels and the sentences the
  panel shows when supervision fails.
- `eval/` — a live corpus runner whose scenarios are real captured readings.

Absent, and not to be fabricated: any user research, telemetry, support tickets,
install counts, or testimonials. No packaged editor extension ships; the VS Code
and zsh integrations exist as snippets in module docs. There is no first-run
onboarding surface at all today — `app-model.ts` collects a model over stdin.

## Product Principles

1. **Off by default, and say so.** A capability that is not running is a fact to
   disclose, not a state to hide. The panel already refuses to imply an
   all-seeing run, and the redesign keeps that.
2. **Never assert health — derive it.** A summary claiming "watching" while
   nothing is watching is the one failure this product cannot afford.
3. **The wire is the schema.** The panel renders what the brain declares. A label
   or a choice hardcoded in Rust is a bug waiting for the schema to change.
4. **A pause leaves a trace.** Deliberate blindness must stay distinguishable
   from an idle machine, both in history and on screen.
5. **One decision, one answer.** Approval is per prompt, it expires, and closing
   the window is a decline.

## Accessibility & Inclusion

The user established no product-specific requirement. Two floors apply regardless
and are treated as binding:

- Colour alone may not carry state (WCAG 2.2 SC 1.4.1). The panel's current state
  vocabulary is pure colour and fails this.
- The panel must be operable and legible without a mouse, and without assuming a
  light desktop. The ship target's system theme is not knowable at build time.
