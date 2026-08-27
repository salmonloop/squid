import { realpath } from "node:fs/promises";
import { createWatchRuntime, type WatchRuntime } from "./create-watch-runtime.js";
import { describeErrorForAudit } from "./audit-text.js";
import { CaptureGateActivitySource } from "./capture-gate-source.js";
import { resolveCaptureGate } from "./resolve-capture-gate.js";
import { HOUR_MS, resolveRetention } from "./resolve-retention.js";
import {
  createResidentAgent,
  residentAgentSystemPrompt,
  type ResidentAgent,
  type ResidentSessionFactory,
} from "./resident-agent.js";
import type { ActivitySource, ActivitySourceDiagnostic } from "./activity-source.js";
import type { ActivityEvent } from "./protocol.js";
import type { PredictionRuntimeIngestResult } from "./prediction-runtime.js";
import { runRetentionPrune, type RetentionPruneResult } from "./retention-prune.js";
import { sqliteWatchExclusions } from "./sqlite-event-store.js";
import type { ToolSummary } from "./tool-catalog.js";
import { resolvePanel } from "./resolve-panel.js";
import { startPanelServer, type PanelServer } from "./panel-server.js";
import { panelAgentLine, panelWorldState } from "./panel-view.js";
import { appendGateCommand } from "./panel-control.js";

/**
 * The whole watch pipeline minus the sources: store and runtime construction,
 * retention, restore, the resident agent, the ingest loop, and shutdown
 * ordering.
 *
 * Extracted because every entry point needs all of it identically. Two copies
 * had already drifted apart in comments while agreeing in behavior; a third
 * copy for a multi-source entry point is how a real divergence gets in. The
 * source-specific parts — which sources exist, what a log line says, where
 * commands run — stay with the entry point as callbacks.
 *
 * What used to live here and no longer does: provider admission, egress
 * resolution, a shadow cognition runner, a belief batch sink, and an action
 * dispatcher. Those were the machinery of a system that decided for itself what
 * to do next and had to record why. The resident agent decides now — it is told
 * what the sensors saw and chooses its own tools — so this module's job narrows
 * to feeding it and shutting it down in the right order.
 *
 * Sources are a list, not a single source. What the agent can conclude is a
 * function of the *whole* projection: telling "the tests just failed" from "a
 * file changed" needs a filesystem source and a terminal source feeding one core
 * before either observation means anything.
 */

/** Everything a source factory may need, available only after the sinks exist. */
export interface WatchSourceContext {
  /** Absolute path of the event database, or undefined when in memory. */
  readonly databasePath: string | undefined;
  /** Pass to every source so diagnostics reach the same sink. */
  readonly onDiagnostic: (diagnostic: ActivitySourceDiagnostic) => void;
}

export interface WatchSessionOptions {
  /** Validated by the caller; only presence decides durability here. */
  readonly databasePath?: string;
  /** Absolute directory the agent works in. */
  readonly workingDirectory: string;
  /**
   * Builds the sources once the runtime exists. Filesystem exclusions depend on
   * the database path, which is derived during construction, so sources cannot
   * be passed in ready-made.
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
  /**
   * Supplementary capabilities described to the agent on top of Pi's own tools.
   * Empty by default: Pi's built-ins are the execution surface, and a catalog
   * exists only when this run genuinely adds something to them.
   */
  readonly tools?: readonly ToolSummary[];
  /** Entry-point-specific fields merged into the startup line. */
  readonly banner?: Record<string, string | number | boolean | null>;
  /** Injected in tests. */
  readonly env?: Record<string, string | undefined>;
  readonly log?: (line: string) => void;
  readonly logError?: (line: string) => void;
  /**
   * Injected in tests so no suite starts a real model runtime. Production omits
   * it and gets the Pi-backed session.
   */
  readonly createAgentSession?: ResidentSessionFactory;
}

export interface WatchSession {
  /** Startup summary, already merged with the caller's fields. */
  readonly banner: Record<string, string | number | boolean | null>;
  readonly runtime: WatchRuntime;
  /** The live agent. Held so a caller can prompt or inspect it directly. */
  readonly agent: ResidentAgent;
  /** Every source that started, in start order. */
  readonly sourceIds: readonly string[];
  /** Drains sources, settles the agent, then closes sinks. Idempotent. */
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

  // The panel resolves here for the same reason as the rest: a malformed
  // SQUID_PANEL_SOCKET must fail before a store exists, not after. It is also
  // the one capability whose misconfiguration could destroy data — binding a
  // Unix socket over a regular file overwrites it silently — so the resolution
  // refuses a relative path and the server refuses a non-socket one.
  const panel = resolvePanel({ env });
  if ("configError" in panel) return { configError: panel.configError };

  const watch = createWatchRuntime({
    ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
    // Resolved inside createWatchRuntime, but the raw value passes through so
    // a malformed list fails this startup rather than silently capturing all.
    ...(env.SQUID_EXCLUDE === undefined ? {} : { excludeApplications: env.SQUID_EXCLUDE }),
  });

  // Retention prunes before restore, so the projection is rebuilt from the
  // history that actually remains — an event the policy deleted must not be
  // re-ingested into world state. The prune runs once per process start;
  // there is no in-run timer, because a long-running session would otherwise
  // delete under the user's feet mid-episode.
  let pruneSummary: RetentionPruneResult | undefined;
  if (retention.enabled) {
    try {
      pruneSummary = await runRetentionPrune(watch.store, {
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
   * The agent is created after the store is open and before any source starts.
   *
   * Eagerly, so a missing model configuration fails startup rather than on the
   * first observation — by which point sources are running and events are being
   * captured into a session no agent will ever read. A failure here disposes the
   * store it already opened; a half-created database is exactly what the
   * pre-sink resolution order exists to prevent.
   */
  let agent: ResidentAgent;
  try {
    agent = await createResidentAgent({
      systemPrompt: residentAgentSystemPrompt(),
      cwd: options.workingDirectory,
      tools: options.tools ?? [],
      ...(options.createAgentSession !== undefined
        ? { createSession: options.createAgentSession }
        : {}),
    });
  } catch (error) {
    await watch.dispose();
    return { configError: `The resident agent could not start: ${describeErrorForAudit(error)}` };
  }

  /**
   * The panel starts after the agent and before any source, so an observation
   * emitted by a starting source is never missed and the socket exists before
   * the banner claims it does. Its failure path disposes everything above it:
   * a half-created agent plus store is the same non-state the pre-sink
   * resolution order exists to prevent.
   *
   * `onControl` never touches capture state directly — it appends to the gate's
   * command path, so a pause lands in the timeline as a `capture_gate_changed`
   * event like every other gate change. With the gate off there is nothing to
   * append to and the press is answered with a diagnostic, not silence.
   */
  let panelServer: PanelServer | undefined;
  if (panel.enabled) {
    const commandPath = env.SQUID_CONTROL_FIFO;
    try {
      panelServer = await startPanelServer({
        socketPath: panel.socketPath,
        onControl: (op) => {
          if (commandPath === undefined) {
            logError(JSON.stringify({ panelControl: op, error: "The capture gate is off." }));
            return;
          }
          void appendGateCommand(commandPath, op).catch((error: unknown) => {
            logError(JSON.stringify({ panelControl: op, error: describeErrorForAudit(error) }));
          });
        },
        onDiagnostic: (line) => logError(line),
      });
    } catch (error) {
      agent.dispose();
      await watch.dispose();
      return { configError: `The panel could not start: ${describeErrorForAudit(error)}` };
    }
  }

  /**
   * Turns the agent's observations into turns, one at a time.
   *
   * Serialized deliberately. Two prompts overlapping on one session is not two
   * opinions — it is one conversation with interleaved turns, and the agent would
   * be reasoning about a half-written history. So each observation waits for the
   * previous turn to settle. Events keep arriving during that wait and land in the
   * sense buffer, which means a busy agent sees the *latest* world when it next
   * thinks rather than a queue of stale ones. That is the correct trade for a
   * sensor stream: the newest observation is the useful one.
   */
  const agentTurns = new Set<Promise<void>>();
  let turnTail: Promise<void> = Promise.resolve();

  const promptAgent = (): void => {
    const turn = turnTail.then(async () => {
      await agent.prompt(AGENT_TURN_PROMPT);
      await agent.waitForIdle();
      const reply = agent.getLastAssistantText();
      // Reported, not interpreted. Whether the agent acted, and how, is in its
      // session history; this line is the operator's window into a loop that is
      // otherwise silent.
      if (reply !== undefined && reply.trim().length > 0) {
        log(JSON.stringify({ agent: "replied", text: reply }));
        panelServer?.broadcast(panelAgentLine({ status: "replied", text: reply }));
      }
    }).catch((error: unknown) => {
      // One failed turn must not end the ingest loop: the next observation gets
      // a fresh attempt, and the agent's session survives a rejected prompt.
      const described = describeErrorForAudit(error);
      logError(JSON.stringify({ agentTurnError: described }));
      panelServer?.broadcast(panelAgentLine({ status: "failed", text: described }));
    });
    // The tail advances even on failure, so a rejected turn cannot wedge the
    // chain — every later observation would otherwise inherit the rejection.
    turnTail = turn;
    agentTurns.add(turn);
    void turn.then(
      () => agentTurns.delete(turn),
      () => agentTurns.delete(turn),
    );
  };

  /** Settles every turn the agent has in flight. Awaited before the agent is disposed. */
  const drainAgentTurns = async (): Promise<void> => {
    while (agentTurns.size > 0) {
      await Promise.allSettled([...agentTurns]);
    }
  };

  const sources = [...await options.createSources({
    databasePath: watch.databasePath,
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
    if (panelServer !== undefined) await panelServer.close();
    await drainAgentTurns();
    agent.dispose();
    await watch.dispose();
    return { configError: "A watch session needs at least one activity source." };
  }

  /**
   * The closed loop, in three lines: capture and project, hand the projection to
   * the agent's senses, let it think.
   *
   * `observe` always runs; `prompt` follows it. The split matters — observe is
   * what updates the agent's view of the world and appends the breadcrumb, and it
   * must happen even for an event that arrives while a turn is already running,
   * or the agent's next thought would be about a world two events out of date.
   */
  const ingest = async (event: ActivityEvent): Promise<void> => {
    const result = await watch.runtime.ingest(event);
    // A capture-policy exclusion lands here as ingest === null: the event was
    // refused before the store, and the log line says exactly that and nothing
    // more — naming the event would record what the user asked to hide.
    if (result.ingest === null) {
      log(JSON.stringify({ kind: event.kind, disposition: "excluded" }));
      return;
    }
    const ingested = result as PredictionRuntimeIngestResult & {
      readonly ingest: NonNullable<PredictionRuntimeIngestResult["ingest"]>;
    };
    log(JSON.stringify(options.describeEvent(event, ingested)));
    // A duplicate changed nothing about the world, so there is nothing new for
    // the agent to see and no reason to spend a turn on it.
    if (ingested.ingest.disposition === "duplicate") return;
    await agent.observe(ingested.ingest.state);
    // The panel reads the same projection the senses do — one view of the world,
    // two windows onto it. `panelWorldState` returns null when there is nothing
    // to report, and a null is skipped rather than sent: the wire format has no
    // way to say "empty".
    const panelMessage = panelWorldState(ingested.ingest.state);
    if (panelServer !== undefined && panelMessage !== null) {
      panelServer.broadcast(panelMessage);
    }
    promptAgent();
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
    // A source that failed mid-start may already have emitted, so a turn can be
    // in flight on this path rather than only in theory.
    if (panelServer !== undefined) await panelServer.close();
    await drainAgentTurns();
    agent.dispose();
    await watch.dispose();
    return { configError: `A source failed to start: ${describeErrorForAudit(error)}` };
  }

  let stopped = false;
  const session: WatchSession = {
    banner: {
      ...(options.banner ?? {}),
      sources: sources.map((source) => source.id).join(","),
      store: watch.databasePath ?? "memory",
      agent: "resident",
      panel: panel.enabled ? panel.socketPath : "off",
      control: gate.enabled ? gate.readerKind : "off",
      retention: retention.enabled ? retention.hours : "off",
      ...(pruneSummary === undefined ? {} : { prunedEvents: pruneSummary.removedEvents }),
      restoredActions: restored.recentActions.length,
    },
    runtime: watch,
    agent,
    sourceIds: sources.map((source) => source.id),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      // Sources first, in reverse start order, so a later source never emits
      // into one already torn down.
      for (const source of [...sources].reverse()) {
        await source.stop();
      }
      // Then the agent's turns, while its session is still open: a turn cut off
      // mid-flight loses whatever the agent was doing, and its session history is
      // the only record that it happened. The panel closes after that drain, so
      // a turn settling during shutdown still reaches the window. Only then the
      // agent itself, and only then the store — an in-flight ingest still needs
      // somewhere to land.
      await drainAgentTurns();
      if (panelServer !== undefined) await panelServer.close();
      agent.dispose();
      await watch.dispose();
    },
  };
  return { session };
}

/**
 * What the agent is asked on each new observation.
 *
 * Deliberately not a task. The world state and the tool catalog arrive through
 * the sense injection, so restating them here would give the model two versions
 * of the same facts. What this line supplies is the only thing the injection
 * cannot: permission to do nothing. Without it, a model handed a fresh
 * observation every few seconds treats each one as a request for action, and the
 * loop's steady state becomes activity rather than attention.
 */
const AGENT_TURN_PROMPT =
  "New observations have arrived. Act only if something useful is clearly warranted; otherwise stop without acting.";

/**
 * Paths a filesystem source must ignore because Squid's own sink lives there.
 *
 * A database inside the watched root feeds its own writes back into the
 * timeline: every append updates `-wal`, the watcher reports that write, and
 * ingesting it appends again. Both sides must be canonical — the source reports
 * paths relative to `realpath(root)`, so comparing against a symlinked spelling
 * would silently match nothing and let the loop back in.
 *
 * Returns an empty set for an in-memory run, and `sqliteWatchExclusions` returns
 * nothing when the sink lives outside the root, so an unrelated sibling path can
 * never be excluded by accident.
 */
export async function watchedSinkExclusions(
  context: WatchSourceContext,
  canonicalRoot: string,
): Promise<ReadonlySet<string>> {
  const excluded = new Set<string>();
  if (context.databasePath === undefined) return excluded;
  for (const path of sqliteWatchExclusions(canonicalRoot, await realpath(context.databasePath))) {
    excluded.add(path);
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
