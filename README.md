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
- `src/watch-files.ts` — live filesystem ingestion entry point; durable when `SQUID_DB` is set.
- `src/watch-screen.ts` — live foreground-window-text ingestion entry point; picks a reader backend from `SQUID_SCREEN_READER`.
- `src/baseline-predictor.ts` — offline heuristic predictor used for evaluation.
- `src/evaluation.ts` — deterministic replay runner and prediction metrics.
- `src/evaluation-fixtures.ts` — versioned synthetic replay scenarios with labeled cut points.
- `src/evaluate.ts` — evaluation report entry point.
- `src/provider-gate.ts` — replay gate that scores a candidate provider against the heuristic baseline on one fixture version and measures provider health, which the ranking report omits.
- `src/provider-selector.ts` — admission boundary for the live primary provider: chooses heuristic or model, and reports why a model was declined. Pure and fully injected, so it imports no model runtime.
- `src/watch-provider.ts` — wires the real Pi and replay-gate seams into the selector and reads `SQUID_PROVIDER` / `SQUID_PROVIDER_GATE` for both watch entry points.
- `src/gate-pi.ts` — `bun run gate:pi` entry point for the Pi-backed predictor. Needs a reachable model, so it is separate from the offline suite.
- `src/prediction-provider.ts` — async prediction contract: `PredictionProvider` interface, `PredictionRequest`, `PredictionOutcome`, and `SyncPredictorProvider` adapter.
- `src/prediction-coordinator.ts` — one-in-flight async coordinator with timeout, cancellation, stale-episode guard, and heuristic fallback. Applies a `ContextPolicy` to the provider's view of world state.
- `src/context-policy.ts` — egress boundary for provider context: `ContextPolicy` interface, `PassthroughContextPolicy` (the default), and `RedactingContextPolicy` with a typed allow-list.
- `src/capture-policy.ts` — ingress boundary for capture: `CapturePolicy` interface, `PassthroughCapturePolicy` (the default), and `RedactingCapturePolicy`, which strips credential content before an event reaches the store. Capture is irreversible, so this narrows what is persisted rather than what is merely shown to a provider.
- `src/prediction-runtime.ts` — live orchestration boundary that feeds accepted/late core state snapshots into the coordinator without coupling provider latency to event ingestion. When a `PredictionLedger` is attached, every outcome is persisted as a durable attempt record; ledger failures are diagnostics and never block prediction delivery, and `dispose` drains in-flight writes so shutdown is durable.
- `src/prediction-ledger.ts` — append-only prediction attempts and feedback with deterministic candidate envelopes, in-memory tests, and recoverable JSONL persistence.
- `src/sqlite-prediction-ledger.ts` — append-only ledger on SQLite that declares its integrity rules as schema constraints instead of process-local checks.
- `src/capability-gateway.ts` — pluggable capability boundary: `CapabilityGateway` interface, `ActionRequest`/`ActionResult`, a `FakeCapabilityGateway` for offline tests, and a `CapabilityDispatcher` that dispatches a ledger-resolved candidate by ID and records the dispatched→succeeded/failed lifecycle as ledger feedback. A gateway failure is data (a `failed` result); a failed ledger write escapes, because an unrecorded dispatch must not look like a successful one. Dispatcher attribution (`gateway`, `error`) wins over gateway-supplied details. A real MCP server implements the gateway; the base owns intent and recording only. Acceptance policy — expiry, user confirmation — is not enforced here.
- `src/prediction-log.ts` — structured shadow-mode log for prediction outcomes.
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
SQUID_PROVIDER=pi bun run watch:files -- /absolute/project/root                       # admit on reachability
SQUID_PROVIDER=pi SQUID_PROVIDER_GATE=replay bun run watch:screen                     # admit only on a gate pass
```

`SQUID_PROVIDER_GATE` picks the admission check. The default `probe` resolves the model once via `PiRuntime.checkAvailability()` — fast, and enough to tell an outage apart from a bad prediction. `replay` instead runs the same `runProviderGate` that `bun run gate:pi` runs, at startup, and admits the model only on `passed`. A `skipped` gate declines, because an unreachable or unevaluated model must not reach the real-time path just because nothing measured a regression against it.

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

## Replay evaluation

`bun run evaluate` runs the heuristic predictor against the versioned synthetic scenarios in `src/evaluation-fixtures.ts` and prints a deterministic JSON report.

Each cut point replays only the canonical events available at that point; later events are excluded so the report cannot receive future-state leakage. A fresh predictor instance is created per scenario, preventing model sessions or caches from leaking between unrelated timelines. The report includes Top-1/Top-3/Top-5 hit rates, mean reciprocal rank (MRR), prediction coverage, and no-action correctness. The fixtures include stale-context negatives across episode boundaries, a below-threshold continuation guard, and a workflow with multiple distinct cut points. Current scores describe only this intentionally small synthetic corpus; they are a regression baseline, not a claim about real-user accuracy.

### Provider gate

`bun run gate:pi` enforces the rule that a model-backed predictor must clear the replay runner before it enters a real-time path. It scores the candidate against the heuristic baseline on the same fixture version and exits non-zero on a regression.

Thresholds are floors relative to the baseline, not absolute quality claims. Top-1 and fallback rate allow one cut point of slack out of twelve — enough for model nondeterminism, not enough to hide a second regression. `none` correctness has zero slack: suggesting an action where none is warranted is the failure that makes an assistant feel broken.

**Skipped and failed are distinct.** An unreachable provider skips with a stated reason and exits 0, because an outage is not evidence about the model. Treating it as a pass is how an unevaluated predictor reaches production; treating it as a failure is how a config problem gets misread as a quality regression.

Reachability is a separate `probeAvailability` hook rather than a check on construction. `PiRuntime` builds fine and only discovers a missing model when its runtime promise settles, so probing the constructor would report every outage as a ranking failure. `PiRuntime.checkAvailability()` resolves the configured model and returns a reason or null; the gate runs it before spending a baseline run.

The gate also measures provider health, which the ranking report deliberately omits. Without it the gate would be trivially defeatable: the coordinator substitutes the heuristic on every provider failure, so a permanently broken model posts baseline-identical rankings. A wrapper counts answered versus fallen-back requests outside the coordinator, since the fallback erases the failure from the outcome the runner keeps. Timeouts count as fallbacks because a conforming provider rejects on abort.

**Current result: the Pi predictor does not pass.** Across three runs it failed every time, on both Top-1 and `none` correctness, while answering all 12 requests with zero fallback — so the failure is measured model behavior, not an outage. Coverage came in at or above the baseline's, which is the shape of a predictor that is too eager rather than too quiet: it proposes an action on negatives where the correct answer is `none`, including on stale context across an episode boundary.

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
- `PredictionRuntime`: non-blocking prediction dispatch after projection, duplicate suppression, supersession, restore, shutdown drain, durable attempt recording when a ledger is attached (ledger failures do not block prediction; shutdown waits for in-flight writes), and `recordFeedback` that appends feedback linked to a candidate by stable ID (the ledger validates the candidate exists and belongs to the request; a missing ledger throws; shutdown waits for in-flight feedback writes).
- Prediction candidate identity and ledger: deterministic request-scoped IDs, append-only feedback, duplicate/conflict checks, restart recovery, and interrupted-tail handling.
- A shared `PredictionLedger` conformance suite (`tests/prediction-ledger-conformance.ts`) run against all three implementations: round-trip fidelity, optional-field presence and absence, append ordering, candidate-linked feedback, multiple feedback per candidate, idempotent re-append, duplicate-attempt and reference-error rejection, empty-candidate attempts, multi-candidate addressability, mutation isolation, and concurrent appends.
- `SqlitePredictionLedger`: cross-connection durability, schema-enforced conflict rejection surviving a reopen, transactional rollback leaving no partial attempt, post-`close()` rejection, idempotent close, parent-directory creation, and sub-millisecond timestamp fidelity.
- `CapabilityGateway`: fake-gateway outcomes, failure details, and thrown invocations; `CapabilityDispatcher` dispatch recording succeeded/failed feedback in order, a thrown invocation becoming a failed result, dispatcher attribution winning over conflicting gateway details, and rejection for a candidate absent from the ledger.
- `PredictionLog`: structured recording of outcomes, cancellations, and field mapping.
- Async evaluation: provider-based evaluation matching sync results, canned-provider scoring, hard timeout, and heuristic fallback.
- `runProviderGate`: baseline-equal pass, ranking regression failure, skip (not failure) for an unconstructable provider and for a lazily-resolved provider that reports itself unavailable without spending a baseline run, skip when the probe itself rejects, scoring when the probe reports available, failure for a provider that never answers despite baseline-equal ranking, timeouts counted as fallbacks, full health for a healthy provider, `none`-correctness failure for an over-eager provider, same-corpus comparison, custom slack, and default-threshold bounds.
- Deterministic replay evaluation: cut-point ranking, MRR, coverage, future-leakage guard, per-scenario predictor isolation, and report stability.
- `FilesystemActivitySource` root validation, lifecycle, default and caller filtering, path normalization, event mapping, debounce, ordering under a slow emitter, shutdown drain, diagnostics, distinct per-instance session identity, restart against one durable store without an identity collision, and end-to-end ingestion through `SquidCore`.
- `ScreenTextActivitySource` lifecycle, full-frame mapping to four host events, per-payload change detection (title-only, role-only, selection-only, and unchanged frames), degradation for missing application id / name / title / caret context, ordering and sequence under a slow emitter, burst collapsing, shutdown flush of the pending frame, reader and delivery diagnostics including retry of a rejected payload, recovery from a backend that fails to initialize, distinct per-instance session identity, and end-to-end ingestion through `SquidCore`.
- `selectPredictionProvider`: environment parsing and defaults, the heuristic path touching no model seam at all, probe admission on reachable / unreachable / rejecting probes, and replay admission on passed / failed / skipped / rejecting gates.

Source tests inject a fake watcher, file probe, and screen-text reader, so they never depend on kernel watch timing, an accessibility API, or a subprocess. Real-watcher behavior is verified by the `bun run watch:files` smoke run in the release gate; the macOS accessibility backend is verified by hand with `SQUID_SCREEN_READER=darwin bun run watch:screen`.

## What is not yet implemented

- Screen keyframes, OCR, and full caret context. Foreground window text is implemented; pixels are not.
- Browser extension / CDP integration.
- IDE / LSP integration.
- Overlay / suggestion UI.
- Action execution. `CapabilityGateway` defines the boundary and `CapabilityDispatcher` records the dispatch lifecycle, but only `FakeCapabilityGateway` implements it and no entry point wires a dispatcher — nothing in a live run can act.
- Capture-time privacy policy beyond credential redaction. `RedactingCapturePolicy` already filters credential content at the ingress boundary in `PredictionRuntime`, and both watch entry points enable it; `ContextPolicy` separately covers provider egress. What is missing is user-facing policy — per-application exclusions, pause, and retention.

## Archived documents

`docs/archive/` holds earlier exploration notes kept for provenance only. They describe designs this implementation did not follow and are not a source of requirements.
