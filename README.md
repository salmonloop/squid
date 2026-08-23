# Squid

Squid is a capability-first desktop assistant prototype built around the Pi agent runtime.

The first implemented vertical is deliberately model-independent:

```text
activity event -> append-only store -> episode-scoped world state -> baseline prediction
```

Pi is an optional cognition layer. The event store and world state remain usable without a model so that desktop capture, replay, and prediction can be evaluated offline.

## Requirements

- Bun `1.3.11` or later
- A configured Pi model is only required for `PiRuntime`; the baseline core and tests are offline.

## Commands

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun run dev
bun run evaluate
bun run gate:pi
bun run history:delete -- /absolute/path/events.db <from> <until>
bun run ledger:report -- /absolute/path.db.ledger.db
bun run watch:desktop -- /absolute/project/root
bun run watch:files -- /absolute/project/root
bun run watch:screen
```

## Architecture

- `src/protocol.ts` — versioned activity/prediction contracts plus compiled runtime validation at every Chronicle ingress boundary.
- `src/chronicle-ordering.ts` — canonical event identity and stable replay ordering.
- `src/event-store.ts` — the `EventStore` contract plus in-memory and JSONL append-only stores, including recovery diagnostics for an interrupted final JSONL record.
- `src/sqlite-event-store.ts` — append-only store on SQLite, with structural uniqueness on both `eventId` and source-local event identity.
- `src/episode.ts` — deterministic, time-gap-based episode projection over canonical events.
- `src/world-state.ts` — deterministic, ownership-safe reducer from events to world state.
- `src/activity-source.ts` — the source contract every capture adapter implements.
- `src/filesystem-source.ts` — filesystem watcher that emits validated file activity for one project root.
- `src/screen-text-source.ts` — the `ScreenTextReader` backend seam, the neutral `ScreenTextFrame` shape, and the `ScreenTextActivitySource` adapter that projects frames onto host activity events.
- `src/screen-text-reader-macos.ts` — macOS accessibility backend over `osascript`. Real, darwin-only, and not exercised by the offline suite.
- `src/screen-text-reader-synthetic.ts` — scripted frame replay backend plus the built-in demo script. Zero OS calls, so the screen-text path is demonstrable and reproducible anywhere.
- `src/create-watch-runtime.ts` — the store, ledger, projection, and prediction runtime every watch entry point needs, built once. Carries no source-specific assumptions.
- `src/watch-session.ts` — everything a watch entry point does apart from choosing sources: provider admission, egress resolution, restore, action wiring, the ingest loop, and shutdown ordering. Takes the sources as a **list**, which is what makes an action admissible at all: `admitRunTests` compares a save's owner against the foreground application, so one source per process left that check unsatisfiable by construction. Sources start one at a time and a failure unwinds the ones already running; stop runs in reverse start order so a later source never emits into a runtime an earlier one has begun tearing down.
- `src/resolve-screen-reader.ts` — chooses a screen-text backend from `SQUID_SCREEN_READER` / `SQUID_SCREEN_POLL_MS` and loads scripted frames. Separate from the adapter so `screen-text-source.ts` still imports no backend, and separate from the entry points because more than one needs it.
- `src/terminal-command-source.ts` — the `TerminalCommandReader` seam and the adapter that projects completed shell commands onto `terminal_command_completed`. `classifyCommand` reduces a raw command line to one of a closed set of classes, and that reduction *is* the capture boundary: the raw line is classified and discarded, never emitted. A closed vocabulary rather than "the first word", because the first word is user text — `./deploy-to-prod-acme-corp.sh` names a client and `psql postgres://user:pw@host/db` is a credential. `succeeded` is derived from the exit code rather than trusted from the backend, and an unreadable exit code counts as failure, since hiding a failure is worse than surfacing a spurious one.
- `src/terminal-command-reader-fifo.ts` — reads one JSON completion per line from a path a shell hook appends to. A file rather than a wrapper process, so a crashed integration cannot take the user's terminal with it; the hook writes and moves on. Handles partial writes, truncation, and a not-yet-created file. The module doc carries a working zsh hook.
- `src/resolve-terminal-reader.ts` — resolves `SQUID_TERMINAL` / `SQUID_TERMINAL_FIFO` / `SQUID_TERMINAL_POLL_MS`. Off by default: observing a shell is a capability a run asks for.
- `src/browser-page-source.ts` — the `BrowserPageReader` backend seam, the neutral `BrowserPageFrame` shape, and the adapter that projects frames onto `browser_navigated` events. This is the source `search_selection` was blocked on: `admitSearch` needs a current browser page, and nothing could produce one. A frame whose URL yields no host is refused rather than given an invented host, and a backend that cannot tell which window owns a tab omits the owner instead of guessing — the reducer then drops a non-matching owner and the next focus change discards the page, so a wrong owner cannot defeat admission.
- `src/browser-page-reader-macos.ts` — macOS accessibility backend over `osascript`: owning pid, window title, active-tab URL in one poll. Real, darwin-only, not exercised by the offline suite; the parser is.
- `src/browser-page-reader-synthetic.ts` — scripted page replay backend plus a demo script whose owner matches the screen demo's final window. Zero browser calls, so the search path is demonstrable anywhere.
- `src/resolve-browser-reader.ts` — resolves `SQUID_BROWSER` / `SQUID_BROWSER_POLL_MS`. Defaults to **off**, unlike the screen reader: browser observation is what makes search reachable, so a run opts in.
- `src/editor-save-source.ts` — the `EditorSaveReader` seam and the adapter that projects an editor's own save reports onto `file_saved` events with `source.kind: "ide"`. This is the source issue #7 asked for and the only one that reports *ownership* rather than observation: the editor names itself as writer, so its saves carry a real `applicationId` and satisfy `admitRunTests`'s unchanged equality check. Frames are refused, never repaired — no pid, no event.
- `src/editor-save-reader-fifo.ts` — reads one save report per line from a path an editor extension appends to, mirroring the terminal FIFO: append-only, so a crashed plugin costs one lost report rather than a broken editor. The module doc carries a working VS Code extension snippet.
- `src/resolve-editor-save-reader.ts` — resolves `SQUID_EDITOR_SAVES` / `SQUID_EDITOR_FIFO` / `SQUID_EDITOR_POLL_MS`. Off by default like every capability variable: an editor speaking for itself is the strongest ownership claim in the system, so a run gets it by asking.
- `src/capture-exclusion.ts` — `ExcludingCapturePolicy`, per-application exclusion at the ingress boundary wrapping `RedactingCapturePolicy`. A matched event is dropped outright and diagnostics carry counts only — recording "excluded app X" would recreate what the user asked to hide. `resolveCaptureExclusion` fails closed on a malformed list.
- `src/capture-gate-source.ts` — the `CaptureGateReader` seam and the adapter projecting control commands onto `capture_gate_changed`. The pause event is the trace that makes a deliberate gap distinguishable from an idle machine.
- `src/capture-gate-reader-fifo.ts` — reads one gate command per line from a path a shell alias appends to, mirroring the other FIFOs: append-only, so a crashed control script costs one lost command rather than a broken watcher.
- `src/resolve-capture-gate.ts` — resolves `SQUID_CONTROL` / `SQUID_CONTROL_FIFO` / `SQUID_CONTROL_POLL_MS`. Off by default; enabling it is declaring this run can be controlled, which is worth asking for.
- `src/watch-desktop.ts` — the only entry point that observes more than one part of the desktop: filesystem saves, foreground window text, and (opt-in) browser pages into one core.
- `src/watch-files.ts` — live filesystem ingestion entry point; durable when `SQUID_DB` is set.
- `src/watch-screen.ts` — live foreground-window-text ingestion entry point; picks a reader backend from `SQUID_SCREEN_READER`.
- `src/baseline-predictor.ts` — offline heuristic predictor used for evaluation.
- `src/evaluation.ts` — deterministic replay runner and prediction metrics.
- `src/evaluation-fixtures.ts` — versioned synthetic replay scenarios with labeled cut points.
- `src/evaluate.ts` — evaluation report entry point.
- `src/provider-gate.ts` — replay gate that scores a candidate provider against the heuristic baseline on one fixture version and measures provider health, which the ranking report omits.
- `src/semantic-gate.ts` — the gate a cognition path must clear: `runProviderGate` for ranking, then determinism measured directly by replaying the corpus and comparing the top candidate per cut point. A provider whose top-1 answer moves between runs is refused however well it scores on average, which is the failure a mean cannot see.
- `src/provider-selector.ts` — admission boundary for the live primary provider: chooses heuristic, model, or cognition, and reports why one was declined. Pure and fully injected, so it imports no model runtime. `readGateVerdict` is shared by both gated paths so "a skip is not a pass" is stated once.
- `src/watch-provider.ts` — wires the real Pi, replay-gate, and cognition seams into the selector and reads `SQUID_PROVIDER` / `SQUID_PROVIDER_GATE` for every watch entry point. Each heavy module graph is imported lazily inside its own branch.
- `src/belief-provider.ts` — the belief seam: `BeliefRequest` (carrying the projection identity a batch must agree with), `BeliefProvider`, `NoBeliefsError` for "nothing to assert", and `validateBatchAgainstRequest`, which refuses a batch whose episode, digest, generation, or context policy has moved.
- `src/belief-state.ts` — the belief contract itself: closed intent vocabulary, bounds against an untrusted producer, and semantic validation of TTLs, duplicate IDs, self-reference, and evidence that postdates the belief citing it.
- `src/heuristic-belief-provider.ts` — deterministic baseline belief producer: four rules over facts the projection already holds, each naming the events it read. A rule that cannot cite evidence contributes nothing rather than poisoning the batch.
- `src/belief-evidence.ts` — `evidenceTimeline(state)`, the event map a belief's evidence is checked against, derived from the projected state the provider was shown. A provider can only cite what it could see.
- `src/belief-resolver.ts` — live-path adapter from `PredictionRequest` to a validated batch. Every failure resolves to `null`, so an unreachable belief layer degrades to cognition-from-state; `onOutcome` is how a run says *why* beliefs were absent.
- `src/cognition-provider.ts` — `CognitionProvider` (state plus beliefs to candidates) and `BeliefBackedPredictionProvider`, the adapter that keeps the belief layer off the critical path.
- `src/belief-rerank-cognition.ts` — the shipped cognition provider: reorders candidates by asserted intent, cannot invent one, and is deterministic by construction so the stability gate can admit it.
- `src/shadow-cognition.ts` — runs a cognition path beside the live one and emits a self-describing observation. No dispatcher, no gateway; a shadow run is never awaited, so it cannot delay a real prediction.
- `src/shadow-ledger.ts` — turns an observation into an attempt record the ledger accepts and no dispatch claim can reach: `:shadow` request-ID suffix, `shadow:` provider prefix, `suggestion_only` trust, and a deliberately unshifted `triggerEventId` so retention deletion removes it alongside the live record.
- `src/resolve-shadow-cognition.ts` — three-state `SQUID_SHADOW_COGNITION` resolution. Strict, because a typo that silently disabled shadow mode would read as the cognition path agreeing with the heuristic everywhere.
- `src/gate-pi.ts` — `bun run gate:pi` entry point for the Pi-backed predictor. Needs a reachable model, so it is separate from the offline suite.
- `src/prediction-provider.ts` — async prediction contract: `PredictionProvider` interface, `PredictionRequest`, `PredictionOutcome`, and `SyncPredictorProvider` adapter.
- `src/prediction-coordinator.ts` — one-in-flight async coordinator with timeout, cancellation, stale-episode guard, and heuristic fallback. Applies a `ContextPolicy` to the provider's view of world state.
- `src/context-policy.ts` — egress boundary for provider context: `ContextPolicy` interface, `PassthroughContextPolicy` (the default), and `RedactingContextPolicy` with a typed allow-list.
- `src/capture-policy.ts` — ingress boundary for capture: `CapturePolicy` interface, `PassthroughCapturePolicy` (the default), and `RedactingCapturePolicy`, which strips credential content before an event reaches the store. Capture is irreversible, so this narrows what is persisted rather than what is merely shown to a provider.
- `src/action-egress.ts` — three-state `SQUID_SEARCH_EGRESS` resolution (unset = deny, exact `allow` = allow, anything else a startup error) plus `sanitizeAuditText`, the single deterministic choke point for any text reaching a log, feedback, or the ledger: control characters stripped, credentials redacted, fixed length ceiling. Selections and plan summaries never carry a preview; rationale and tool summaries may.
- `src/state-digest.ts` — canonical JSON over the full `WorldState` and the `sha256:` digest derived from it. Identical across ordered, late, and restored replays, which is what makes it usable as a claim precondition.
- `src/prediction-runtime.ts` — live orchestration boundary that feeds accepted/late core state snapshots into the coordinator without coupling provider latency to event ingestion. An outcome is published only after its attempt record is durable, so a caller can immediately dispatch a candidate without racing the write it claims against; a failed write still delivers the prediction as a diagnostic, and the action is then correctly refused rather than silently unauditable. `admitAndClaim` is the linearization point for actions: admission and the ledger claim run together inside the core's critical section, so no ingest can land between "the state still matches" and "this claim is recorded".
- `src/prediction-ledger.ts` — append-only prediction attempts, feedback, and the action-plan state machine. Attempts are schema v2: `runtimeSessionId`, `stateDigest`, `projectionGeneration`, `triggerEventId`, `episodeId`, `triggerDisposition`, `contextPolicyId`, `actionTrust`, and `egressPolicyId` are all required, because a record missing them could not be audited back to the boundary that authorized it. Actions move through a narrow API — `recordPlan`, `recordDecision`, `recordStateRejection`, `claimDispatch`, `completeDispatch` — so a terminal state cannot be written through the generic append; feedback is limited to how a *prediction* was received (accepted/rejected/expired). `claimDispatch` validates every metadata field, the recorded plan, the candidate, and the legal predecessor state in one atomic operation, and only `claimed` authorizes an outside-world call.
- `src/sqlite-prediction-ledger.ts` — append-only ledger on SQLite that declares its integrity rules as schema constraints instead of process-local checks.
- `src/ledger-report.ts` — report over a persisted ledger: attempts by provider/status, fallback reasons, candidate kinds, latency percentiles. Splits live from shadow attempts by provider name, keeping the top level the live path alone so a report predating shadow mode compares the same quantity. Pure aggregation over ledger records; the CLI tail reads the database a durable watch run wrote.
- `src/capability-gateway.ts` — the only path from a prediction to an executed capability. `CapabilityGateway` receives a finished `ImmutableActionPlan` and never a candidate, so a model cannot choose the tool or the command. `CapabilityDispatcher` runs one fixed order: record the plan, confirm it, admit-and-claim inside the runtime's serial queue, invoke, complete. Nothing after the claim may reject — a refusal there would leave a dispatched record with no terminal state. A structured tool failure is data (`failed`); a *thrown* invocation becomes `reconciliation_required`, never `failed`, because after the claim the tool may have run and a fabricated failure would invite a retry of a possibly-completed action.
- `src/action-plan.ts` — the shared plan vocabulary: which prediction kinds have a capability mapping, the `ImmutableActionPlan` shape, and the two digests (`digestActionPlan`, `digestCandidateParameters`) that follow a plan everywhere. Both digests live here so the value the planner writes to the ledger is byte-identical to what admission recomputes at claim time.
- `src/action-planner.ts` — builds a plan once, asynchronously, because canonicalization is a filesystem question: `realpath` is the only way to know whether a path, a symlink, or a bind mount lands inside the working directory. It rejects traversal/absolute/control-character paths, quotes with `shell-quote` over canonical values, and keeps the raw selection out of the summary (only its length appears).
- `src/action-admission.ts` — pure validation of one already-built plan against the attempt, the current metadata, and the live projection. Every check is a refusal, never a repair: a mismatch means the world moved, so the action is dropped rather than re-planned. Search additionally requires that selection, page owner, and foreground owner all agree, that the selection was observed *after* the page, and that egress is explicitly allowed.
- `src/action-confirmation.ts` — the confirmation engine and the port a surface implements. One `ActionConfirmationPolicy` implementation, `SerialConfirmationPolicy`, owns the entire fail-closed matrix: prompts are serialized, expiry and timeout race against each other and are reported apart, and an unavailable surface, a thrown surface, closed input, and shutdown all refuse. A `ConfirmationSurface` therefore decides nothing — it renders a question and reports one answer. `ConfirmationPrompt` is a four-scalar projection with no `arguments` field, so no surface can render the selection even if it tried.
- `src/confirmation-surface-terminal.ts` — the terminal surface. Only explicit `y`/`yes` accepts; a non-TTY, an empty line, and anything else refuse.
- `src/confirmation-surface-graphical.ts` — the graphical surface and its `GraphicalTransport` port, so the window's location (another process, eventually another machine) is not baked into the surface. `close()` forwards to the transport, because the engine's shutdown is the only thing that can reach a spawned UI.
- `src/graphical-transport-stdio.ts` — line-delimited JSON over a spawned child's stdio, the same cross-process shape the MCP client already uses. Every prompt carries a monotonic `promptId` and an answer settles the pending ask only on a match: the engine abandons a prompt on timeout and moves to the next candidate, so an uncorrelated late reply would let a click about one plan authorize another. An abort sends `cancel` so the abandoned window closes rather than inviting a click nobody is waiting for.
- `ui/` — the Rust/Slint binary that surface spawns. Fully native rendering, no webview; `winit` and `femtovg` are pinned in `Cargo.toml` so a future default change in Slint cannot substitute one. It shows `kind`, `summary`, and expiry and holds no other field. Policy stays in TypeScript: the window writes one correlated answer per click and is otherwise silent, and silence is read as a timeout, never as consent. Closing the window declines rather than hanging, which releases the serial queue for the next candidate.
- `src/mcp-gateway.ts` — the first real `CapabilityGateway`: executes an approved plan through a connected MCP client (`@modelcontextprotocol/sdk`). It does no planning. Its only remaining judgment is re-resolving the plan's canonical paths immediately before the call, which catches a symlink swapped in after approval — and it may only *verify* the plan it was given, never correct it. A protocol error (`isError`) is a `failed` result; a thrown call is rethrown, because only the dispatcher may decide what an unknown outcome means.
- `src/watch-actions.ts` — wires the action half of the closed loop into both watch entry points. `resolveWatchActions` validates every variable — including `SQUID_SEARCH_EGRESS` — before opening the stdio MCP client, so a typo fails startup instead of surfacing once a server is running. `dispatchTopCandidate` considers only the top-confidence candidate: falling back to a lower one when the best is refused would mean quietly doing something the ranking did not choose. A late trigger is refused before any planning work.
- `src/fake-prediction-provider.ts` — controllable `PredictionProvider` for tests and offline evaluation.
- `src/pi-runtime.ts` — Pi adapter that implements `PredictionProvider`, requests one typed prediction via a terminating custom tool, respects `AbortSignal`, derives `expiresAt` per kind, and reports model reachability via `checkAvailability()`. Isolated behind an adapter so Node/RPC remains a fallback if deeper Bun incompatibilities appear.
- `src/squid-core.ts` — orchestrates event ingestion, state reduction, and baseline prediction.
- `src/main.ts` — demo entry point.

## Persistence

Three `EventStore` implementations satisfy one contract. `all()` returns every appended event exactly once, but **return order is not part of the contract** — callers that need a timeline apply `orderActivityEvents`, which is total on events with distinct `eventId`s. `since()` compares epoch milliseconds on both sides, so timezone spellings of the same instant are equal.

`SqliteEventStore` stores the full event as JSON and rehydrates every read through `parseActivityEvent`, so `ingestedAt`, `correlationId`, and sub-millisecond `occurredAt` spellings survive a round trip. Its scalar columns are a lossy projection kept for filtering and integrity only. A primary key on `eventId` and a unique index mirroring source-local event identity make duplicates a structural error rather than a convention: both raise `EventStoreConstraintError`. That is deliberately one error type rather than two, because a row violating both constraints reports only the identity index's `UNIQUE` violation — the error code cannot tell "same event twice" from "identity reused by a different event".

`journal_mode = WAL` with `synchronous = NORMAL` means committed events survive process death without an explicit checkpoint. They are **not** guaranteed to survive OS or power loss — that would need `synchronous = FULL`.

`JsonlEventStore` has no production caller; `JsonlPredictionLedger` likewise, now that SQLite covers durable prediction recording. Both are kept because they exercise the contracts under a different failure model — partial line writes and crash-tail repair — which the SQLite implementations never encounter.

`watch-files.ts` uses `SqliteEventStore` when `SQUID_DB` names an absolute path, and `InMemoryEventStore` otherwise. It calls `restore()` before observing, so a restart rebuilds the dedupe index and projection from history instead of re-ingesting it. `main.ts` is a demo and stays in memory.

A database inside the watched root would feed its own writes back into the timeline: each append updates `-wal`, the watcher reports that write, and ingesting it appends again. `sqliteWatchExclusions` returns the root-relative paths of the database and its two WAL sidecars so the watcher skips them; it returns nothing when the database lives outside the root, so an unrelated sibling path can never be excluded by accident.

## Prediction ledger persistence

Three `PredictionLedger` implementations satisfy one contract, verified by a shared conformance suite (`tests/prediction-ledger-conformance.ts`): in-memory, JSONL, and SQLite. Unlike `EventStore`, **return order is part of this contract** — `all()` returns records in append order, because a decision log's value is the sequence in which decisions and their feedback arrived. `SqlitePredictionLedger` orders by an autoincrement `seq` rather than a timestamp, since two records can share a timestamp but not an append position.

The reason to prefer SQLite over JSONL is that the invariants become structural. The in-memory index checks them procedurally, and JSONL inherits that index; the SQLite schema declares them:

- `ledger_records.record_id UNIQUE` — one record per ID.
- `ledger_candidates.candidate_id PRIMARY KEY` — a candidate ID is globally unique, so two requests cannot claim the same candidate. Since the ID is `requestId:candidate:ordinal`, this also makes the `(request_id, ordinal)` pair unique within a request.
- `ledger_records_one_attempt_per_request` partial unique index on `(request_id) WHERE record_type = 'attempt'` — one attempt per request, even when a second carries a different `recordId`.
- `candidate_id REFERENCES ledger_candidates` — feedback cannot reference a candidate that was never recorded.

A process-local index forgets these on restart; the schema does not. A reopened database still rejects a duplicate attempt.

Attempt and candidate rows are written in one transaction, because an attempt and its candidates are a single fact: a partial write would leave an attempt that looks complete while its candidates are unaddressable. Ownership is checked before insert rather than left to the foreign key, since the key proves a candidate exists but not that it belongs to the asserting request — those are different errors (`PredictionLedgerReferenceError` versus `PredictionLedgerConflictError`).

`record_json` is authoritative and every read rehydrates through `parsePredictionLedgerRecord`, so optional fields and sub-millisecond timestamp spellings survive a round trip. Scalar columns are a lossy projection kept for integrity and filtering.

`watch-files.ts` attaches a ledger on the same durability switch as the event store: `SQUID_DB` also selects `<SQUID_DB>.ledger.db`, otherwise both stay in memory. The ledger is a sibling database rather than a table in the event database so replaying the timeline never contends with prediction writes; it gets the same watch exclusions, since a second SQLite file in the tree would otherwise feed its own WAL writes back into the timeline.

## Episode projection

Episodes are a deterministic projection over Chronicle events, not data stamped into immutable history. A gap of five minutes or more starts a new episode. The derived ID uses the first event's timestamp and event ID, so the same timeline produces the same episodes and can be re-segmented later without a storage migration. `correlationId` remains unused by this rule.

Opening an episode clears inferred interaction context: foreground application/window, focus text, browser page, command outcome, recent files, and recent semantic actions. The boundary event can immediately re-establish fields it authoritatively carries. This avoids both stale values and contradictory combinations such as a newly activated application paired with the previous application's window. It also bounds the JSON context passed to Pi and prevents an old save or text prefix from generating a suggestion hours later; it does not replace LLM reasoning or add a second inference system.

## Pi integration boundary

`PiRuntime` is optional. It implements the `PredictionProvider` interface and uses `@earendil-works/pi-coding-agent` with a terminating structured-output tool (`emit_prediction`). The model provider is configured via `PI_MODEL_PROVIDER` (default `bifrost`) and `PI_MODEL_ID` (default `deepseek-v4-flash`).

`PredictionCoordinator` wraps any `PredictionProvider` with a hard timeout (default 15 seconds), one-in-flight concurrency (new requests cancel old ones), and an automatic fallback to `HeuristicPredictor` when the provider fails, times out, or is cancelled. Outcomes are published exactly once via an `onOutcome` callback for shadow-mode logging.

The model no longer sets `expiresAt`; Squid derives it per kind (`draft_completion`: 30s, `run_tests`: 60s, `inspect_error`: 120s, `search_selection`: 30s, `none`: 10s) so context-bound suggestions expire on a schedule that matches their semantic freshness window.

If the model provider is unreachable, the baseline predictor continues to function. Pi is not the source of truth for timeline or memory — the event store and world-state reducer are.

`PiRuntime` has been measured and does not currently clear the replay gate; see [Provider gate](#provider-gate). It is wired as a `PredictionProvider` and can be evaluated, but it is not eligible for a real-time path — so it is not the default one.

### Selecting the live provider

`SQUID_PROVIDER` chooses the primary provider for a live watch run. Absent or `heuristic` is the default and is exactly the behavior that existed before a model was selectable: no probe, no gate, no network, no model — the Pi module graph is not even imported, which is worth about 650ms of startup on the machine this was measured on.

```bash
SQUID_PROVIDER=pi bun run watch:files -- /absolute/project/root                        # admit on reachability
SQUID_PROVIDER=pi SQUID_PROVIDER_GATE=replay bun run watch:screen                      # admit only on a gate pass
SQUID_PROVIDER=cognition SQUID_PROVIDER_GATE=replay bun run watch:desktop              # belief-backed, gated
```

`SQUID_PROVIDER_GATE` picks the admission check. The default `probe` resolves the model once via `PiRuntime.checkAvailability()` — fast, and enough to tell an outage apart from a bad prediction. `replay` instead runs the same `runProviderGate` that `bun run gate:pi` runs, at startup, and admits the model only on `passed`. A `skipped` gate declines, because an unreachable or unevaluated model must not reach the real-time path just because nothing measured a regression against it.

`cognition` selects the belief-backed path described under [Beliefs and cognition](#beliefs-and-cognition). It has no probe branch, and the asymmetry is deliberate: reachability is the question worth asking about an out-of-process model, but a cognition provider reorders candidates the heuristic already produced, so it is always reachable and a probe would admit every one of them while measuring nothing. The semantic gate therefore runs in both modes; what `SQUID_PROVIDER_GATE` decides is only whether a pass earns dispatch trust. Under `probe` an admitted cognition provider stays `suggestion_only`, so nothing it proposes can be dispatched — `src/action-admission.ts` refuses a claim unless both the attempt and the runtime are trusted, which is why a provider cannot grant itself what the selector withholds.

Whenever the model is declined, the run continues on the heuristic and prints the reason. Silence would be the real failure: a run started with `SQUID_PROVIDER=pi` that quietly predicts with the heuristic looks identical to one where the model is working. Independently of this choice, `PredictionCoordinator` keeps its own heuristic fallback, so a model admitted at startup that then fails, times out, or is cancelled still lands somewhere.

`selectPredictionProvider` takes every model seam by injection and imports no model runtime, so its behavior is unit-tested offline; its options are a union in which the heuristic mode has no seam to a model at all, so the default's isolation is a property of the type. `watch-provider.ts` holds the real Pi and gate wiring both entry points share, and imports it lazily inside the `pi` branch only.

## Provider context policy

A `ContextPolicy` projects world state before it reaches a prediction provider. This is an **egress** boundary, not a storage rule: the event store and the prediction ledger keep full fidelity, and the in-process heuristic fallback keeps reading unprojected state, so redacting what an out-of-process model sees never degrades local prediction.

`PassthroughContextPolicy` is the coordinator default, so attaching a provider never silently changes what it already received — choosing to redact is an explicit decision at the call site.

`RedactingContextPolicy` narrows on a content-versus-shape distinction. Content is dropped or capped; shape is kept, because shape is what a predictor reasons over.

| Field | Projected to | Kept |
| --- | --- | --- |
| Window titles (`activeWindow.title`, `focus.windowTitle`) | `[redacted]` | that a window is focused, and its `applicationId` |
| Browser page | `origin + pathname`; title redacted | `host`; query strings, fragments, and userinfo dropped, since that is where session tokens ride |
| `recentFiles`, action targets | basename | filename and extension |
| Focus text | capped at `maxTextLength` (default 512) | `role`, `language`; labels redacted |
| Episode, `lastEventKind`, timestamps | unchanged | carries no user content |

Prefix is capped from its tail and suffix from its head, so the characters nearest the cursor — the ones a completion actually depends on — are the ones retained.

Only `http`/`https` URLs keep a path. Other schemes parse successfully but put their payload where a path would be — `data:` inlines the document, `blob:` carries an opaque capability token, `file:` an absolute local path — so they degrade to `host`, as does a value that does not parse at all. Keeping a parseable non-web URL's "path" would leak precisely what the policy exists to withhold.

The typed `RedactableContextField` allow-list re-enables a field explicitly; making it a union rather than a string means an allow-list entry cannot quietly stop matching after a rename. A policy that throws denies egress: the coordinator reports a `context_policy_failed` diagnostic and answers from the local fallback instead of falling back to raw state.

## Beliefs and cognition

A prediction answers "what action might help now". A belief answers "what is going on" — longer-lived, and reusable across several predictions. Splitting them is what lets a belief be evaluated for *stability* on its own, which is the property the existing predictor path measurably lacks.

A `BeliefProvider` (`src/belief-provider.ts`) receives already-projected state and returns a `BeliefStateBatch`. The contract is fail-closed and narrow by design: a belief carries an intent value from a closed vocabulary, a confidence, and the event IDs it was inferred from — no command, no tool name, no free-form text, and no reference to another belief. `HeuristicBeliefProvider` is the shipped baseline: four deterministic rules over facts the projection already holds, each naming the events it read.

Every batch is validated against the request it answered, by `validateBatchAgainstRequest`:

| Check | Refusal | Why |
| --- | --- | --- |
| Schema, bounds, TTL | `batch_invalid` | An untrusted producer must not turn a batch into a data sink |
| `episodeId` | `episode_mismatch` | Beliefs never cross episodes |
| `stateDigest` | `state_digest_mismatch` | A belief about a world that has moved is worse than no belief |
| `projectionGeneration` | `projection_generation_mismatch` | Same, for a superseded projection |
| `contextPolicyId` | `context_policy_mismatch` | The same world redacted differently is a different input |
| Evidence event IDs | rejected batch | A belief citing an unknown event cannot be audited |

Evidence is checked against `evidenceTimeline(state)` (`src/belief-evidence.ts`), derived from the *projected* state the provider was shown rather than from the event store. A provider can only cite what it could see, so an ID outside that map is either a hallucination or a reference to something the policy withheld. Redaction narrows content, not provenance, so the citable set is identical before and after projection — otherwise the belief layer would be dead in exactly the configuration the model path runs under.

`createBeliefResolver` (`src/belief-resolver.ts`) is the live-path adapter: it builds a `BeliefRequest` from the projection identity a `PredictionRequest` carries, asks the provider, validates, and resolves to `null` on any failure. Validation time is the *state's* time, not the wall clock — every belief is inferred at `triggeredAt` and expires a bounded interval after it, so checking against "now" would reject every batch during a replay and the gate would end up admitting a provider that had never once been given a belief.

The projection identity is threaded from `PredictionRuntime` through `PredictionCoordinator.request(state, projection)` as an optional field. Optional rather than required precisely so no caller is ever forced to invent a digest: a fabricated one would let a batch about a world that never existed validate. A request without it gets no beliefs and still gets a prediction.

`BeliefRerankCognition` (`src/belief-rerank-cognition.ts`) is the shipped `CognitionProvider`. It reorders candidates by the intent the beliefs assert, and it cannot invent one — a belief carries no parameters, so there is nothing to build an action out of, and re-ranking is the whole of its authority. Every candidate it emits was already admissible before it ran. A fully-confident belief may add at most 0.25 to a candidate's confidence: enough to overturn a close ranking, not enough to overturn a wide gap the heuristic scored on evidence the belief layer does not have. Beliefs may be absent, in which case it returns exactly the heuristic's ranking — cognition-from-state is a correct answer, not a degraded one.

`sourceEventIds` are passed through untouched. Admission and the ledger read them to decide whether the world has moved since a candidate was formed, so a cognition layer that rewrote them would be editing the audit trail rather than the ranking.

### Semantic gate

`runSemanticGate` (`src/semantic-gate.ts`) is what a cognition path must clear before it can reach a real-time action. It runs `runProviderGate` for ranking, then measures determinism directly: the same scenarios, three times, comparing the top candidate per cut point. `minTop1Stability` defaults to 1 — exactly reproducible.

That second dimension is not decoration. The documented reason `PiRuntime` fails today is that it gives different answers for the same world state, and a ranking score averages that away: a provider can post an acceptable mean while being unusable, because a suggestion that appears only half the time reads as a malfunction rather than as a feature. The gate compares the *kind* rather than the whole candidate, since parameters legitimately carry text that varies and a rationale is prose; what has to be reproducible is which action gets proposed. An empty list is itself an answer — "propose nothing" — and must be reproducible too.

`BeliefRerankCognition` passes both dimensions on the current fifteen-point corpus: top-1 at parity with the baseline, zero fallbacks, and 15/15 stable across three replays. It is deterministic by construction — pure arithmetic over the batch, a stable sort, and an explicit ordinal tie-break rather than reliance on sort stability.

### Shadow mode

`SQUID_SHADOW_COGNITION=on` runs the cognition path beside the live one, records what it would have done, and dispatches nothing.

```bash
SQUID_SHADOW_COGNITION=on bun run watch:desktop
bun run ledger:report -- /absolute/path.db.ledger.db
```

A gate scores a fixed corpus; shadow mode scores the user's actual days, which is where the corpus is wrong. What makes it safe to leave on is that the shadow path cannot cause anything, for three independent reasons:

- **An unreachable request ID.** `claimDispatch` finds an attempt by `record.requestId === plan.attemptId`, and a plan's `attemptId` is a live request ID. A shadow record's ID carries a `:shadow` suffix, so no claim will ever ask for it. This is structural, not a flag someone remembered to check.
- **`actionTrust: "suggestion_only"`,** whatever the live run was configured with. `src/action-admission.ts` refuses a claim unless both the attempt and the runtime are trusted.
- **No dispatcher.** `ShadowCognitionRunner` holds no gateway and no confirmation surface.

Shadow runs are never awaited, so a shadow failure cannot delay or fail a real prediction, and the state handed to them is re-projected through the same `ContextPolicy` the live provider saw — passing raw state instead would hand the belief layer fields the policy withheld while still claiming that policy's ID.

Shadow attempts share the live record's `triggerEventId` deliberately. Retention deletion removes ledger records by trigger event, so shifting it would leave shadow records behind after the event they describe was deleted — an attempt pointing at history that no longer exists.

`bun run ledger:report` splits the two. Top-level figures remain the live path alone, so a report from before shadow mode existed is comparing the same quantity; `paths.live` and `paths.shadow` break both out. Each shadow record's `fallbackReason` carries `beliefs=<status>`, because "ran with beliefs" and "ran without them" are different providers in effect and a report that conflated them would average over two populations.

```
paths.shadow.byProvider  →  { "shadow:belief-rerank": 12 }
paths.live.byProvider    →  { "heuristic": 12 }
```

Stdout carries counts and kinds only — belief values are a closed vocabulary and candidate kinds are an enum, so a shadow log line cannot echo a selection or a path.

## Activity sources

Every capture adapter implements `ActivitySource` (`src/activity-source.ts`): `start(emit)` begins observation, `stop()` drains buffered events and resolves once quiet. Sources never touch the event store or projection directly — they only hand validated events to the emitter, so ingestion, ordering, and idempotency stay owned by the Chronicle core.

`FilesystemActivitySource` is the first real source. It watches one explicitly configured absolute root and emits `file_opened` for a newly seen path and `file_saved` for subsequent writes. Paths are reported root-relative with POSIX separators so a timeline stays replayable on another machine. `.git/`, `node_modules/`, `dist/`, `build/`, `.cache/`, and `.DS_Store` are excluded by default; a caller-supplied `include` predicate can narrow further but cannot widen past those defaults. Repeated notifications for the same path coalesce within a debounce window, and deliveries are serialized so per-source sequence order is stable even when the emitter is slow.

The source reports a path, not an application, so every payload carries `applicationId: "filesystem"`. Attributing a write to the editor that made it needs a future IDE or native source; the `filesystem-save-run-tests` fixture shows the two contexts combining through the projection rather than being guessed by one source.

Watcher, probe, and delivery failures are recorded as diagnostics instead of thrown from async listeners, so one bad path cannot kill the watch.

Each instance defaults to a fresh `sessionId`. `sequence` restarts at `0` for every instance, so the session is the part of the source-local identity tuple that has to change; a constant default would make every run re-emit `(filesystem, filesystem-local, <session>, 0)` and collide with its own history in any store that enforces that identity.

```bash
bun run watch:files -- /absolute/project/root
SQUID_DB=/absolute/path/events.db bun run watch:files -- /absolute/project/root
```

File contents are never read; only paths, kinds, and timestamps enter the timeline.

### Foreground window text

`ScreenTextActivitySource` is the accessibility source. It is deliberately split in two: a `ScreenTextReaderFactory` backend that samples the foreground window, and an adapter that turns those samples into protocol events. The adapter imports no backend, and the backend knows nothing about events — so a future OCR reader or Windows UI Automation reader is one new factory and zero adapter changes. The entry point picks the backend, which is why `readerFactory` is required rather than defaulted: there is no platform-neutral way to read foreground text, and a default would have to couple the adapter to concrete backends.

A backend reports a neutral `ScreenTextFrame` in which every field is optional, and absence carries meaning: a missing field is something the backend could not read, a present-but-empty one is something it read as empty. The adapter projects one frame onto up to four events in reducer order — `application_activated`, `window_changed`, `focus_changed`, `text_context_changed` — under `source.kind: "host"`, with no protocol change. Each event carries the sample's timestamp, so `sequence` is what orders them.

The payload is the dedupe key: an event is emitted only when it would differ from the last one emitted for its kind. Backends sample on a cadence, so without that every tick would re-emit an unchanged desktop. `window_changed` needs a title the frame actually carries; `focus_changed` is unconditional once an application is identified, because a focused element with unreadable attributes is still a focus fact, and its `windowTitle` is included in the comparison since `text_context_changed` carries that field forward in the reducer. `text_context_changed` is skipped entirely for a frame with no `textContext` — synthesizing empty caret context would erase real state. A frame with no application id yields nothing at all. Frames also pass through a debounce window that keeps only the last frame, so a bursty backend cannot outrun the diff.

Reader and delivery failures become diagnostics rather than thrown from async listeners, reusing the existing `watcher_error` / `delivery_error` kinds. A rejected event does not suppress the other facts observed in the same sample, and its payload is not recorded as emitted — so the next unchanged frame retries it. Each instance defaults to a fresh `sessionId` for the same identity reason as the filesystem source.

Frames are emitted raw: this source states what it observed, and credential redaction happens downstream at the capture boundary in `PredictionRuntime`.

```bash
bun run watch:screen                                    # built-in demo script
bun run watch:screen -- frames.json                     # scripted frames
SQUID_SCREEN_READER=darwin bun run watch:screen         # real macOS accessibility
SQUID_SCREEN_POLL_MS=500 bun run watch:screen           # sampling cadence
```

The macOS backend is real but not verifiable here: it needs a darwin host with an accessibility grant, so the seam and the adapter are tested through a fake reader and the backend is checked by hand — the same posture as the SQLite conformance suite, which tests the contract rather than the operating system. Its honest scope: `osascript` exposes no stable caret position, so `prefix`/`suffix` stay empty and text context is reported only when the user has a selection. It also cannot distinguish "the title query failed" from "the window has no title", so an empty title is treated as unreadable.

### Dispatching actions

Both watch entry points can close the loop from prediction to action. With `SQUID_ACTIONS=mcp` and an MCP server command, each settled prediction's single top-confidence candidate is considered — never a lower-confidence fallback, and never a candidate from a late-arriving event. Search additionally requires `SQUID_SEARCH_EGRESS=allow`, since it sends selected text off the machine; local test execution requires confirmation, asked either in the terminal or in a native window. The plan, the user's decision, the claim, and the terminal outcome are written to the same ledger as the prediction attempt, as digests rather than raw text.

```bash
# Search needs explicit consent to send selected text off the machine.
SQUID_ACTIONS=mcp SQUID_SEARCH_EGRESS=allow \
SQUID_ACTIONS_MCP_COMMAND="bun run /path/to/mcp-server.ts" bun run watch:screen -- frames.json

# Also allow run_tests after showing the exact command and receiving y/yes.
SQUID_ACTIONS=mcp \
SQUID_ACTIONS_MCP_COMMAND='bun run "/path with spaces/mcp-server.ts"' \
SQUID_ACTION_CONFIRM=terminal \
SQUID_ACTION_CONFIRM_TIMEOUT_MS=30000 \
bun run watch:files -- /absolute/project/root

# Same gate, asked in a native window instead of the terminal.
SQUID_ACTIONS=mcp \
SQUID_ACTIONS_MCP_COMMAND='bun run /path/to/mcp-server.ts' \
SQUID_ACTION_CONFIRM=graphical \
SQUID_GRAPHICAL_UI_COMMAND=/path/to/squid/ui/target/release/squid-ui \
bun run watch:desktop -- /absolute/project/root
```

Absent variables mean actions stay off — identical to the pre-dispatch behavior. `SQUID_SEARCH_EGRESS` has exactly three outcomes: unset denies search egress, the exact string `allow` permits it, and any other value is a startup configuration error rather than a silent fallback. Without `SQUID_ACTION_CONFIRM`, `run_tests` is still skipped even when ranked highest.

`SQUID_ACTION_CONFIRM` selects the surface, not the rules. `terminal` accepts only `y` or `yes`; `graphical` opens the native window from `ui/` and accepts only a click on Approve. Everything else refuses in both and records the reason: any other answer, timeout, shutdown, an expired candidate, a surface that cannot be reached at all (no TTY, or no UI binary), and a surface that dies mid-question. Expiry is checked before prompting and again after acceptance, so a candidate that goes stale while the question sits on screen is refused after the click.

`SQUID_ACTION_CONFIRM_TIMEOUT_MS` belongs to the engine rather than to either surface and requires `SQUID_ACTION_CONFIRM`. `SQUID_GRAPHICAL_UI_COMMAND` is required by — and only accepted with — `SQUID_ACTION_CONFIRM=graphical`; it is parsed into an executable plus literal arguments under the same no-shell rule as the MCP command. Build the binary it names with `cargo build --release` in `ui/`.

`watch:desktop` and `watch:files` execute tests from the canonical watched root; `watch:screen` uses its launch directory. `SQUID_ACTION_WORKDIR=/absolute/path` overrides either. The predicted path must remain inside that root. The MCP server command is parsed into an executable plus literal arguments and launched directly, never through a shell: quoted spaces are supported, while variables, substitutions, pipes, redirects, comments, and globs are rejected. This protects server startup configuration separately from the deliberately shell-shaped `run_command` string sent to the MCP server.

### Which entry point can admit which action

An admission rule reads the *whole* projection, so what a run can do depends on which facts its sources produce. `watch:files` emits `file_opened` / `file_saved`; `watch:screen` emits `application_activated`, `window_changed`, `focus_changed`, `text_context_changed`; a browser source emits `browser_navigated`. No single source satisfies either action — that is why `watch:desktop` exists.

| Entry point | Sources | `search_selection` | `run_tests` |
| --- | --- | --- | --- |
| `watch:files` | filesystem | no foreground or selection facts | no `activeApplication` |
| `watch:screen` | screen text | no browser page | no `file_saved` |
| `watch:desktop` | filesystem + screen text | no browser page | both facts present; owner still unattributed |
| `watch:desktop` with `SQUID_BROWSER=synthetic` | + browser page | **dispatches**, with `SQUID_SEARCH_EGRESS=allow` | unchanged |

`inspect_error` is a third action, available with `SQUID_TERMINAL=fifo`. It re-runs the failed check so its output is in front of the user, and the mapping is deliberately narrow because the captured fact is: `TerminalCommandCompletedPayload` holds a class, a flag, and an exit code — no command text, no output, no working directory — so "show me the failing output" cannot be served from history. Opening the file at the failing line would need a line number nothing captured, and re-running with more verbosity would need the original command. Only `test`, `lint`, and `typecheck` are re-runnable; `install` touches the network and a lockfile, `vcs` rewrites history, `container` can deploy, and `other` is unknown, so a failed `kubectl apply` can never propose running itself again. Admission additionally refuses once the command has *succeeded*: a user who fixes the problem before confirming should not then have the old failure's re-run executed.

```bash
# Terminal observation, with a shell hook appending to the path.
SQUID_TERMINAL=fifo SQUID_TERMINAL_FIFO=/absolute/path/commands.jsonl \
SQUID_ACTIONS=mcp SQUID_ACTION_CONFIRM=terminal \
SQUID_ACTIONS_MCP_COMMAND="bun run /path/to/mcp-server.ts" \
bun run watch:desktop -- /absolute/project/root
```

Browser observation is opt-in rather than on by default. It is the capability that makes search reachable, and search is the one action that sends user text off the machine, so a run gets it by asking. Egress stays a separate decision: `SQUID_BROWSER` lets Squid *see* a page, `SQUID_SEARCH_EGRESS=allow` lets it *send* text, and both are required.

```bash
# Search end to end: observe pages, allow egress, and give it a tool to call.
SQUID_BROWSER=synthetic SQUID_SEARCH_EGRESS=allow SQUID_ACTIONS=mcp \
SQUID_ACTIONS_MCP_COMMAND="bun run /path/to/mcp-server.ts" \
bun run watch:desktop -- /absolute/project/root

# Scripted pages instead of the built-in demo (third positional argument).
SQUID_BROWSER=synthetic bun run watch:desktop -- /absolute/project/root frames.json pages.json
```

`SQUID_BROWSER` has the same three outcomes as `SQUID_SEARCH_EGRESS`: unset means no browser source, exactly `synthetic` or exactly `darwin` selects a backend, and anything else is a startup configuration error. `synthetic` replays scripted pages; `darwin` reads the foreground browser's active-tab URL through the macOS accessibility channel — no extension, no restart, no debug port — covering Chromium browsers and Safari (Firefox exposes neither an AppleScript nor an accessibility URL and stays quiet). `darwin` is refused at startup off macOS, like the screen reader's equivalent. `SQUID_BROWSER_POLL_MS` sets the sampling cadence for both backends.

The darwin backend is not testable in CI — it needs a Mac with automation grants, which macOS prompts for once per browser. Its parser is unit-tested; verify the subprocess half by hand:

```bash
SQUID_BROWSER=darwin bun run watch:desktop -- /absolute/project/root
```

One gap remains, and it is an honest refusal rather than a bug in the check:

- **A filesystem save has no owner.** `FilesystemActivitySource` reports `applicationId: null` because a path-only watcher cannot know which process performed a write, and `admitRunTests` requires the save's owner to *equal* the foreground application. Treating an unattributed save as the foreground application's work would authorize running tests on a file written by a background formatter — the `filesystem-save-run-tests` fixture asserts `none` for exactly this case. Closing it needs a source that knows what it saved.

A note on the synthetic demos: the screen and browser readers run on independent timers, so their interleaving is not fixed. The search rule requires the selection to be observed *after* the page, and whether that ordering falls out of a given demo run is a race. The demos show that a page becomes observable and is correctly attributed to a window; the end-to-end guarantee is pinned deterministically by `tests/browser-search-admission.test.ts`, which drives the real source in the order a live desktop produces.

### Editor-attributed saves

The unattributed-save gap above has a real closure now, without touching `admitRunTests`'s equality check or `FilesystemActivitySource`'s honest `null`: an editor can speak for itself. `SQUID_EDITOR_SAVES=fifo` starts a source that reads save reports an editor extension appends to a file — one JSON object per line:

```json
{"path":"/home/me/proj/src/a.ts","pid":12345}
```

`pid` is the *editor's own* `process.pid`, and the macOS screen reader already reports the foreground application's unix pid as its `applicationId`. The pairing is plain equality — no translation layer — so a save written by the editor in front is admitted by the same check that refuses one written by anything else while another editor is in front. A watcher's `null` owner stays refused; ownership comes from whoever actually knows it.

```bash
SQUID_EDITOR_SAVES=fifo SQUID_EDITOR_FIFO=/absolute/path/saves.fifo \
  bun run watch:desktop -- /absolute/project/root
```

A VS Code extension that feeds it (from `extension.js`):

```js
const fifo = process.env.SQUID_EDITOR_FIFO;
if (fifo) workspace.onDidSaveTextDocument((document) => {
  require("fs").appendFile(fifo, JSON.stringify({
    path: document.uri.fsPath,
    pid: process.pid,
  }) + "\n", () => undefined);
});
```

One admission heuristic moved from ids to names to make real runs possible at all: "is this a coding application" is now decided on the application's *name*, never its id. On macOS the id is a bare unix pid ("4242"), which cannot carry the signal — matching on it made every live run fail regardless of what was in front. Ownership equality still compares ids exactly as before; only the kind-of-application question changed, and it changed toward the field that actually describes what an application is.

### Capture policy: exclusion, pause, and retention

Capture is irreversible by design — once an event is ingested it is history — so both user-facing controls act at the ingress boundary, before the store.

**Per-application exclusion.** `SQUID_EXCLUDE` names applications as a comma-separated list (`SQUID_EXCLUDE=1Password,Banking`). A matched event is dropped outright: not redacted, *absent* — even the structural fact that something happened would recreate the record being hidden, so the timeline shows a plain gap where excluded activity was, and diagnostics report counts only. Matching is case-insensitive against the application **name**, never the platform id (on macOS a pid no user can write a rule against). Exclusion composes with redaction rather than replacing it: `ExcludingCapturePolicy` wraps `RedactingCapturePolicy`, so every kept event is still redacted exactly as before and no bypass can appear by construction. A malformed list (an empty entry) fails startup rather than falling back to capturing everything — capture is the one boundary that cannot undo.

**Pause.** `SQUID_CONTROL=fifo SQUID_CONTROL_FIFO=/absolute/path` starts the gate source. A shell alias appends one JSON command per line:

```sh
squid-pause()  { echo '{"op":"pause"}'  >> "$SQUID_CONTROL_FIFO"; }
squid-resume() { echo '{"op":"resume"}' >> "$SQUID_CONTROL_FIFO"; }
```

Each command becomes a durable `capture_gate_changed` event in the timeline, and the projection keeps the last gate position in `WorldState.captureGate` — global across episodes, so a pause that outlives the episode gap still reads as paused after it. That event is what makes a deliberate gap distinguishable from an idle machine; without it, silence between two stretches of activity is ambiguous and any later analysis reads it wrong. An unknown or malformed command is refused with a diagnostic that names nothing but the failure itself.

**Retention and range deletion.** `SQUID_RETENTION_HOURS=72` bounds how long history stays: at every watch-session startup everything at or before *now − 72h* is deleted — events first, then every ledger record whose trigger event was lost (attempts, feedback, plans, decisions), so no record survives without its anchor. The startup banner reports the bound (`retention`) and what that pass removed (`prunedEvents`, `prunedRecords`). The prune runs once per process start, not on a timer: a long-running session must not delete under the user's feet mid-episode; the next restart catches up. For a deliberate one-off ("delete everything between lunch and dinner"), `bun run history:delete -- /absolute/events.db <from> <until>` removes the same range through the same closure logic, refusing an inverted or unparseable range before it opens any file.

Deletion is truncation, not tombstones: removed events leave no marker behind, because a tombstone keeps every byte it claims to delete. The ledger closure is computed *after* the event deletion commits, by diffing attempts' trigger ids against surviving events — no second copy of "which events existed" exists anywhere. Failure direction matters: if the ledger half fails, fewer events remain but the ledger stays self-contained until the next pass; over-retention waits, under-retention cannot be undone. All three controls share one posture: unset means off, a valid value means exactly what it says, and anything malformed (`0`, `-3`, `2.5`, `"soon"`, whitespace) fails startup naming the variable — never a silent fallback on the boundary that cannot undo.

## Replay evaluation

`bun run evaluate` runs the heuristic predictor against the versioned synthetic scenarios in `src/evaluation-fixtures.ts` and prints a deterministic JSON report.

Each cut point replays only the canonical events available at that point; later events are excluded so the report cannot receive future-state leakage. A fresh predictor instance is created per scenario, preventing model sessions or caches from leaking between unrelated timelines. The report includes Top-1/Top-3/Top-5 hit rates, mean reciprocal rank (MRR), prediction coverage, and no-action correctness. The fixtures include stale-context negatives across episode boundaries, a below-threshold continuation guard, and a workflow with multiple distinct cut points. Current scores describe only this intentionally small synthetic corpus; they are a regression baseline, not a claim about real-user accuracy.

### Provider gate

`bun run gate:pi` enforces the rule that a model-backed predictor must clear the replay runner before it enters a real-time path. It scores the candidate against the heuristic baseline on the same fixture version and exits non-zero on a regression.

Thresholds are floors relative to the baseline, not absolute quality claims. Top-1 and fallback rate each allow 0.09 slack — roughly one cut point on the original twelve-point corpus and still a deliberately tight bound on the current fifteen-point corpus. `none` correctness has zero slack: suggesting an action where none is warranted is the failure that makes an assistant feel broken.

**Skipped and failed are distinct.** An unreachable provider skips with a stated reason and exits 0, because an outage is not evidence about the model. Treating it as a pass is how an unevaluated predictor reaches production; treating it as a failure is how a config problem gets misread as a quality regression.

Reachability is a separate `probeAvailability` hook rather than a check on construction. `PiRuntime` builds fine and only discovers a missing model when its runtime promise settles, so probing the constructor would report every outage as a ranking failure. `PiRuntime.checkAvailability()` resolves the configured model and returns a reason or null; the gate runs it before spending a baseline run.

The gate also measures provider health, which the ranking report deliberately omits. Without it the gate would be trivially defeatable: the coordinator substitutes the heuristic on every provider failure, so a permanently broken model posts baseline-identical rankings. A wrapper counts answered versus fallen-back requests outside the coordinator, since the fallback erases the failure from the outcome the runner keeps. Timeouts count as fallbacks because a conforming provider rejects on abort.

**Current result: the Pi predictor does not pass.** Across five runs it failed every time. The earliest runs answered every request but scored below the baseline on both Top-1 and `none` correctness — the shape of a predictor that is too eager rather than too quiet: it proposes an action on negatives where the correct answer is `none`, including on stale context across an episode boundary. Later runs, on the fifteen-point fixture version, also lost requests to the 90-second timeout: the bifrost endpoint's time-to-first-byte varies from ~7s to over 35s per call, so a request that never settles counts as a fallback even though the model, queried directly, answers correctly on identical state.

Two distinct causes are now measured, and neither is fixed by lowering a threshold. The prompt was rewritten to encode the heuristic's four domain rules explicitly (an underspecified prompt made the model answer `none` everywhere), which lifted correctness but did not close the gap: given the same world state twice, the model still gives different answers, so ranking nondeterminism remains above the slack that admits normal variance.

Exact rates and the specific missed cut points differ per run, which is why they are not quoted here — the model is nondeterministic and any figure written down would be stale. Run `bun run gate:pi` for the current numbers. The verdict is what is stable: on this corpus `PiRuntime` is not eligible, so it is never the default live provider. `SQUID_PROVIDER=pi SQUID_PROVIDER_GATE=replay` runs this same gate at startup and declines on anything but a pass, which is what makes opting in safe rather than a bypass.

Any future Pi-backed predictor must be evaluated through the same replay runner and fixture version before it can enter a real-time path. The evaluation runner supports both sync (`evaluateScenarios`) and async (`evaluateWithProvider`) providers; async providers are isolated per scenario and run through `PredictionCoordinator`, so timeout and heuristic fallback behavior matches the real-time path. The ranking report describes the end-to-end runtime result and intentionally does not report provider health or fallback reasons.

## Testing

Tests use `bun:test`. The test suite covers:

- Runtime ActivityEvent validation and source-local sequence generation.
- Canonical event ordering and source-local event identity.
- Deterministic episode segmentation, inclusive gap boundaries, and episode-scoped context clearing.
- `SquidCore` ingestion, idempotency, conflict detection, canonical late-event re-projection, immutable snapshots, and deterministic restore.
- A shared `EventStore` conformance suite (`tests/event-store-conformance.ts`) run against all three implementations: round-trip fidelity, order-independent canonical ordering, mutation isolation, concurrent appends, and `since()` boundary and timezone equivalence.
- `JsonlEventStore` write recovery and interrupted-tail recovery.
- `SqliteEventStore` cross-connection durability under WAL, sub-millisecond timestamp fidelity, duplicate and identity-reuse rejection, parent-directory creation, post-`close()` rejection, and watch-exclusion paths for a database inside or outside the watched root.
- Pi prediction normalization, kind-specific expiry derivation, evidence provenance, and `PredictionProvider` interface conformance.
- `PredictionCoordinator`: success, timeout fallback, provider-failure fallback, old-request cancellation, stale-episode discard, explicit cancel, dispose, and idempotent no-op.
- `ContextPolicy`: passthrough fidelity and non-aliasing; redaction of window titles, URL query strings, fragments and userinfo, unparseable URLs, file paths, action targets, and focus labels; per-scheme degradation for `blob:`/`data:`/`file:`/`javascript:` URLs with a retained non-default port; cursor-anchored text capping; short text left untouched; preserved episode/event shape; per-field allow-list passthrough; input immutability and absence of shared nested objects. Coordinator wiring: the provider receives projected state, the default is passthrough, request identity survives projection, a throwing policy denies egress with a diagnostic, and the local fallback still runs on unprojected state.
- `PredictionRuntime`: non-blocking prediction dispatch after projection, duplicate suppression, supersession, restore, shutdown drain, and durable attempt recording when a ledger is attached — including the ordering guarantee that an outcome publishes only *after* its attempt write completes, the full schema-v2 metadata stamped from the ingest snapshot, and late-disposition attempts recorded as such. Ledger failures do not block prediction; shutdown waits for in-flight writes. `recordFeedback` appends feedback linked to a candidate by stable ID (the ledger validates the candidate exists and belongs to the request; a missing ledger throws).
- Prediction candidate identity and ledger: deterministic request-scoped IDs, append-only feedback, duplicate/conflict checks, restart recovery, and interrupted-tail handling.
- A shared `PredictionLedger` conformance suite (`tests/prediction-ledger-conformance.ts`) run against all three implementations: round-trip fidelity, optional-field presence and absence, append ordering, candidate-linked feedback, multiple feedback per candidate, idempotent re-append, duplicate-attempt and reference-error rejection, empty-candidate attempts, multi-candidate addressability, mutation isolation, and concurrent appends.
- `SqlitePredictionLedger`: cross-connection durability, schema-enforced conflict rejection surviving a reopen, transactional rollback leaving no partial attempt, post-`close()` rejection, idempotent close, parent-directory creation, and sub-millisecond timestamp fidelity.
- `CapabilityGateway`: fake-gateway outcomes, failure details, and thrown invocations; `CapabilityDispatcher` recording the plan, confirming, claiming, and invoking exactly once, never invoking on rejection or without a confirmation policy, recording a structured tool failure as terminal, reporting `reconciliation_required` (never `failed`) when the gateway throws after the claim, refusing a second dispatch of a claimed plan, refusing a plan whose attempt never persisted, and keeping raw command text out of the ledger.
- Action plan and admission: planner canonicalization through `realpath` (symlinked roots, targets that do not exist yet), traversal/absolute/control-character refusals, digest stability across key order, frozen plans, and the full admission refusal matrix — attempt, session, episode, digest, generation, late trigger, trust, policy, expiry, plus per-kind checks for selection identity, owner agreement, observation ordering, egress, coding application, and saved path.
- Plan dispatch state machine: claim refused before acceptance, claimed exactly once with an opaque token stored only as a hash, metadata divergence refused, completion only with the exact token, idempotent replay, conflicting outcomes refused, eight parallel claims yielding one winner, cross-restart reconciliation on a real SQLite file, system-side invalidation that never forges a user rejection, and dispatch-lifecycle kinds rejected at the feedback schema boundary.
- Action planning and confirmation: exact plan reuse between prompt and MCP execution, project-root confinement, shell argument quoting, `--` option termination, explicit yes/no behavior, fail-closed non-TTY/timeout/expiry/input-close/shutdown behavior, and serialized prompts.
- Both confirmation surfaces against one shared conformance suite (`tests/confirmation-surface-conformance.ts`), so the fail-closed matrix is proven per surface rather than per engine — a surface that only refuses correctly in the terminal is not a surface. Plus, per surface: that the graphical one sends `summary` and never `arguments`, re-checks availability on every ask instead of caching it, and forwards the engine's `close()` to its transport, which is the only thing that stops a spawned window from outliving the daemon.
- `createStdioGraphicalTransport` against a stub UI process, one per failure mode: answers passed through, a process that exits mid-question, garbage on stdout, a binary that does not exist, one kept-alive process serving a second prompt, an abort settling the pending ask and closing the window, and an answer whose `promptId` does not match being dropped rather than applied to the ask that replaced it.
- `ui/`: the wire parser under `cargo test`, including the cases a substring scan would fail — a `"kind":` appearing inside a `summary` value, a duplicate key trying to override the first, `\uXXXX` escapes and astral surrogate pairs, a lone surrogate, and a raw control character.
- `McpCapabilityGateway`: real MCP server over the in-memory transport — `selection`→`search_web({query})` and safe rooted `path`→`run_command({command})` mapping, unmapped kinds refused, candidates failing their tool contract refused before any call, MCP error results carrying the server's message, thrown handlers becoming failed outcomes, and schema-invalid arguments rejected by the server's own validation.
- Async evaluation: provider-based evaluation matching sync results, canned-provider scoring, hard timeout, and heuristic fallback.
- `runProviderGate`: baseline-equal pass, ranking regression failure, skip (not failure) for an unconstructable provider and for a lazily-resolved provider that reports itself unavailable without spending a baseline run, skip when the probe itself rejects, scoring when the probe reports available, failure for a provider that never answers despite baseline-equal ranking, timeouts counted as fallbacks, full health for a healthy provider, `none`-correctness failure for an over-eager provider, same-corpus comparison, custom slack, and default-threshold bounds.
- Deterministic replay evaluation: cut-point ranking, MRR, coverage, future-leakage guard, per-scenario predictor isolation, and report stability.
- `FilesystemActivitySource` root validation, lifecycle, default and caller filtering, path normalization, event mapping, debounce, ordering under a slow emitter, shutdown drain, diagnostics, distinct per-instance session identity, restart against one durable store without an identity collision, and end-to-end ingestion through `SquidCore`.
- `ScreenTextActivitySource` lifecycle, full-frame mapping to four host events, per-payload change detection (title-only, role-only, selection-only, and unchanged frames), degradation for missing application id / name / title / caret context, ordering and sequence under a slow emitter, burst collapsing, shutdown flush of the pending frame, reader and delivery diagnostics including retry of a rejected payload, recovery from a backend that fails to initialize, distinct per-instance session identity, and end-to-end ingestion through `SquidCore`.
- `selectPredictionProvider`: environment parsing and defaults, the heuristic path touching no model seam at all, probe admission on reachable / unreachable / rejecting probes, and replay admission on passed / failed / skipped / rejecting gates.
- `watch-actions`: config resolution (off when unset, config errors — including invalid `SQUID_SEARCH_EGRESS` — before any dependency is touched), literal stdio command parsing for each variable that holds one, and the dispatch loop end-to-end through the production chain built from real ingested events: search dispatched when egress allows, refused with zero tool calls when denied or when the selection changed, `run_tests` gated on confirmation and running the exact planned command, rejection recording a decision without a dispatch, expired candidates skipped, late triggers never dispatched, and no downgrade to a lower-confidence candidate when the top one is unmappable. The graphical mode's config rules are covered as errors rather than defaults: a missing UI command, a UI command given without the mode that uses it, one that would need a shell, and a mode with no working directory to canonicalize a plan against.
- `startWatchSession`: sources started in order and stopped in reverse, two independent sources projecting into one world state (with the save's owner still unattributed), one shared store/ledger/runtime across sources, the same diagnostic sink handed to every source, a session with no sources refused, already-started sources unwound when a later one fails, a malformed egress value refused before any source is constructed, every source named in the banner, idempotent stop, and one described line per ingested event.
- `resolveScreenReader`: synthetic default, unrecognized reader values refused rather than defaulted, the darwin backend refused off macOS, a non-positive or non-integer poll interval refused ahead of backend selection, scripted frame files read, and unreadable or non-array frame files reported as config errors.
- `BrowserPageActivitySource` and `projectBrowserFrame`: host derivation including a non-default port, absent title and owner collapsing to the protocol's neutral values, URLs with no origin refused (`data:`, `about:blank`, unparseable), owner copied rather than aliased, unchanged pages emitting nothing while a fragment or owner change emits, sequence numbers assigned only to emitted events, burst collapsing, pending-frame flush on stop, reader failures as diagnostics, a rejected event retried rather than deduped away, a non-object frame leaving the delivery tail usable, restartable failed start, distinct per-instance session identity, and end-to-end ingestion where the reducer correctly nulls an owner with no matching foreground.
- Search admission through the real browser source (`tests/browser-search-admission.test.ts`): a page the source produced reaching an actual `search_web` call with the selection intact, neither the selection nor the URL path appearing in the ledger, and refusals for denied egress, a page owned by another window, a page the backend could not attribute, a URL with no host, and a selection that changed after the prediction.
- `resolveBrowserReader`: off when unset, enabled only on the exact value, near-miss values refused as config errors, a bad poll interval refused, and an unused poll interval or absent frames file ignored when the source is off.
- `classifyCommand` and `TerminalCommandActivitySource`: every recognized class, unrecognized commands collapsing to `other`, the returned value always a member of the closed list whatever goes in, env-assignment prefixes seen past without their values being inspected, a class name later in the line not matching (`git commit -m "fix test"` is `vcs`), word boundaries so `gitk` is not `vcs`, the raw line absent from every emitted event including a `psql` URL with credentials, `succeeded` derived from the exit code, an unreadable exit code treated as failure, two identical failures emitted as two facts rather than deduped, sequence advancing only for emitted events, reader and delivery diagnostics, a non-object frame leaving the delivery tail usable, restartable failed start, and end-to-end ingestion producing exactly the two fields the `inspect_error` rule reads.
- `createFifoTerminalCommandReader`: relative paths refused at construction, one completion per line, a partial write held rather than parsed, a malformed line skipped without reporting its content, a missing exit code passed through as unknown, a not-yet-created file staying quiet, truncation restarting from the beginning, content written before start still read, and no delivery after close — including a read already in flight when close lands.
- `inspect_error` planning and admission: the project script for each re-runnable class, classes deliberately excluded (`install`, `vcs`, `container`, `other`, `build`) refused, unknown or non-string classes refused, an absolute resolvable workdir required, the canonical root quoted, digest stability, and admission refusing on a missing outcome, a succeeded command, a different failing class, and every general identity check.
- Retention: `resolveRetention` accepting only strict positive-integer spellings; cross-backend end-to-end prune (sqlite, jsonl+memory, in-memory) removing old events with their full dependent ledger closure while keeping fresh chains byte-intact and no-oping below the cutoff; and session wiring — a malformed `SQUID_RETENTION_HOURS` refused before any source starts, the bound and per-pass removals in the banner, and prune-before-restore observed through a replayed deleted id being accepted rather than deduped.

- Beliefs and cognition: batches produced from projections a real `SquidCore` built — not hand-written fixtures, since a fabricated digest would pass while the live path rejected every batch — and refused on each way a provider can misreport (digest, generation, policy, episode, unknown evidence); the resolver declining rather than inventing a projection identity, and reporting a quiet desktop as `none` rather than as a failure; re-ranking that promotes the action a confident belief supports while inventing no candidate the projection did not already offer; the semantic gate admitting the belief-backed path on both quality and determinism, refusing a provider that alternates its answer on identical state, and propagating an unreachable provider as skipped; and the cognition admission branch withholding dispatch trust under `probe`.
- Shadow mode: `resolveShadowCognition` accepting only the exact `on` spelling; observations separating nothing-to-assert from a belief outage from a rejected batch; a shadow attempt record coexisting with the live record for the same ingest, carrying `suggestion_only` trust and a request ID outside the namespace `claimDispatch` searches, and being removed together with the live record when its trigger event is deleted; the report splitting `paths.live` from `paths.shadow` while leaving the top level live-only; and end-to-end session wiring — both paths ledgered from one ingest, a malformed variable refused before any source starts, and stdout lines carrying only closed vocabularies.

Source tests inject a fake watcher, file probe, and screen-text reader, so they never depend on kernel watch timing, an accessibility API, or a subprocess. Session tests use scripted sources for the same reason: what is under test is the wiring, not any backend. Real-watcher behavior is verified by the `bun run watch:files` smoke run in the release gate, and multi-source ingestion by a `bun run watch:desktop` run against a temporary root; the macOS accessibility backends are verified by hand with `SQUID_SCREEN_READER=darwin bun run watch:screen` and `SQUID_BROWSER=darwin bun run watch:desktop`.

## What is not yet implemented

Tracked as issues; the entry-point table under [Dispatching actions](#which-entry-point-can-admit-which-action) shows which of these currently block an action.

- Screen keyframes, OCR, and full caret context. Foreground window text is implemented; pixels are not.
- A real browser backend. `BrowserPageActivitySource` and its contract exist and `search_selection` dispatches through them, but the only backend is the synthetic replay reader. A browser extension or CDP attachment is what turns that into observation of the user's actual browsing.
- IDE / LSP integration, so no source can attribute a file save to the editor that wrote it. `run_tests` has both required facts available in `watch:desktop` but the save's owner stays `null`, which admission correctly refuses.
- A surface for suggestions that never reach confirmation. The graphical window (`ui/`) shows a suggestion and takes its answer, but it only opens for a candidate that got as far as being confirmed. One refused at admission, or ranked below the top, leaves no trace on screen — only in the ledger. Whether it should is [issue #5's remaining open question](https://github.com/YoungSx/squid-desktop-assistant/issues/5).
- A capability mapping for `draft_completion`. It is the one predicted kind with no action: writing text into someone's editor needs an IDE integration that can place it, and a confirmation surface that can show it in place.
- A *model-backed* belief producer. The belief seam, a deterministic producer, a re-ranking cognition provider, the semantic gate, and shadow mode all exist and are wired (see [Beliefs and cognition](#beliefs-and-cognition)) — but `HeuristicBeliefProvider` infers from rules over the projection, not from a model, so what the belief layer currently adds over the heuristic is structure and measurability rather than new understanding. A model-backed producer is a drop-in at that seam and must clear the same semantic gate, which no model has yet done: `PiRuntime` fails it on determinism.
- A belief store. Beliefs live for one prediction and are never persisted, so nothing yet accumulates a picture of what someone was doing across a session — the property that would make a belief genuinely longer-lived than the prediction it informs.
- Capture-time privacy beyond redaction, exclusion, pause, and retention. Those four exist (`RedactingCapturePolicy`, `SQUID_EXCLUDE`, the `SQUID_CONTROL` gate, `SQUID_RETENTION_HOURS` + `history:delete`); what remains is a retention pass *during* a long-running session — startup-only today — and any interactive surface for choosing ranges by hand.

## Archived documents

`docs/archive/` holds earlier exploration notes kept for provenance only. They describe designs this implementation did not follow and are not a source of requirements.
