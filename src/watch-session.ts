import { realpath } from "node:fs/promises";
import { createWatchRuntime, type WatchRuntime } from "./create-watch-runtime.js";
import { describeErrorForAudit, resolveSearchEgress } from "./action-egress.js";
import { CaptureGateActivitySource } from "./capture-gate-source.js";
import { resolveCaptureGate } from "./resolve-capture-gate.js";
import { HOUR_MS, resolveRetention } from "./resolve-retention.js";
import type { ActivitySource, ActivitySourceDiagnostic } from "./activity-source.js";
import type { ActivityEvent } from "./protocol.js";
import type { PredictionRuntimeIngestResult } from "./prediction-runtime.js";
import { runRetentionPrune, type RetentionPruneResult } from "./retention-prune.js";
import { sqliteWatchExclusions } from "./sqlite-event-store.js";
import { resolveWatchActions, type WatchActionsResolution } from "./watch-actions.js";
import { resolveWatchProvider } from "./watch-provider.js";

/**
 * The whole watch pipeline minus the sources: provider admission, egress
 * resolution, store/ledger/runtime construction, restore, action wiring, the
 * ingest loop, and shutdown ordering.
 *
 * Extracted because every entry point needs all of it identically. Two copies
 * had already drifted apart in comments while agreeing in behavior; a third
 * copy for a multi-source entry point is how a real divergence gets in. The
 * source-specific parts — which sources exist, what a log line says, where
 * commands run — stay with the entry point as callbacks.
 *
 * Sources are a list, not a single source. A prediction is a function of the
 * *whole* projection, and several admission rules need facts that no single
 * source can produce: `run_tests` compares a save's owner against the
 * foreground application, which means a filesystem source and a screen source
 * must feed one core before the check can ever pass.
 */

/** Everything a source factory may need, available only after the sinks exist. */
export interface WatchSourceContext {
  /** Absolute path of the event database, or undefined when in memory. */
  readonly databasePath: string | undefined;
  /** Absolute path of the ledger database, or undefined when in memory. */
  readonly ledgerPath: string | undefined;
  /** Pass to every source so diagnostics reach the same sink. */
  readonly onDiagnostic: (diagnostic: ActivitySourceDiagnostic) => void;
}

export interface WatchSessionOptions {
  /** Validated by the caller; only presence decides durability here. */
  readonly databasePath?: string;
  /** Absolute directory `run_tests` commands execute in. */
  readonly workingDirectory: string;
  /**
   * Builds the sources once the runtime exists. Filesystem exclusions depend on
   * the ledger path, which is derived during construction, so sources cannot be
   * passed in ready-made.
   */
  readonly createSources: (context: WatchSourceContext) => Promise<readonly ActivitySource[]>;
  /**
   * One stdout line per ingested event. Read the projection (`result.ingest.state`)
   * rather than `event.payload`: the projection is built from the *captured*
   * event, so anything the capture policy redacted stays redacted, and a raw
   * payload could print a window title holding a credential. Only called for
   * events that survived capture — an excluded event never reaches here.
   */
  readonly describeEvent: (
    event: ActivityEvent,
    result: PredictionRuntimeIngestResult & { readonly ingest: NonNullable<PredictionRuntimeIngestResult["ingest"]> },
  ) => Record<string, string | number | boolean | null>;
  /** Entry-point-specific fields merged into the startup line. */
  readonly banner?: Record<string, string | number | boolean | null>;
  /** Injected in tests. */
  readonly env?: Record<string, string | undefined>;
  readonly log?: (line: string) => void;
  readonly logError?: (line: string) => void;
}

export interface WatchSession {
  /** Startup summary, already merged with the caller's fields. */
  readonly banner: Record<string, string | number | boolean | null>;
  readonly runtime: WatchRuntime;
  readonly actions: WatchActionsResolution | undefined;
  /** Every source that started, in start order. */
  readonly sourceIds: readonly string[];
  /** Drains sources, settles pending actions, then closes sinks. Idempotent. */
  stop(): Promise<void>;
}

export type WatchSessionResult =
  | { readonly configError: string }
  | { readonly session: WatchSession };

export async function startWatchSession(
  options: WatchSessionOptions,
): Promise<WatchSessionResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const logError = options.logError ?? ((line: string) => console.error(line));

  // Choose the primary predictor before opening any sink: a config error or a
  // declined model must not leave a half-created database behind. The default
  // `SQUID_PROVIDER=heuristic` never touches a model.
  const resolved = await resolveWatchProvider(env);
  if (!resolved.ok) return { configError: resolved.configError };
  if (resolved.selection.declineReason !== null) {
    logError(JSON.stringify({
      provider: resolved.selection.provider.name,
      declined: resolved.selection.declineReason,
    }));
  }

  // One egress resolution for the whole process: the runtime stamps its id onto
  // every attempt and admission compares that id against the policy the
  // dispatcher presents. Resolving twice could stamp deny and dispatch allow,
  // which refuses every action — including kinds unrelated to egress.
  const egress = resolveSearchEgress(env.SQUID_SEARCH_EGRESS);
  if ("configError" in egress) return { configError: egress.configError };

  // The capture gate resolves with the other capabilities, before any sink
  // opens: a typo in SQUID_CONTROL must fail startup rather than silently
  // leave a run that cannot be paused.
  const gate = resolveCaptureGate(env);
  if ("configError" in gate) return { configError: gate.configError };

  // Retention resolves with the other capability variables, before any sink
  // opens: a typo in SQUID_RETENTION_HOURS must fail startup rather than run a
  // capture session whose deletion policy was silently not applied.
  const retention = resolveRetention({ env });
  if ("configError" in retention) return { configError: retention.configError };

  const watch = createWatchRuntime({
    ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
    provider: resolved.selection.provider,
    contextPolicy: resolved.selection.contextPolicy,
    actionTrust: resolved.selection.actionTrust,
    egressPolicy: egress,
    // Resolved inside createWatchRuntime, but the raw value passes through so
    // a malformed list fails this startup rather than silently capturing all.
    ...(env.SQUID_EXCLUDE === undefined ? {} : { excludeApplications: env.SQUID_EXCLUDE }),
    onDiagnostic: (diagnostic) => {
      logError(JSON.stringify({ diagnostic: diagnostic.kind, message: diagnostic.message }));
    },
  });

  // Retention prunes before restore, so the projection is rebuilt from the
  // history that actually remains — an event the policy deleted must not be
  // re-ingested into world state. The prune runs once per process start;
  // there is no in-run timer, because a long-running session would otherwise
  // delete under the user's feet mid-episode.
  let pruneSummary: RetentionPruneResult | undefined;
  if (retention.enabled) {
    try {
      pruneSummary = await runRetentionPrune(watch.store, watch.ledger, {
        cutoffMs: Date.now() - retention.hours * HOUR_MS,
      });
    } catch (error) {
      await watch.dispose();
      return { configError: `Retention prune failed: ${describeErrorForAudit(error)}` };
    }
  }

  // Rebuild the dedupe index and projection from history before observing, so a
  // restart cannot re-ingest an event the store already holds.
  const restored = await watch.runtime.restore();

  // The action half of the closed loop, off unless SQUID_ACTIONS opts in. Like
  // the provider above it resolves before any source starts: a typo must fail
  // loudly here, not silently disable execution.
  const actions = await resolveWatchActions(watch.runtime, watch.ledger, env, {
    workingDirectory: options.workingDirectory,
    actionTrust: resolved.selection.actionTrust,
    egressPolicy: egress,
  });
  if (actions !== undefined && "configError" in actions) {
    await watch.dispose();
    return { configError: actions.configError };
  }

  const sources = [...await options.createSources({
    databasePath: watch.databasePath,
    ledgerPath: watch.ledgerPath,
    onDiagnostic: (diagnostic) => {
      logError(JSON.stringify({ diagnostic: diagnostic.kind, message: diagnostic.message }));
    },
  })];
  if (gate.enabled) {
    // Last, after every observer: a pause command must land in the timeline
    // with the foreground already projected, and resume must arrive before any
    // event the resumed capture produces.
    sources.push(new CaptureGateActivitySource({
      readerFactory: gate.readerFactory,
      onDiagnostic: (diagnostic) => {
        logError(JSON.stringify({ diagnostic: diagnostic.kind, message: diagnostic.message }));
      },
    }));
  }
  if (sources.length === 0) {
    await watch.dispose();
    return { configError: "A watch session needs at least one activity source." };
  }

  const ingest = async (event: ActivityEvent): Promise<void> => {
    const result = await watch.runtime.ingest(event);
    // A capture-policy exclusion lands here as ingest === null: the event was
    // refused before the store, and the log line says exactly that and nothing
    // more — naming the event would record what the user asked to hide.
    if (result.ingest === null) {
      log(JSON.stringify({ kind: event.kind, disposition: "excluded" }));
      return;
    }
    // Narrowed for the callback below, which also reads the disposition.
    const ingested = result as PredictionRuntimeIngestResult & {
      readonly ingest: NonNullable<PredictionRuntimeIngestResult["ingest"]>;
    };
    log(JSON.stringify(options.describeEvent(event, ingested)));
    if (result.prediction === null) return;
    void result.prediction.then(async (outcome) => {
      log(JSON.stringify({
        requestId: outcome.requestId,
        status: outcome.status,
        provider: outcome.provider,
        predictions: outcome.candidates.map((prediction) => prediction.kind),
      }));
      if (actions === undefined) return;
      const dispatched = await actions.dispatchTopCandidate(
        outcome,
        outcome.candidates,
        ingested.ingest.disposition,
      );
      if (dispatched === null) return;
      // Status and reason codes only: gateway text may echo user content, so
      // stdout carries the same sanitized shape the ledger stores.
      log(JSON.stringify({
        status: dispatched.status,
        planDigest: dispatched.planDigest,
        ...(dispatched.reasonCode === undefined ? {} : { reasonCode: dispatched.reasonCode }),
        ...(dispatched.action === null ? {} : { outcome: dispatched.action.outcome }),
      }));
    }).catch((error) => {
      // The prediction promise itself never rejects (the coordinator resolves
      // every request); this guards the dispatch half so one failed dispatch
      // cannot take down the ingest loop.
      logError(JSON.stringify({ dispatchError: describeErrorForAudit(error) }));
    });
  };

  // Started one at a time rather than with Promise.all: a source that rejects
  // must not leave a sibling half-started with no handle to stop it.
  const started: ActivitySource[] = [];
  try {
    for (const source of sources) {
      await source.start(ingest);
      started.push(source);
    }
  } catch (error) {
    for (const source of started.reverse()) {
      await source.stop().catch(() => {});
    }
    await watch.dispose();
    return { configError: `A source failed to start: ${describeErrorForAudit(error)}` };
  }

  let stopped = false;
  const session: WatchSession = {
    banner: {
      ...(options.banner ?? {}),
      sources: sources.map((source) => source.id).join(","),
      provider: resolved.selection.provider.name,
      ...(actions === undefined ? {} : { actions: actions.gatewayId }),
      store: watch.databasePath ?? "memory",
      ledger: watch.ledgerPath ?? "memory",
      control: gate.enabled ? gate.readerKind : "off",
      retention: retention.enabled ? retention.hours : "off",
      ...(pruneSummary === undefined ? {} : {
        prunedEvents: pruneSummary.removedEvents,
        prunedRecords: pruneSummary.removedRecords,
      }),
      restoredActions: restored.recentActions.length,
    },
    runtime: watch,
    actions,
    sourceIds: sources.map((source) => source.id),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      // Drain every source before disposing: a prediction whose outcome has not
      // been written still has a ledger write in flight, and closing the sinks
      // first drops that record. Sources stop in reverse start order so a later
      // source never emits into one already torn down.
      for (const source of [...sources].reverse()) {
        await source.stop();
      }
      // Settle confirmation and dispatch while the runtime is still open:
      // rejection and terminal action feedback must reach the ledger.
      if (actions !== undefined) await actions.close();
      await watch.dispose();
    },
  };
  return { session };
}

/**
 * Paths a filesystem source must ignore because Squid's own sinks live there.
 *
 * A database inside the watched root feeds its own writes back into the
 * timeline: every append updates `-wal`, the watcher reports that write, and
 * ingesting it appends again. Both sides must be canonical — the source reports
 * paths relative to `realpath(root)`, so comparing against a symlinked spelling
 * would silently match nothing and let the loop back in.
 *
 * Returns an empty set for an in-memory run, and `sqliteWatchExclusions` returns
 * nothing when a sink lives outside the root, so an unrelated sibling path can
 * never be excluded by accident.
 */
export async function watchedSinkExclusions(
  context: WatchSourceContext,
  canonicalRoot: string,
): Promise<ReadonlySet<string>> {
  const excluded = new Set<string>();
  if (context.databasePath === undefined || context.ledgerPath === undefined) {
    return excluded;
  }
  for (const sinkPath of [context.databasePath, context.ledgerPath]) {
    for (const path of sqliteWatchExclusions(canonicalRoot, await realpath(sinkPath))) {
      excluded.add(path);
    }
  }
  return excluded;
}

/**
 * Installs SIGINT/SIGTERM handlers that stop the session once and exit.
 *
 * Separate from `startWatchSession` so the session is testable without
 * installing process-wide handlers or calling `process.exit`.
 */
export function installWatchSignalHandlers(
  session: WatchSession,
  logError: (line: string) => void = (line) => console.error(line),
): void {
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void session.stop().then(
        () => process.exit(0),
        (error: unknown) => {
          logError(JSON.stringify({ shutdownError: describeErrorForAudit(error) }));
          process.exit(1);
        },
      );
    });
  }
}
