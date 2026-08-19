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
bun run watch:files -- /absolute/project/root
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
- `src/watch-files.ts` — live filesystem ingestion entry point; durable when `SQUID_DB` is set.
- `src/baseline-predictor.ts` — offline heuristic predictor used for evaluation.
- `src/evaluation.ts` — deterministic replay runner and prediction metrics.
- `src/evaluation-fixtures.ts` — versioned synthetic replay scenarios with labeled cut points.
- `src/evaluate.ts` — evaluation report entry point.
- `src/prediction-provider.ts` — async prediction contract: `PredictionProvider` interface, `PredictionRequest`, `PredictionOutcome`, and `SyncPredictorProvider` adapter.
- `src/prediction-coordinator.ts` — one-in-flight async coordinator with timeout, cancellation, stale-episode guard, and heuristic fallback.
- `src/prediction-log.ts` — structured shadow-mode log for prediction outcomes.
- `src/fake-prediction-provider.ts` — controllable `PredictionProvider` for tests and offline evaluation.
- `src/pi-runtime.ts` — Pi adapter that implements `PredictionProvider`, requests one typed prediction via a terminating custom tool, respects `AbortSignal`, and derives `expiresAt` per kind. Isolated behind an adapter so Node/RPC remains a fallback if deeper Bun incompatibilities appear.
- `src/squid-core.ts` — orchestrates event ingestion, state reduction, and baseline prediction.
- `src/main.ts` — demo entry point.

## Persistence

Three `EventStore` implementations satisfy one contract. `all()` returns every appended event exactly once, but **return order is not part of the contract** — callers that need a timeline apply `orderActivityEvents`, which is total on events with distinct `eventId`s. `since()` compares epoch milliseconds on both sides, so timezone spellings of the same instant are equal.

`SqliteEventStore` stores the full event as JSON and rehydrates every read through `parseActivityEvent`, so `ingestedAt`, `correlationId`, and sub-millisecond `occurredAt` spellings survive a round trip. Its scalar columns are a lossy projection kept for filtering and integrity only. A primary key on `eventId` and a unique index mirroring source-local event identity make duplicates a structural error rather than a convention: both raise `EventStoreConstraintError`. That is deliberately one error type rather than two, because a row violating both constraints reports only the identity index's `UNIQUE` violation — the error code cannot tell "same event twice" from "identity reused by a different event".

`journal_mode = WAL` with `synchronous = NORMAL` means committed events survive process death without an explicit checkpoint. They are **not** guaranteed to survive OS or power loss — that would need `synchronous = FULL`.

`watch-files.ts` uses `SqliteEventStore` when `SQUID_DB` names an absolute path, and `InMemoryEventStore` otherwise. It calls `restore()` before observing, so a restart rebuilds the dedupe index and projection from history instead of re-ingesting it. `main.ts` is a demo and stays in memory. `JsonlEventStore` has no production caller.

A database inside the watched root would feed its own writes back into the timeline: each append updates `-wal`, the watcher reports that write, and ingesting it appends again. `sqliteWatchExclusions` returns the root-relative paths of the database and its two WAL sidecars so the watcher skips them; it returns nothing when the database lives outside the root, so an unrelated sibling path can never be excluded by accident.

## Episode projection

Episodes are a deterministic projection over Chronicle events, not data stamped into immutable history. A gap of five minutes or more starts a new episode. The derived ID uses the first event's timestamp and event ID, so the same timeline produces the same episodes and can be re-segmented later without a storage migration. `correlationId` remains unused by this rule.

Opening an episode clears inferred interaction context: foreground application/window, focus text, browser page, command outcome, recent files, and recent semantic actions. The boundary event can immediately re-establish fields it authoritatively carries. This avoids both stale values and contradictory combinations such as a newly activated application paired with the previous application's window. It also bounds the JSON context passed to Pi and prevents an old save or text prefix from generating a suggestion hours later; it does not replace LLM reasoning or add a second inference system.

## Pi integration boundary

`PiRuntime` is optional. It implements the `PredictionProvider` interface and uses `@earendil-works/pi-coding-agent` with a terminating structured-output tool (`emit_prediction`). The model provider is configured via `PI_MODEL_PROVIDER` (default `bifrost`) and `PI_MODEL_ID` (default `deepseek-v4-flash`).

`PredictionCoordinator` wraps any `PredictionProvider` with a hard timeout (default 15 seconds), one-in-flight concurrency (new requests cancel old ones), and an automatic fallback to `HeuristicPredictor` when the provider fails, times out, or is cancelled. Outcomes are published exactly once via an `onOutcome` callback for shadow-mode logging.

The model no longer sets `expiresAt`; Squid derives it per kind (`draft_completion`: 30s, `run_tests`: 60s, `inspect_error`: 120s, `search_selection`: 30s, `none`: 10s) so context-bound suggestions expire on a schedule that matches their semantic freshness window.

If the model provider is unreachable, the baseline predictor continues to function. Pi is not the source of truth for timeline or memory — the event store and world-state reducer are.

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

## Replay evaluation

`bun run evaluate` runs the heuristic predictor against the versioned synthetic scenarios in `src/evaluation-fixtures.ts` and prints a deterministic JSON report.

Each cut point replays only the canonical events available at that point; later events are excluded so the report cannot receive future-state leakage. A fresh predictor instance is created per scenario, preventing model sessions or caches from leaking between unrelated timelines. The report includes Top-1/Top-3/Top-5 hit rates, mean reciprocal rank (MRR), prediction coverage, and no-action correctness. The fixtures include stale-context negatives across episode boundaries, a below-threshold continuation guard, and a workflow with multiple distinct cut points. Current scores describe only this intentionally small synthetic corpus; they are a regression baseline, not a claim about real-user accuracy.

Any future Pi-backed predictor must be evaluated through the same replay runner and fixture version before it can enter a real-time path. The evaluation runner supports both sync (`evaluateScenarios`) and async (`evaluateWithProvider`) providers; async providers are isolated per scenario and failures yield zero candidates rather than unhandled exceptions.

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
- `PredictionLog`: structured recording of outcomes, cancellations, and field mapping.
- Async evaluation: provider-based evaluation matching sync results, canned-provider scoring, and failure-yields-zero-candidates.
- Deterministic replay evaluation: cut-point ranking, MRR, coverage, future-leakage guard, per-scenario predictor isolation, and report stability.
- `FilesystemActivitySource` root validation, lifecycle, default and caller filtering, path normalization, event mapping, debounce, ordering under a slow emitter, shutdown drain, diagnostics, distinct per-instance session identity, restart against one durable store without an identity collision, and end-to-end ingestion through `SquidCore`.

Source tests inject a fake watcher and file probe, so they never depend on kernel watch timing. Real-watcher behavior is verified by the `bun run watch:files` smoke run in the release gate.

## What is not yet implemented

- Native desktop capture (screen, accessibility, focus events).
- Browser extension / CDP integration.
- IDE / LSP integration.
- Overlay / suggestion UI.
- Action execution.
- Privacy filtering and policy gateway.

## Archived documents

`docs/archive/` holds earlier exploration notes kept for provenance only. They describe designs this implementation did not follow and are not a source of requirements.
