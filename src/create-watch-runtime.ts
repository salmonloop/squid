import type { EventStore } from "./event-store.js";
import { InMemoryEventStore } from "./event-store.js";
import type { PredictionLedger } from "./prediction-ledger.js";
import { InMemoryPredictionLedger } from "./prediction-ledger.js";
import { SqlitePredictionLedger } from "./sqlite-prediction-ledger.js";
import { PredictionCoordinator } from "./prediction-coordinator.js";
import type { PredictionProvider } from "./prediction-provider.js";
import {
  PredictionRuntime,
  type PredictionRuntimeDiagnostic,
} from "./prediction-runtime.js";
import { RedactingCapturePolicy } from "./capture-policy.js";
import { resolveCaptureExclusion } from "./capture-exclusion.js";
import { SqliteEventStore } from "./sqlite-event-store.js";
import { SquidCore } from "./squid-core.js";
import type { ContextPolicy } from "./context-policy.js";
import { PassthroughContextPolicy } from "./context-policy.js";
import { SEARCH_EGRESS_DENY_ID, type EgressPolicy } from "./action-egress.js";
import type { ToolSummary } from "./tool-catalog.js";

/**
 * The shared setup both watch entry points need: a store, a ledger, a core
 * projection, and the live prediction runtime layered over it. The entry point
 * owns everything source-specific — root canonicalization, watcher exclusions,
 * the source itself, signal handling — so this function carries no filesystem
 * or screen-text assumptions.
 *
 * `databasePath` is read and validated by the caller; this function only
 * branches on whether it was provided, so it stays a pure function of its input
 * and never touches `process.env`.
 */
export interface WatchRuntime {
  readonly core: SquidCore;
  readonly runtime: PredictionRuntime;
  readonly store: EventStore;
  readonly ledger: PredictionLedger;
  readonly databasePath: string | undefined;
  /**
   * Where the ledger persists, or `undefined` in memory. Derived here rather
   * than by the caller so the sibling-file rule lives in one place — and a
   * filesystem entry point needs it, because a durable ledger writing inside a
   * watched tree would otherwise feed its own writes back into the timeline.
   */
  readonly ledgerPath: string | undefined;
  /**
   * The policy every outgoing provider request was projected through.
   *
   * Exposed because a second predictor run beside the live one is a second egress,
   * not an exception to the first: it has to project through the *same* policy, and
   * name it, or the belief contract refuses its batches as
   * `context_policy_mismatch` — and a shadow run whose beliefs are all refused
   * measures the absence of a belief layer rather than the presence of one.
   */
  readonly contextPolicy: ContextPolicy;
  /**
   * The session id stamped on every attempt record this runtime writes. Generated
   * here rather than by the caller so the sibling-file rule and the session
   * identity are decided in the same place; surfaced so a shadow record can claim
   * the same session as the live record it shadows.
   */
  readonly runtimeSessionId: string;
  /**
   * Drain in-flight predictions and ingests, then close durable sinks. Mirrors
   * the shutdown order the watch entries need: a prediction whose outcome has
   * not yet been ledgered still has a write in flight, and `dispose` drains it;
   * closing first would drop that record.
   */
  dispose(): Promise<void>;
}

export interface CreateWatchRuntimeOptions {
  /**
   * Absolute path to the SQLite database, or `undefined` for in-memory storage.
   * The caller validates absoluteness; this function only decides durability
   * from whether a path is present.
   */
  readonly databasePath?: string;
  /**
   * The primary prediction provider. Module 11 passes the heuristic so default
   * behavior is unchanged; module 12 swaps in a selector that may return Pi.
   */
  readonly provider: PredictionProvider;
  readonly contextPolicy?: ContextPolicy;
  readonly actionTrust?: "trusted" | "suggestion_only";
  /**
   * The egress policy governing search actions. Attempt records are stamped with
   * its id, and admission compares that id against the policy the dispatcher
   * presents — so this must be the *same* resolved policy the action layer uses.
   * Passing one here and resolving another there would make every action fail
   * `egress_policy_mismatch`, including kinds that have nothing to do with egress.
   */
  readonly egressPolicy?: EgressPolicy;
  /**
   * Raw `SQUID_EXCLUDE` value: comma-separated application names to drop at
   * capture, before the store. Resolved here so a malformed list fails the
   * run before any sink opens rather than silently capturing everything.
   */
  readonly excludeApplications?: string;
  /** Forwards non-fatal runtime diagnostics; omitted in tests. */
  readonly onDiagnostic?: (diagnostic: PredictionRuntimeDiagnostic) => void;
  /**
   * The run's capability catalog, as the prompt-facing summaries every outgoing
   * prediction request carries. Summaries arrive ready-made rather than as a
   * project profile because this function touches no filesystem — detection is
   * the caller's job, done once so the prompt view and the action layer cannot
   * describe different projects.
   */
  readonly tools?: readonly ToolSummary[];
}

export function createWatchRuntime(options: CreateWatchRuntimeOptions): WatchRuntime {
  const databasePath = options.databasePath;
  const store: EventStore = databasePath === undefined
    ? new InMemoryEventStore()
    : new SqliteEventStore(databasePath);

  // The ledger follows the same durability switch as the event store: a run
  // that persists its timeline should also persist why it predicted what it
  // did. It lives in a sibling file so replaying the timeline never contends
  // with prediction writes.
  const ledgerPath = databasePath === undefined ? undefined : `${databasePath}.ledger.db`;
  const ledger: PredictionLedger = ledgerPath === undefined
    ? new InMemoryPredictionLedger()
    : new SqlitePredictionLedger(ledgerPath);

  // Capture composes here, once per process: exclusion wraps redaction, so an
  // excluded event is dropped and every kept one is still redacted. A malformed
  // exclusion list is a startup error — the caller resolves before any sink
  // opens.
  const captureExclusion = resolveCaptureExclusion(options.excludeApplications);
  if ("configError" in captureExclusion) {
    throw new TypeError(captureExclusion.configError);
  }

  const core = new SquidCore(store);
  const contextPolicy = options.contextPolicy ?? new PassthroughContextPolicy();
  const runtimeSessionId = `watch-${crypto.randomUUID()}`;
  const runtime = new PredictionRuntime(
    core,
    // The coordinator's own fallback default is the heuristic predictor, so a
    // provider that fails, times out, or is cancelled always lands somewhere.
    new PredictionCoordinator({
      provider: options.provider,
      contextPolicy,
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    }),
    {
      ledger,
      // The durable path persists events, so capture redacts credential
      // content before it reaches the store — the same opt-in posture as the
      // ledger. The in-memory path redacts too; there is no reason to ever let
      // a credential cross the ingress boundary unredacted. Exclusion (when
      // configured) narrows further on top of this policy.
      capturePolicy: captureExclusion,
      runtimeSessionId,
      ...(options.actionTrust === undefined ? {} : { actionTrust: options.actionTrust }),
      egressPolicyId: (options.egressPolicy ?? { id: SEARCH_EGRESS_DENY_ID }).id,
      ...(options.onDiagnostic !== undefined ? { onDiagnostic: options.onDiagnostic } : {}),
    },
  );

  return {
    core,
    runtime,
    store,
    ledger,
    databasePath,
    ledgerPath,
    contextPolicy,
    runtimeSessionId,
    async dispose() {
      await runtime.dispose();
      if (store instanceof SqliteEventStore) store.close();
      if (ledger instanceof SqlitePredictionLedger) ledger.close();
    },
  };
}
