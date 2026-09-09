import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { createWatchRuntime, type WatchRuntime } from "./create-watch-runtime.js";
import { agentCustomTools } from "./agent-tools.js";
import { describeErrorForAudit } from "./audit-text.js";
import { CaptureGateActivitySource } from "./capture-gate-source.js";
import { resolveCaptureGate } from "./resolve-capture-gate.js";
import { resolveAgentTurnTimeout } from "./resolve-agent-turn-timeout.js";
import { HOUR_MS, resolveRetention } from "./resolve-retention.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolvePiModel } from "./pi-session-factory.js";
import {
  DEFAULT_BASE_URL,
  applyConfigSet,
  configDumpEntries,
  isModelConfigKey,
  type ConfigServiceOptions,
} from "./config-service.js";
import {
  createResidentAgent,
  residentAgentConfigured,
  residentAgentSystemPrompt,
  type ResidentAgent,
  type ResidentSessionFactory,
} from "./resident-agent.js";
import type { ActivitySourceDiagnostic, SourceEntry } from "./activity-source.js";
import { SourceManager } from "./source-manager.js";
import type { ActivityEvent, WorldState } from "./protocol.js";
import type { PredictionRuntimeIngestResult } from "./prediction-runtime.js";
import { runRetentionPrune, type RetentionPruneResult } from "./retention-prune.js";
import { sqliteWatchExclusions } from "./sqlite-event-store.js";
import type { ToolSummary } from "./tool-catalog.js";
import { resolvePanel } from "./resolve-panel.js";
import { startPanelServer, type PanelServer } from "./panel-server.js";
import type { DesktopNotifierFactory } from "./desktop-notice.js";
import { PanelConfirmationSurface } from "./panel-confirmation-surface.js";
import {
  panelAgentLine,
  panelConfigEnd,
  panelConfigLine,
  panelConfigResult,
  panelServiceLine,
  panelSourceEnd,
  panelSourceLine,
  panelSourceResult,
  panelWorldState,
} from "./panel-view.js";
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
  /**
   * Pi's agent directory — where the resident agent's session history, auth, and
   * model catalog are written. `watchedSinkExclusions` needs it to keep those
   * writes out of a filesystem source's timeline; production sets it from the
   * same value the config service uses, so the two cannot disagree about where
   * Pi lives.
   */
  readonly agentDir: string | undefined;
  /** Pass to every source so diagnostics reach the same sink. */
  readonly onDiagnostic: (diagnostic: ActivitySourceDiagnostic) => void;
}

export interface WatchSessionOptions {
  /** Validated by the caller; only presence decides durability here. */
  readonly databasePath?: string;
  /** Absolute directory the agent works in. */
  readonly workingDirectory: string;
  /**
   * Declares the source catalog once the runtime exists. Filesystem exclusions
   * depend on the database path, which is derived during construction, so the
   * catalog cannot be passed in ready-made. Entries are recipes, not instances:
   * the session's source manager builds each one it starts, and an entry whose
   * `create` is omitted shows as `unsupported` and refuses toggles rather than
   * disappearing from the panel's dump.
   */
  readonly createSources: (context: WatchSourceContext) => Promise<readonly SourceEntry[]>;
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
  /**
   * How this run reaches the person when the panel is closed. Omitted means it
   * does not, which is the default: see `resolve-desktop-notice.ts`.
   *
   * Resolved by the caller, like the sensor factories, so this file never reads
   * `SQUID_NOTIFY` and a test can hand it a notifier that records instead of
   * interrupting whoever is running the suite.
   */
  readonly notifierFactory?: DesktopNotifierFactory;
  /** Injected in tests. */
  readonly env?: Record<string, string | undefined>;
  readonly log?: (line: string) => void;
  readonly logError?: (line: string) => void;
  /**
   * Injected in tests so no suite starts a real model runtime. Production omits
   * it and gets the Pi-backed session.
   */
  readonly createAgentSession?: ResidentSessionFactory;
  /**
   * The pre-checked model verdict, computed by the caller before launching.
   * Default: an injected session factory counts as configured (a test must not
   * depend on the developer machine's Pi configuration); the default factory's
   * verdict comes from `residentAgentConfigured`, consulted only when a panel is
   * actually mounted.
   */
  readonly agentConfigured?: boolean;
  /**
   * Where the Squid config file lives. Settings sets and dumps go through it;
   * undefined means a run with no config file, where file-backed sets refuse.
   */
  readonly configPath?: string;
  /**
   * Pi's agent directory and the model fallbacks, injected in tests so no suite
   * reads the developer machine's Pi files. Production omits all three and gets
   * Pi's own defaults.
   */
  readonly agentDir?: string;
  readonly modelProvider?: string;
  readonly defaultModelId?: string;
  readonly defaultBaseUrl?: string;
  /**
   * What a requested restart does once the session has stopped. Production
   * exits 3 — the supervisor's signal to respawn with the new configuration —
   * and tests inject a spy instead of ending the process.
   */
  readonly restartExit?: () => void;
  /**
   * What a requested stop does once the session has stopped. Production exits 0,
   * which every supervisor already reads as "asked to stop, do not respawn";
   * tests inject a spy instead of ending the process.
   */
  readonly stopExit?: () => void;
}

export interface WatchSession {
  /** Startup summary, already merged with the caller's fields. */
  readonly banner: Record<string, string | number | boolean | null>;
  readonly runtime: WatchRuntime;
  /**
   * The live agent, when one is running. Absent (`undefined`) in headless
   * mode: the model is not configured and a panel is mounted, so the session
   * captures and projects without thinking — the settings form is the way out.
   */
  readonly agent: ResidentAgent | undefined;
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
  // Exit 3 is the supervisor's contract: "I stopped cleanly because you asked;
  // bring me back with the configuration as it now stands." Exit 2 stays the
  // terminal code for a config error, so a launcher can tell the two apart.
  const restartExit = options.restartExit ?? (() => process.exit(3));
  // Zero, and nothing new: a clean exit is already the supervisor's "the session
  // stopped" — the one decision it makes that does not respawn.
  const stopExit = options.stopExit ?? (() => process.exit(0));

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

  // The turn watchdog resolves with the other capability variables for the same
  // reason: a malformed SQUID_AGENT_TURN_TIMEOUT_MS must fail startup rather
  // than silently leave a run whose wedge protection was never applied.
  const turnTimeout = resolveAgentTurnTimeout(env);
  if ("configError" in turnTimeout) return { configError: turnTimeout.configError };

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
   * Three states, not two:
   *
   *   ready        — the model is configured; the agent starts eagerly, so a
   *                  broken setup fails here rather than on the first
   *                  observation, after sources are already capturing.
   *   needs_config — the model is not configured **and a panel is mounted** to
   *                  be told: the session starts with no agent at all and says
   *                  so on the `service` wire message below. Capture, the
   *                  projection, and the panel run exactly as always; only the
   *                  thinking waits. A headless run cannot take this state —
   *                  there would be nothing to repair the configuration with,
   *                  so the honest answer stays a startup failure.
   *   failed       — the creation itself threw: the error is the configError
   *                  and everything built above is disposed. Unchanged.
   *
   * The probe is consulted only behind `panel.enabled`: without a window there
   * is no needs_config to enter, so there is no reason to read Pi's files. A
   * caller that injected its own session factory has answered the question by
   * that fact — the factory is the authority on whether a session can open —
   * so the probe guards only the default Pi-backed one.
   */
  const agentConfigured = (): boolean =>
    options.agentConfigured
    ?? (options.createAgentSession !== undefined || residentAgentConfigured());
  const needsConfig = panel.enabled && !agentConfigured();

  // One answer to "where does Pi live", computed once and handed to both
  // consumers — the settings service (which reads and writes Pi's own files)
  // and the source factories (which must not observe them). Computing it in
  // each consumer instead would let the two disagree about where Pi lives, and
  // a disagreement there is exactly the self-triggering loop the exclusion
  // exists to break.
  const agentDir = options.agentDir ?? getAgentDir();

  /**
   * The settings service the panel talks to. Built once, after the env is
   * resolved and before the panel server wires its hooks; every read and write
   * funnels through it so the two stores (Squid file, Pi's own files) stay
   * this layer's private detail.
   */
  const configService: ConfigServiceOptions = {
    configPath: options.configPath,
    env,
    agentDir,
    // `env` here is the merged one — config file under process env — so a
    // file-backed `modelProvider` reaches this the same way every resolver's
    // setting does. Reading `process.env` instead would make the row writable
    // and inert.
    provider: options.modelProvider ?? resolvePiModel({ env }).provider,
    defaultModelId: options.defaultModelId ?? resolvePiModel({ env }).modelId,
    defaultBaseUrl: options.defaultBaseUrl ?? DEFAULT_BASE_URL,
    agentLive: () => agent !== undefined,
  };

  /**
   * Builds the agent. Extracted from the eager path so the same recipe serves
   * needs_config recovery: a panel set saving the missing model configuration
   * starts the agent in-session rather than demanding a process restart.
   */
  const buildAgent = async (): Promise<ResidentAgent> =>
    createResidentAgent({
      systemPrompt: residentAgentSystemPrompt(),
      cwd: options.workingDirectory,
      tools: options.tools ?? [],
      // The agent queries its own sensory record through Pi's tool runtime:
      // one custom tool per store-backed query, executed in Pi's sandbox and
      // recorded in the session history like every other action.
      customTools: agentCustomTools(watch.store),
      ...(options.createAgentSession !== undefined
        ? { createSession: options.createAgentSession }
        : {}),
    });

  let agent: ResidentAgent | undefined;
  if (!needsConfig) {
    try {
      agent = await buildAgent();
    } catch (error) {
      await watch.dispose();
      return { configError: `The resident agent could not start: ${describeErrorForAudit(error)}` };
    }
  }

  /**
   * Starts the agent after a settings set un-blocked it. Guarded so two rapid
   * sets — or a set racing the startup path — cannot build two agents on one
   * store.
   *
   * Failure here is reported, not fatal: the session already runs, its sources
   * already capture, and the store already holds history. The agent line says
   * the start failed and the service line keeps saying needs_config; the panel
   * stays mounted and the user can fix the value and try again. This is the
   * honest counterpart to the startup path, where an agent that cannot start
   * still refuses the whole session because nothing else exists yet.
   */
  let agentStarting = false;
  let lastState: WorldState | null = null;
  const tryStartAgent = (): void => {
    if (agent !== undefined || agentStarting) return;
    agentStarting = true;
    void (async () => {
      try {
        const created = await buildAgent();
        agent = created;
        // The world did not pause while the agent was being built: the newest
        // projection is replayed so its first thought is about now, not about
        // the moment the session started.
        if (lastState !== null) await created.observe(lastState);
        panelServer?.broadcast(panelServiceLine({ agentState: "ready" }));
        log(JSON.stringify({ agent: "resident", recovered: "config_set" }));
      } catch (error) {
        logError(JSON.stringify({ agentStartError: describeErrorForAudit(error) }));
        panelServer?.broadcast(panelAgentLine({ status: "failed", text: describeErrorForAudit(error) }));
      } finally {
        agentStarting = false;
      }
    })();
  };

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
  /**
   * Held in a mutable ref because the hooks below are wired before the session
   * object exists — a restart arriving in that window must find "no session
   * yet", not a stale closure over undefined.
   */
  const sessionRef: { session: WatchSession | undefined } = { session: undefined };

  /**
   * Held in a ref for the same reason as `sessionRef`: the hooks below are
   * wired before the catalog is built, and a toggle arriving in that window
   * must be refused outright, not answered by a closure over `undefined`.
   */
  const sourceManagerRef: { manager: SourceManager | undefined } = { manager: undefined };

  let panelServer: PanelServer | undefined;
  // The adapter is deliberately inert until a future execution seam calls it:
  // current custom tools are read-only and Pi's sandbox owns tool safety.
  const panelConfirmation = new PanelConfirmationSurface({ server: () => panelServer });
  /**
   * Echoes a command's own correlation id back on its verdict.
   *
   * Omitted rather than sent empty when the panel did not supply one: a legacy
   * panel sends no `requestId`, and inventing one would make a verdict look
   * like the answer to a request that was never asked. Two rapid edits to the
   * same key are otherwise indistinguishable, because `id` alone cannot tell
   * them apart.
   */
  const correlate = (requestId: string | undefined): { requestId?: string } =>
    requestId === undefined ? {} : { requestId };
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
        onAnswer: (promptId, answer) => {
          // Correlation belongs to the surface, never the socket parser: stale,
          // duplicate, and unknown answers cannot settle a different prompt.
          if (!panelConfirmation.onAnswer(promptId, answer)) {
            logError(`Panel answer ignored: no pending prompt ${promptId}.`);
          }
        },
        onConfigGet: (requestId) => {
          // The dump is re-read every time, so what the panel shows reflects
          // sets that landed after this process started — there is no cache to
          // go stale.
          const dump = configDumpEntries(configService);
          if (!dump.ok) {
            panelServer?.broadcast(
              panelConfigResult({ ok: false, error: dump.error, ...correlate(requestId) }),
            );
            return;
          }
          for (const entry of dump.entries) {
            panelServer?.broadcast(panelConfigLine(entry));
          }
          panelServer?.broadcast(panelConfigEnd(dump.entries.length));
        },
        onConfigSet: (id, value, requestId) => {
          const outcome = applyConfigSet(configService, id, value);
          panelServer?.broadcast(
            panelConfigResult({
              id,
              ...correlate(requestId),
              ok: outcome.ok,
              ...(outcome.ok ? { applies: outcome.applies } : { error: outcome.error }),
            }),
          );
          // Saving the missing model configuration is the way out of
          // needs_config: the agent starts in-session, immediately, on the
          // files just written. The result above already told the panel the
          // set landed; this is what makes its "applies: now" true.
          if (outcome.ok && isModelConfigKey(id) && agent === undefined) {
            tryStartAgent();
          }
        },
        onSourceGet: (requestId) => {
          const manager = sourceManagerRef.manager;
          if (manager === undefined) {
            // The window between the panel server listening and the catalog
            // being built. A refusal, not silence: a panel waiting on a dump
            // that never ends is a worse lie than an honest "not yet".
            panelServer?.broadcast(
              panelSourceResult({
                ok: false,
                error: "The source catalog is still starting.",
                ...correlate(requestId),
              }),
            );
            return;
          }
          const snapshot = manager.snapshot();
          for (const entry of snapshot) {
            panelServer?.broadcast(panelSourceLine(entry));
          }
          panelServer?.broadcast(panelSourceEnd(snapshot.length));
        },
        onSourceToggle: (id, on, requestId) => {
          const manager = sourceManagerRef.manager;
          if (manager === undefined) {
            panelServer?.broadcast(
              panelSourceResult({
                id,
                ok: false,
                error: "The source catalog is still starting.",
                ...correlate(requestId),
              }),
            );
            return;
          }
          // The manager returns a result instead of throwing — including for
          // unknown ids and refusals — so the panel learns the verdict either way.
          void (on ? manager.start(id) : manager.stop(id)).then((result) => {
            panelServer?.broadcast(
              panelSourceResult(
                result.ok
                  ? { id, ok: true, ...correlate(requestId) }
                  : { id, ok: false, error: result.error, ...correlate(requestId) },
              ),
            );
          });
        },
        onServiceControl: (op) => {
          // Only a supervised run may *restart*: the supervisor is what respawns
          // the process, and an unsupervised exit would look like a crash to
          // whoever started it by hand. Refused with a diagnostic, not silence.
          //
          // `stop` carries no such condition. It needs nothing to respawn it, and
          // a process asked to stop and stopping is never a lie about itself —
          // whereas ignoring the request is exactly the failure this op exists to
          // remove: a panel that quits while its session keeps observing.
          if (op === "restart" && env.SQUID_SUPERVISED !== "1") {
            logError(JSON.stringify({ panelControl: op, error: "Restart requires a supervised run (SQUID_SUPERVISED=1)." }));
            return;
          }
          if (sessionRef.session === undefined) {
            logError(JSON.stringify({ panelControl: op, error: "The session is still starting." }));
            return;
          }
          // Stop in the ordinary order — sources, turns, panel, agent, store —
          // then exit with the code the supervisor reads for this op. The exit
          // code, not a callback, is the handoff: this process cannot start its
          // own replacement, and it is the only thing that tells a supervisor
          // "asked to stop" apart from "died".
          const exit = op === "stop" ? stopExit : restartExit;
          void sessionRef.session.stop().then(
            () => exit(),
            (error: unknown) => {
              logError(JSON.stringify({ [`${op}StopError`]: describeErrorForAudit(error) }));
              exit();
            },
          );
        },
        onSubscribe: () => {
          // Standing state, replayed per subscriber rather than broadcast once:
          // broadcast reaches only whoever is registered at that instant, and
          // a panel attaches after the session — often seconds after, and in
          // the panel-first flow always after. Every subscribe gets the current
          // truth, so the panel never infers readiness from silence.
          //
          // Keyed to `subscribe`, not to a connection being accepted: a Windows
          // command write is its own connection, and replaying into one is an
          // `EPIPE` that makes the panel pull its dumps and provoke two more.
          panelServer?.broadcast(
            panelServiceLine({ agentState: agent === undefined ? "needs_config" : "ready" }),
          );
        },
      });
    } catch (error) {
      agent?.dispose();
      await watch.dispose();
      return { configError: `The panel could not start: ${describeErrorForAudit(error)}` };
    }
  }

  /**
   * Turns the agent's observations into turns — one at a time, and one per quiet
   * moment rather than one per event.
   *
   * Serialized deliberately. Two prompts overlapping on one session is not two
   * opinions — it is one conversation with interleaved turns, and the agent would
   * be reasoning about a half-written history. So each observation waits for the
   * previous turn to settle.
   *
   * Coalesced for the same reason the sense buffer holds only the newest world:
   * observations that arrive while a turn runs do not each earn a turn of their
   * own. They raise one flag, and the single turn that follows reads the newest
   * projection — which is the only one any of them was ever going to be answered
   * from. Queueing them instead made the loop diverge, and measurably: a screen
   * sampled once a second projects roughly two events per changed frame, while a
   * turn costs seconds to tens of seconds, so a chain that grew by one turn per
   * event could never drain. Each queued turn would then wake to the same newest
   * world and think the same thought. The flag bounds the chain at one pending
   * successor no matter how long the burst.
   *
   * What coalescing never touches is what the agent *saw*: every event is still
   * ingested, still projected, and still observed into the session history. This
   * is how often it thinks, not how much it knows.
   */
  const agentTurns = new Set<Promise<void>>();
  /** True while a turn is in flight; a further observation coalesces into `turnPending`. */
  let turnRunning = false;
  /** True when an observation arrived that the running turn cannot already have read. */
  let turnPending = false;

  // Squid's one voice outside the panel window. Absent unless this run asked for
  // it, and its failures are diagnostics on the same channel a sensor's are: a
  // desktop that could not be reached is worth a line in the log and must never
  // be worth a lost turn.
  const notifier = options.notifierFactory?.({
    onDiagnostic: (diagnostic) => {
      logError(JSON.stringify({ diagnostic: diagnostic.kind, message: diagnostic.message }));
    },
  });

  const promptAgent = (): void => {
    // A captured `let` does not narrow inside the closures below, so the guard
    // lands once here and `live` carries the certainty down into the turn.
    if (agent === undefined) return;
    const live = agent;
    const runTurn = async (): Promise<void> => {
      await live.prompt(AGENT_TURN_PROMPT);
      await live.waitForIdle();
      const reply = live.getLastAssistantText();
      // Reported, not interpreted. Whether the agent acted, and how, is in its
      // session history; this line is the operator's window into a loop that is
      // otherwise silent.
      if (reply !== undefined && reply.trim().length > 0) {
        log(JSON.stringify({ agent: "replied", text: reply }));
        const line = panelAgentLine({ status: "replied", text: reply });
        panelServer?.broadcast(line);
        // The same sanitized string the panel gets, not the raw reply: one
        // sanitizer, one ceiling, and two surfaces that cannot disagree about
        // what the agent said. `panelAgentLine` caps and redacts it and strips
        // the control characters, which is also why the body is safely one line.
        //
        // Replies only. A failed turn broadcasts an agent line too, and
        // announcing those would turn one misconfigured model into a popup every
        // few seconds — a loud way to say something the log already said. The
        // panel and the log stay the place a failure is read.
        if (line.text !== undefined && line.text.length > 0) {
          notifier?.notify({ title: "Squid replied", body: line.text });
        }
      }
    };
    /**
     * One bounded turn: the watchdog race around `runTurn`, and nothing else.
     * Extracted from the chain below so the coalescing loop has a single thing to
     * call — the loop decides *how often* a turn happens, this decides what one is.
     */
    const runGuardedTurn = async (): Promise<void> => {
      const running = runTurn();
      // A turn that fails after the watchdog fired must not surface as an
      // unhandled rejection: the race below already reported the turn as lost.
      running.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      // The budget question is answered the moment the timer fires, not at the
      // end of the unwind: an abort that un-wedges the turn lets `running`
      // settle and win the race below, and a race that reports the winner
      // alone would record a turn that blew its budget as a success.
      let timedOut = false;
      const watchdog = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          void (async () => {
            // The abort is what makes the timeout real. A turn that merely
            // lost the race keeps running, and the next turn's waitForIdle
            // would inherit the wedge this timeout exists to break. And the
            // abort must land before the tail advances: a prompt issued
            // while the session is still unwinding is refused outright, so
            // the abort is awaited — under a grace bound, because a session
            // that will not settle must not become a new way to wedge.
            void live.abort().catch(() => undefined);
            let grace: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              live.waitForIdle().catch(() => undefined),
              new Promise<void>((resolve) => {
                grace = setTimeout(resolve, ABORT_GRACE_MS);
              }),
            ]).finally(() => {
              if (grace !== undefined) clearTimeout(grace);
            });
            reject(new Error(`agent turn exceeded ${turnTimeout.timeoutMs}ms and was aborted`));
          })();
        }, turnTimeout.timeoutMs);
      });
      // The watchdog usually loses the race to the turn it aborted; its
      // rejection still has to land somewhere.
      watchdog.catch(() => undefined);
      try {
        await Promise.race([running, watchdog]);
        if (timedOut) {
          throw new Error(`agent turn exceeded ${turnTimeout.timeoutMs}ms and was aborted`);
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    // Every observation raises the flag; only the one that finds no turn running
    // starts the loop. A turn already in flight drains the flag when it settles,
    // so a burst of observations costs one further turn rather than one per event.
    turnPending = true;
    if (turnRunning) return;
    turnRunning = true;
    const chain = (async () => {
      try {
        while (turnPending) {
          // Cleared before the turn, not after: an observation that arrives while
          // this one runs must raise the flag again, and clearing afterwards would
          // erase it.
          turnPending = false;
          await runGuardedTurn().catch((error: unknown) => {
            // One failed turn must not end the loop: the next observation gets a
            // fresh attempt, and the agent's session survives a rejected prompt.
            const described = describeErrorForAudit(error);
            logError(JSON.stringify({ agentTurnError: described }));
            panelServer?.broadcast(panelAgentLine({ status: "failed", text: described }));
          });
        }
      } finally {
        // Nothing awaits between the loop's last test of `turnPending` and this
        // assignment, so an observation cannot arrive in the gap and find both
        // flags clear — a wake-up raised there would be lost with no turn to
        // serve it and no later turn obliged to start.
        turnRunning = false;
      }
    })();
    agentTurns.add(chain);
    void chain.then(
      () => agentTurns.delete(chain),
      () => agentTurns.delete(chain),
    );
  };

  /** Settles every turn the agent has in flight. Awaited before the agent is disposed. */
  const drainAgentTurns = async (): Promise<void> => {
    while (agentTurns.size > 0) {
      await Promise.allSettled([...agentTurns]);
    }
  };

  const entries = [...await options.createSources({
    databasePath: watch.databasePath,
    agentDir,
    onDiagnostic: (diagnostic) => {
      logError(JSON.stringify({ diagnostic: diagnostic.kind, message: diagnostic.message }));
    },
  })];
  // Outside the catalog on purpose: the gate is the pause switch, not an
  // observer, so the panel cannot stop it and the manager never counts it.
  let gateSource: CaptureGateActivitySource | undefined;
  if (gate.enabled) {
    // Last, after every observer: a pause command must land in the timeline
    // with the foreground already projected, and resume must arrive before any
    // event the resumed capture produces. The gate is deliberately not a
    // catalog entry — it is not an observer the panel toggles, and removing it
    // from the session's stop order would corrupt the timeline ordering.
    gateSource = new CaptureGateActivitySource({
      readerFactory: gate.readerFactory,
      onDiagnostic: (diagnostic) => {
        logError(JSON.stringify({ diagnostic: diagnostic.kind, message: diagnostic.message }));
      },
    });
  }
  // The same invariant startup has always enforced, one level up: `sources`
  // used to count observers plus gate, so a catalog with no startable entries
  // (and no gate) refused here too. A gate counts — it is the one source a
  // session can run with, paused, while the panel offers the rest.
  const startableCount = entries.filter((entry) => entry.create !== undefined).length;
  if (startableCount + (gate.enabled ? 1 : 0) === 0) {
    if (panelServer !== undefined) await panelServer.close();
    await drainAgentTurns();
    agent?.dispose();
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
    // The newest projection, kept for needs_config recovery: an agent started
    // later observes this instead of waking up blind to the world it missed.
    lastState = ingested.ingest.state;
    // A duplicate changed nothing about the world, so there is nothing new for
    // the agent to see and no reason to spend a turn on it.
    if (ingested.ingest.disposition === "duplicate") return;
    // Headless mode has no agent tail: nothing to observe into, nothing to
    // prompt. The projection below still runs — the world keeps being seen;
    // only the thinking about it waits.
    if (agent !== undefined) await agent.observe(ingested.ingest.state);
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

  const sourceManager = new SourceManager({
    entries,
    emit: ingest,
    log,
    logError,
  });
  sourceManagerRef.manager = sourceManager;

  // Started one at a time (the manager's startAll) rather than with
  // Promise.all: a source that rejects must not leave a sibling half-started
  // with no handle to stop it. The gate starts after every observer, per the
  // ordering rule its construction comment states.
  try {
    await sourceManager.startAll();
    if (gateSource !== undefined) await gateSource.start(ingest);
  } catch (error) {
    // A source that failed mid-start may already have emitted, so a turn can
    // be in flight on this path rather than only in theory.
    await sourceManager.stopAll();
    if (panelServer !== undefined) await panelServer.close();
    await drainAgentTurns();
    agent?.dispose();
    await watch.dispose();
    return { configError: `A source failed to start: ${describeErrorForAudit(error)}` };
  }

  // What actually started: every startable entry (startAll just proved it) in
  // declaration order, then the gate. The banner and the id list tell the truth
  // about the run — an unsupported entry never appears as if it were observing.
  const startedSourceIds = [
    ...sourceManager.snapshot()
      .filter((entry) => entry.state === "running")
      .map((entry) => entry.id),
    ...(gateSource === undefined ? [] : [gateSource.id]),
  ];

  let stopped = false;
  const session: WatchSession = {
    banner: {
      ...(options.banner ?? {}),
      sources: startedSourceIds.join(","),
      store: watch.databasePath ?? "memory",
      agent: agent === undefined ? "needs_config" : "resident",
      panel: panel.enabled ? panel.socketPath : "off",
      control: gate.enabled ? gate.readerKind : "off",
      retention: retention.enabled ? retention.hours : "off",
      agentTurnTimeoutMs: turnTimeout.timeoutMs,
      ...(pruneSummary === undefined ? {} : { prunedEvents: pruneSummary.removedEvents }),
      restoredActions: restored.recentActions.length,
    },
    runtime: watch,
    agent,
    sourceIds: startedSourceIds,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      // Sources first, in reverse start order, so a later source never emits
      // into one already torn down. The gate started last, so it stops first;
      // the manager's stopAll then walks the observers in reverse declaration
      // order. Hot-toggled sources are simply wherever `running` left them.
      if (gateSource !== undefined) await gateSource.stop();
      await sourceManager.stopAll();
      // Then the agent's turns, while its session is still open: a turn cut off
      // mid-flight loses whatever the agent was doing, and its session history is
      // the only record that it happened. The panel closes after that drain, so
      // a turn settling during shutdown still reaches the window. Only then the
      // agent itself, and only then the store — an in-flight ingest still needs
      // somewhere to land.
      await drainAgentTurns();
      // After the drain, beside the panel: a turn that settled during shutdown
      // has already been announced, and closing first would have swallowed it.
      // What close() does not do is flush — a notice is an interruption, and a
      // run that is over has nothing left for the person to interrupt.
      await notifier?.close();
      // Withdraw before tearing down the transport. An answered or cancelled
      // panel request is spent; a stop never leaves a live-looking prompt.
      await panelConfirmation.close();
      if (panelServer !== undefined) await panelServer.close();
      agent?.dispose();
      await watch.dispose();
    },
  };
  // The restart hook reads this: the session now exists, so a restart that
  // lands from here on stops the real thing instead of being told "starting".
  sessionRef.session = session;
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
 * How long an aborted session may take to settle before the turn tail advances
 * anyway. Generous next to a model's TTFT, tiny next to the turn timeout — it
 * bounds the wait on a clean abort, not the wedge the timeout exists to break.
 */
const ABORT_GRACE_MS = 5_000;

/**
 * Whether a root-relative POSIX path may enter the timeline.
 *
 * A predicate rather than a set because the exclusions are two different shapes:
 * the SQLite sink is four exact files, while the agent directory is a whole
 * subtree — every conversation append, auth refresh, and models.json write lands
 * somewhere under it, and naming them individually is how the next Pi file
 * reopens the loop.
 */
export type SinkExclusion = (relativePath: string) => boolean;

/**
 * Builds the exclusion predicate a filesystem source must apply, because Squid's
 * own sinks live inside the watched tree.
 *
 * Two sinks, both feed their own writes back into the timeline if left visible:
 *
 * - The event database. Every ingest appends, the watcher reports the append,
 *   ingesting it appends again.
 * - Pi's agent directory (`~/.pi/agent` by default). The resident agent's
   `cwd` *is* the watched root, so `SessionManager.create(cwd)` files the
   conversation under `<agentDir>/sessions/<encoded-cwd>/` — inside the root the
   packaged app watches by default (`$HOME`). Each turn appends the session file,
 *   the watcher reports `file_saved`, the observation triggers another turn: the
 *   self-triggering loop. `auth.json` refreshes and `models.json` writes ignite
 *   the same way, so the whole subtree is excluded, not just sessions.
 *
 * Both sides must be canonical — the source reports paths relative to
 * `realpath(root)`, so comparing against a symlinked spelling would silently
 * match nothing and let a loop back in. A sink outside the root contributes
 * nothing (`sqliteWatchExclusions` returns empty; a relative escape means
 * outside), so an unrelated sibling path is never excluded by accident. An
 * in-memory run has no database, and a filesystem source has nothing to say
 * about the agent directory in the first place, so neither entry excludes when
 * absent.
 */
export async function watchedSinkExclusions(
  context: WatchSourceContext,
  canonicalRoot: string,
): Promise<SinkExclusion> {
  const exact = new Set<string>();
  if (context.databasePath !== undefined) {
    for (const path of sqliteWatchExclusions(canonicalRoot, await realpath(context.databasePath))) {
      exact.add(path);
    }
  }

  const agentPrefix = await agentDirPrefixUnder(canonicalRoot, context.agentDir);
  if (agentPrefix === null) {
    return (relativePath) => exact.has(relativePath);
  }
  return (relativePath) =>
    exact.has(relativePath) || relativePath === agentPrefix || relativePath.startsWith(`${agentPrefix}/`);
}

/**
 * The agent directory as a root-relative POSIX prefix, or null when it lies
 * outside the root or cannot be resolved.
 *
 * `getAgentDir()` reads the process environment (`PI_CODING_AGENT_DIR`) or
 * defaults under `$HOME`; canonicalizing it matches it against the canonical
 * root the same way `sqliteWatchExclusions` matches the database. A test
 * injects its own `agentDir` through the context, so no suite reads the
 * developer machine's Pi files.
 */
async function agentDirPrefixUnder(
  canonicalRoot: string,
  agentDir: string | undefined,
): Promise<string | null> {
  if (agentDir === undefined) return null;
  let canonical: string;
  try {
    canonical = await realpath(agentDir);
  } catch {
    // Not there yet — a first run has no agent directory until Pi writes one.
    // A missing directory cannot feed a loop, and the exclusion has nothing to
    // name; when Pi creates it, the next session start picks it up.
    return null;
  }
  const relativePath = relative(canonicalRoot, canonical);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    return null;
  }
  return relativePath.split(sep).join("/");
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
