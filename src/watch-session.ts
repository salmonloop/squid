import { realpath } from "node:fs/promises";
import { createWatchRuntime, type WatchRuntime } from "./create-watch-runtime.js";
import { describeErrorForAudit, resolveSearchEgress } from "./action-egress.js";
import { CaptureGateActivitySource } from "./capture-gate-source.js";
import { resolveCaptureGate } from "./resolve-capture-gate.js";
import { HOUR_MS, resolveRetention } from "./resolve-retention.js";
import { resolveShadowCognition } from "./resolve-shadow-cognition.js";
import { evidenceTimeline } from "./belief-evidence.js";
import { BeliefRerankCognition } from "./belief-rerank-cognition.js";
import { createBeliefBatchRecord } from "./prediction-ledger.js";
import { createShadowAttemptRecord } from "./shadow-ledger.js";
import { ShadowCognitionRunner } from "./shadow-cognition.js";
import type { ActivitySource, ActivitySourceDiagnostic } from "./activity-source.js";
import type { ActivityEvent } from "./protocol.js";
import type { PredictionOutcome } from "./prediction-provider.js";
import type { PredictionRuntimeIngestResult } from "./prediction-runtime.js";
import { runRetentionPrune, type RetentionPruneResult } from "./retention-prune.js";
import { sqliteWatchExclusions } from "./sqlite-event-store.js";
import { resolveWatchActions, type WatchActionsResolution } from "./watch-actions.js";
import { detectProject } from "./project-detect.js";
import { summarizeTools } from "./tool-catalog.js";
import { buildToolRegistry } from "./tool-descriptors.js";
import { resolveWatchProvider, type WatchProviderBeliefBatch } from "./watch-provider.js";

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

/**
 * Ceiling for one shadow belief attempt when a model produces the beliefs.
 *
 * The runner's 15s default was set against an in-process producer; the configured model
 * endpoint answers in 7–15s, so a reachable producer would time out on roughly half its
 * observations and the shadow report would read as an outage rather than as a slow
 * producer. Still bounded — a shadow run that never settles would hold up shutdown.
 */
const SHADOW_MODEL_TIMEOUT_MS = 60_000;

export async function startWatchSession(
  options: WatchSessionOptions,
): Promise<WatchSessionResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const logError = options.logError ?? ((line: string) => console.error(line));

  /**
   * Where a validated belief batch goes, once there is a ledger to put it in.
   *
   * An indirection because the two ends cannot be wired in one step: the provider
   * is resolved *before* any sink opens, deliberately — a config error or a
   * declined model must not leave a half-created database behind — while the
   * ledger only exists after `createWatchRuntime`. So the provider is handed a
   * stable closure now and the real destination is installed below.
   *
   * Undefined is not a dropped record. Nothing can produce a batch until a source
   * starts, and sources start last, long after the assignment; the guard exists so
   * an early-return path that disposes before that point cannot write into a
   * ledger that is already closing.
   */
  let beliefBatchSink: ((observed: WatchProviderBeliefBatch) => void) | undefined;

  // Choose the primary predictor before opening any sink: a config error or a
  // declined model must not leave a half-created database behind. The default
  // `SQUID_PROVIDER=heuristic` never touches a model.
  // Detected before the provider resolves so the gate can score the same
  // catalog the live run will send — a gate run without it would measure a
  // prompt that names no tools, which is not the prompt being authorized.
  // Detection never throws; a directory with no manifest degrades to no
  // check-backed tools.
  const project = await detectProject(options.workingDirectory);
  const sessionTools = summarizeTools(buildToolRegistry({ project }));

  const resolved = await resolveWatchProvider(env, {
    tools: sessionTools,
    // Belief outcomes go to the same stderr channel every other diagnostic uses.
    // Without this a cognition run cannot be told apart from one whose belief
    // layer has been silently refusing every batch — the ranking would differ,
    // which reads as a bad model rather than a starved one.
    onDiagnostic: (diagnostic) => {
      logError(JSON.stringify({
        diagnostic: diagnostic.kind,
        provider: diagnostic.provider,
        status: diagnostic.status,
        ...(diagnostic.reasonCode === undefined ? {} : { reasonCode: diagnostic.reasonCode }),
      }));
    },
    onBeliefBatch: (observed) => beliefBatchSink?.(observed),
  });
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

  // Shadow mode resolves with the rest, before any sink opens. A typo that
  // silently disabled it would leave an operator reading a ledger with no shadow
  // attempts and concluding the cognition path agrees with the heuristic
  // everywhere, when in fact it never ran.
  const shadow = resolveShadowCognition({ env });
  if ("configError" in shadow) return { configError: shadow.configError };

  /**
   * The producer behind the shadow path's belief layer.
   *
   * Resolved from the same variable the live path reads, so one run cannot score a model
   * live while shadowing the heuristic — the two would then disagree about what was
   * measured, and `top1Agrees` would be comparing two different questions.
   *
   * Built even when shadow mode is off, so a typo in the variable fails startup in every
   * configuration rather than only in the one that happens to observe it. The heuristic
   * branch loads no model graph, so the default pays nothing for this.
   */
  // From the resolution the provider step already produced — one read of
  // SQUID_BELIEF_PROVIDER per run, and live and shadow cannot disagree about
  // which producer kind they name.
  const shadowBeliefKind = resolved.belief.kind;
  const shadowBeliefProvider = shadow.enabled
    ? await resolved.belief.createProvider()
    : undefined;

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
    tools: sessionTools,
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

  /**
   * Everything a resolved prediction goes on to do: the log line, the shadow run,
   * the dispatch. The runtime drains the prediction itself but knows nothing about
   * what a caller chained onto it, so shutdown has to await these first — see the
   * ordering comment in `stop`.
   */
  const outcomeContinuations = new Set<Promise<void>>();

  // The shadow path is built after the ledger exists and before any source starts.
  // Its ledger writes are tracked here rather than by the runtime: the runtime
  // drains what *it* wrote, and a shadow record appended after the sinks closed
  // would be lost — so `stop` awaits these explicitly, in order.
  const shadowWrites = new Set<Promise<void>>();

  /**
   * Persists every validated belief batch as history, and closes the seam the
   * provider was resolved with.
   *
   * The provider is chosen before any sink exists — a config error must not leave
   * a half-created database behind — so it cannot be handed a ledger at
   * construction time. The seam is therefore a mutable sink assigned here, which
   * is also what makes the reverse order safe: a batch produced before this line
   * runs finds no sink and is dropped rather than written to a ledger that is not
   * open yet. Nothing can produce one that early in practice, because no source
   * has started.
   *
   * Same posture as the shadow writes beside it: a failed append is a diagnostic,
   * never a failure of the live prediction, and the write is tracked so shutdown
   * drains it before closing the ledger.
   */
  const beliefWrites = new Set<Promise<void>>();
  beliefBatchSink = (observed) => {
    // `provider` is not passed: the record takes it from the batch, which is the
    // producer's own claim about itself. Accepting it separately here would create
    // two spellings that could disagree.
    const write = watch.ledger.appendBeliefBatch(createBeliefBatchRecord({
      requestId: observed.requestId,
      batch: observed.batch,
    })).catch((error: unknown) => {
      logError(JSON.stringify({ beliefLedgerError: describeErrorForAudit(error) }));
    });
    beliefWrites.add(write);
    void write.then(
      () => beliefWrites.delete(write),
      () => beliefWrites.delete(write),
    );
  };
  const shadowRunner = shadowBeliefProvider !== undefined
    ? new ShadowCognitionRunner({
        beliefProvider: shadowBeliefProvider,
        cognition: new BeliefRerankCognition(),
        // A model-backed producer runs 7–15s against the configured endpoint, which sits
        // inside the runner's 15s default — a reachable producer would time out on most
        // observations and the shadow report would read as an outage. The heuristic keeps
        // the default, since raising it there would only delay a shutdown.
        ...(shadowBeliefKind === "heuristic" ? {} : { timeoutMs: SHADOW_MODEL_TIMEOUT_MS }),
        onObservation: (observation) => {
          // Kinds, statuses, and counts only. `beliefValues` is a closed
          // vocabulary and candidate kinds are an enum, so nothing here can echo
          // a selection or a path the shadow run happened to read.
          log(JSON.stringify({
            shadowProvider: observation.shadowProvider,
            requestId: observation.requestId,
            shadowStatus: observation.shadowStatus,
            beliefStatus: observation.beliefStatus,
            beliefValues: observation.beliefValues,
            shadowPredictions: observation.shadowCandidates.map((candidate) => candidate.kind),
            top1Agrees: observation.top1Agrees,
          }));
          const write = watch.ledger.appendAttempt(createShadowAttemptRecord({
            observation,
            completedAt: new Date().toISOString(),
            runtimeSessionId: watch.runtimeSessionId,
            egressPolicyId: egress.id,
          })).catch((error: unknown) => {
            // A shadow record that cannot be written is a diagnostic, never a
            // failure of the live run — exactly the posture the runtime takes for
            // its own attempt records.
            logError(JSON.stringify({ shadowLedgerError: describeErrorForAudit(error) }));
          });
          shadowWrites.add(write);
          void write.then(
            () => shadowWrites.delete(write),
            () => shadowWrites.delete(write),
          );
        },
      })
    : undefined;

  /**
   * Settles everything a prediction set in motion that the runtime does not own,
   * in the one order that loses nothing.
   *
   * Each step is needed for a different reason. First the outcome continuations: a
   * shadow run only *starts* inside one, so disposing the runner before they settle
   * makes `observe` hit its disposed guard and return — producing no run, no
   * record, and no diagnostic. Then the shadow runner, so every observation has
   * fired, then the appends those observations began, because closing the ledger
   * under a write still in flight would drop the record. Then the belief writes,
   * for the same reason.
   *
   * The belief drain is unconditional, unlike the shadow half. A belief write is
   * started from inside the prediction itself rather than from an observation, so
   * it is in flight on any cognition run whether or not shadow mode is on — an
   * early return past it would drop the record in exactly the default
   * configuration.
   *
   * Awaiting a continuation implicitly awaits the prediction behind it, so this
   * needs no new runtime hook. Every path that disposes calls this, including the
   * early returns, so the ordering lives in one place rather than three.
   */
  const drainDerivedWrites = async (): Promise<void> => {
    while (outcomeContinuations.size > 0) {
      await Promise.allSettled([...outcomeContinuations]);
    }
    if (shadowRunner !== undefined) {
      await shadowRunner.dispose();
      while (shadowWrites.size > 0) {
        await Promise.allSettled([...shadowWrites]);
      }
    }
    while (beliefWrites.size > 0) {
      await Promise.allSettled([...beliefWrites]);
    }
  };

  // The action half of the closed loop, off unless SQUID_ACTIONS opts in. Like
  // the provider above it resolves before any source starts: a typo must fail
  // loudly here, not silently disable execution.
  const actions = await resolveWatchActions(watch.runtime, watch.ledger, env, {
    workingDirectory: options.workingDirectory,
    actionTrust: resolved.selection.actionTrust,
    egressPolicy: egress,
    project,
    // Declared by the policy itself, so a policy that stops redacting targets
    // stops arming resolution with no edit here — and one that starts cannot
    // be missed.
    redactsActionTargets: resolved.selection.contextPolicy.redactsActionTargets,
  });
  if (actions !== undefined && "configError" in actions) {
    // Vacuous today — no source has started, so nothing can be in flight — but the
    // runner exists by now, and a path that disposes without draining is the
    // asymmetry a later edit turns into a lost record.
    await drainDerivedWrites();
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
    await drainDerivedWrites();
    await watch.dispose();
    return { configError: "A watch session needs at least one activity source." };
  }

  /**
   * Hands one live outcome to the shadow path, projected exactly as the live
   * provider saw it.
   *
   * The projection is redone here rather than reused because the coordinator
   * projects internally and keeps the result: passing the raw state instead would
   * hand the belief layer fields the policy withheld, while still claiming that
   * policy's id — a leak and a false claim in one line. A policy that throws is
   * treated the way the coordinator treats it: no egress, and the shadow run is
   * skipped rather than run on unprojected state.
   */
  const observeInShadow = (
    outcome: PredictionOutcome,
    ingested: PredictionRuntimeIngestResult & {
      readonly ingest: NonNullable<PredictionRuntimeIngestResult["ingest"]>;
    },
  ): void => {
    if (shadowRunner === undefined) return;
    let projected;
    try {
      projected = watch.contextPolicy.project(ingested.ingest.state);
    } catch (error) {
      logError(JSON.stringify({ shadowProjectionError: describeErrorForAudit(error) }));
      return;
    }
    shadowRunner.observe({
      outcome,
      worldState: projected,
      context: {
        triggerEventId: ingested.ingest.triggerEventId,
        triggeredAt: ingested.ingest.triggeredAt,
        // A duplicate never reaches here — the runtime returns a null prediction
        // for one — so the only two dispositions left are the record's own.
        triggerDisposition: ingested.ingest.disposition === "late" ? "late" : "accepted",
        stateDigest: ingested.ingest.stateDigest,
        projectionGeneration: ingested.ingest.projectionGeneration,
        contextPolicyId: watch.contextPolicy.id,
      },
      // Derived from the projected state, so a belief can only cite an event the
      // provider could actually see.
      eventOccurredAt: evidenceTimeline(projected),
    });
  };

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
    const settled = result.prediction.then(async (outcome) => {
      log(JSON.stringify({
        requestId: outcome.requestId,
        status: outcome.status,
        provider: outcome.provider,
        predictions: outcome.candidates.map((prediction) => prediction.kind),
      }));
      // Shadow runs after the live outcome is in hand and is never awaited: it
      // must not be able to delay a real prediction, and it has no dispatcher to
      // reach even if it wanted one.
      observeInShadow(outcome, ingested);
      if (actions === undefined) return;
      const dispatched = await actions.dispatchTopCandidate(
        outcome,
        outcome.candidates,
        ingested.ingest.disposition,
        // Raw state of this ingest: the ground truth a redacted basename is
        // resolved against. Passed on every dispatch — arming happens inside,
        // keyed on whether the projection actually redacts.
        ingested.ingest.state,
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
    // Tracked rather than `void`ed. Everything downstream of an outcome — the
    // shadow run and its ledger append — happens in this continuation, and the
    // runtime does not know it exists: `runtime.dispose()` drains the prediction,
    // not what a caller chained onto it. Untracked, a shutdown drains the runtime
    // *after* the shadow runner is already disposed, so the observation is dropped
    // with no record and no diagnostic.
    outcomeContinuations.add(settled);
    void settled.then(
      () => outcomeContinuations.delete(settled),
      () => outcomeContinuations.delete(settled),
    );
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
    // A source that failed mid-start may already have emitted, so this path is the
    // one where a drop is reachable rather than theoretical: `source.start(ingest)`
    // ran, predictions may be in flight, and their shadow runs have not begun.
    await drainDerivedWrites();
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
      shadow: shadowRunner === undefined ? "off" : "cognition",
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
      await drainDerivedWrites();
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
