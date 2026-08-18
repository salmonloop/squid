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
```

## Architecture

- `src/protocol.ts` — versioned activity/prediction contracts plus compiled runtime validation at every Chronicle ingress boundary.
- `src/chronicle-ordering.ts` — canonical event identity and stable replay ordering.
- `src/event-store.ts` — in-memory and JSONL append-only event stores, including recovery diagnostics for an interrupted final JSONL record.
- `src/world-state.ts` — deterministic, ownership-safe reducer from events to world state.
- `src/baseline-predictor.ts` — offline heuristic predictor used for evaluation.
- `src/pi-runtime.ts` — Pi adapter that requests one typed prediction via a terminating custom tool. Isolated behind an adapter so Node/RPC remains a fallback if deeper Bun incompatibilities appear.
- `src/squid-core.ts` — orchestrates event ingestion, state reduction, and baseline prediction.
- `src/main.ts` — demo entry point.

## Pi integration boundary

`PiRuntime` is optional. It uses `@earendil-works/pi-coding-agent` with a terminating structured-output tool (`emit_prediction`). The model provider is configured via `PI_MODEL_PROVIDER` (default `bifrost`) and `PI_MODEL_ID` (default `deepseek-v4-flash`).

If the model provider is unreachable, the baseline predictor continues to function. Pi is not the source of truth for timeline or memory — the event store and world-state reducer are.

## Testing

Tests use `bun:test`. The test suite covers:

- Runtime ActivityEvent validation and source-local sequence generation.
- Canonical event ordering and source-local event identity.
- `SquidCore` ingestion, idempotency, conflict detection, late-event handling, immutable snapshots, and deterministic restore.
- `JsonlEventStore` persistence, write recovery, mutation isolation, filtering, and interrupted-tail recovery.
- Pi prediction normalization, expiry validation, and evidence provenance.

## What is not yet implemented

- Native desktop capture (screen, accessibility, focus events).
- Browser extension / CDP integration.
- IDE / LSP integration.
- Overlay / suggestion UI.
- Action execution.
- Privacy filtering and policy gateway.
