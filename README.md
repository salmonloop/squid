# Squid

Squid is a capability-first desktop assistant prototype built around the Pi agent runtime.

The first implemented vertical is deliberately model-independent:

```text
activity event -> append-only store -> world-state reducer -> baseline prediction
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
- `src/world-state.ts` — deterministic, ownership-safe reducer from events to world state.
- `src/activity-source.ts` — the source contract every capture adapter implements.
- `src/filesystem-source.ts` — filesystem watcher that emits validated file activity for one project root.
- `src/watch-files.ts` — live filesystem ingestion entry point.
- `src/baseline-predictor.ts` — offline heuristic predictor used for evaluation.
- `src/evaluation.ts` — deterministic replay runner and prediction metrics.
- `src/evaluation-fixtures.ts` — versioned synthetic replay scenarios with labeled cut points.
- `src/evaluate.ts` — evaluation report entry point.
- `src/pi-runtime.ts` — Pi adapter that requests one typed prediction via a terminating custom tool. Isolated behind an adapter so Node/RPC remains a fallback if deeper Bun incompatibilities appear.
- `src/squid-core.ts` — orchestrates event ingestion, state reduction, and baseline prediction.
- `src/main.ts` — demo entry point.

## Persistence

Three `EventStore` implementations satisfy one contract. `all()` returns every appended event exactly once, but **return order is not part of the contract** — callers that need a timeline apply `orderActivityEvents`, which is total on events with distinct `eventId`s. `since()` compares epoch milliseconds on both sides, so timezone spellings of the same instant are equal.

`SqliteEventStore` stores the full event as JSON and rehydrates every read through `parseActivityEvent`, so `ingestedAt`, `correlationId`, and sub-millisecond `occurredAt` spellings survive a round trip. Its scalar columns are a lossy projection kept for filtering and integrity only. A primary key on `eventId` and a unique index mirroring source-local event identity make duplicates a structural error rather than a convention: both raise `EventStoreConstraintError`. That is deliberately one error type rather than two, because a row violating both constraints reports only the identity index's `UNIQUE` violation — the error code cannot tell "same event twice" from "identity reused by a different event".

`journal_mode = WAL` with `synchronous = NORMAL` means committed events survive process death without an explicit checkpoint. They are **not** guaranteed to survive OS or power loss — that would need `synchronous = FULL`.

`main.ts` and `watch-files.ts` both use `InMemoryEventStore`. Neither `SqliteEventStore` nor `JsonlEventStore` has a production caller yet; wiring live ingestion to a durable store first requires the filesystem source to carry a per-process session identity, since it currently restarts every session at sequence `0` under a constant `sessionId` and would collide with itself on second launch.

## Pi integration boundary

`PiRuntime` is optional. It uses `@earendil-works/pi-coding-agent` with a terminating structured-output tool (`emit_prediction`). The model provider is configured via `PI_MODEL_PROVIDER` (default `bifrost`) and `PI_MODEL_ID` (default `deepseek-v4-flash`).

If the model provider is unreachable, the baseline predictor continues to function. Pi is not the source of truth for timeline or memory — the event store and world-state reducer are.

## Activity sources

Every capture adapter implements `ActivitySource` (`src/activity-source.ts`): `start(emit)` begins observation, `stop()` drains buffered events and resolves once quiet. Sources never touch the event store or projection directly — they only hand validated events to the emitter, so ingestion, ordering, and idempotency stay owned by the Chronicle core.

`FilesystemActivitySource` is the first real source. It watches one explicitly configured absolute root and emits `file_opened` for a newly seen path and `file_saved` for subsequent writes. Paths are reported root-relative with POSIX separators so a timeline stays replayable on another machine. `.git/`, `node_modules/`, `dist/`, `build/`, `.cache/`, and `.DS_Store` are excluded by default; a caller-supplied `include` predicate can narrow further but cannot widen past those defaults. Repeated notifications for the same path coalesce within a debounce window, and deliveries are serialized so per-source sequence order is stable even when the emitter is slow.

The source reports a path, not an application, so every payload carries `applicationId: "filesystem"`. Attributing a write to the editor that made it needs a future IDE or native source; the `filesystem-save-run-tests` fixture shows the two contexts combining through the projection rather than being guessed by one source.

Watcher, probe, and delivery failures are recorded as diagnostics instead of thrown from async listeners, so one bad path cannot kill the watch.

```bash
bun run watch:files -- /absolute/project/root
```

File contents are never read; only paths, kinds, and timestamps enter the timeline.

## Replay evaluation

`bun run evaluate` runs the heuristic predictor against the versioned synthetic scenarios in `src/evaluation-fixtures.ts` and prints a deterministic JSON report.

Each cut point replays only the canonical events available at that point; later events are excluded so the report cannot receive future-state leakage. The report includes Top-1/Top-3/Top-5 hit rates, mean reciprocal rank (MRR), prediction coverage, and no-action correctness. Current scores describe only this intentionally small synthetic corpus; they are a regression baseline, not a claim about real-user accuracy.

Any future Pi-backed predictor must be evaluated through the same replay runner and fixture version before it can enter a real-time path.

## Testing

Tests use `bun:test`. The test suite covers:

- Runtime ActivityEvent validation and source-local sequence generation.
- Canonical event ordering and source-local event identity.
- `SquidCore` ingestion, idempotency, conflict detection, late-event handling, immutable snapshots, and deterministic restore.
- A shared `EventStore` conformance suite (`tests/event-store-conformance.ts`) run against all three implementations: round-trip fidelity, order-independent canonical ordering, mutation isolation, concurrent appends, and `since()` boundary and timezone equivalence.
- `JsonlEventStore` write recovery and interrupted-tail recovery.
- `SqliteEventStore` cross-connection durability under WAL, sub-millisecond timestamp fidelity, duplicate and identity-reuse rejection, parent-directory creation, and post-`close()` rejection.
- Pi prediction normalization, expiry validation, and evidence provenance.
- Deterministic replay evaluation: cut-point ranking, MRR, coverage, future-leakage guard, and report stability.
- `FilesystemActivitySource` root validation, lifecycle, default and caller filtering, path normalization, event mapping, debounce, ordering under a slow emitter, shutdown drain, diagnostics, and end-to-end ingestion through `SquidCore`.

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
