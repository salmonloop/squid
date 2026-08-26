import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isAbsolute } from "node:path";
import { parse } from "shell-quote";
import {
  CapabilityDispatcher,
  type DispatchOutcome,
} from "./capability-gateway.js";
import type { ActionConfirmationPolicy, SerialConfirmationPolicy } from "./action-confirmation.js";
import { createTerminalActionConfirmation } from "./confirmation-surface-terminal.js";
import { createGraphicalActionConfirmation } from "./confirmation-surface-graphical.js";
import { createStdioGraphicalTransport } from "./graphical-transport-stdio.js";
import {
  isPlanFailure,
  planAction,
  type ActionPlanningContext,
} from "./action-planner.js";
import { resolveSearchEgress, type EgressPolicy } from "./action-egress.js";
import { basename } from "./context-policy.js";
import { McpCapabilityGateway } from "./mcp-gateway.js";
import type { ProjectProfile } from "./project-detect.js";
import type { PredictionCandidate, WorldState } from "./protocol.js";
import type { PredictionLedger } from "./prediction-ledger.js";
import type { PredictionRuntime } from "./prediction-runtime.js";
import type { IngestDisposition } from "./squid-core.js";

export interface WatchActionsResolution {
  readonly gatewayId: string;
  readonly egressPolicy: EgressPolicy;
  dispatchTopCandidate(
    outcome: { readonly requestId: string },
    candidates: readonly PredictionCandidate[],
    /** Disposition of the triggering event; late triggers never dispatch. */
    triggerDisposition?: IngestDisposition,
    /**
     * Raw state of the triggering ingest, when the run's projection redacts
     * action targets — the only situation where a candidate may name a basename
     * for a file raw state holds as a path. The resolver is built per call so
     * it reads the state this exact prediction was triggered from, not whatever
     * happens to be current by the time the provider answers.
     */
    rawState?: WorldState,
  ): Promise<DispatchOutcome | null>;
  /** Closes the client transport. */
  close(): Promise<void>;
}

export type LiteralCommandParseResult =
  | { readonly command: string; readonly args: readonly string[] }
  | { readonly configError: string };

/**
 * Which surface will ask the question, and everything that surface needs.
 *
 * A union rather than a mode string beside an optional command, because those
 * two fields have an invariant between them — a graphical mode with nothing to
 * spawn is not a configuration, it is a bug — and an invariant a comment asserts
 * is one a later edit can break. Here it is unrepresentable.
 */
export type ConfirmationSurfaceChoice =
  | { readonly mode: "terminal" }
  | { readonly mode: "graphical"; readonly command: string; readonly args: readonly string[] };

/**
 * Builds the confirmation engine for one surface choice.
 *
 * Exported separately from `resolveWatchActions` so the mode→surface mapping is
 * observable on its own: that function opens an MCP transport several steps
 * before it reaches this decision, so a test of *this* would otherwise have to
 * spawn a server to watch it happen.
 *
 * Both modes compose the same engine — `SerialConfirmationPolicy` — over a
 * different surface. Serialization, the double expiry check, and every
 * fail-closed reason therefore stay in one place instead of forking per surface,
 * and a new surface cannot arrive with its own idea of what a timeout means.
 *
 * The graphical process is spawned lazily by the transport, on the first prompt.
 * Constructing a policy must not open a window: configuration resolution runs at
 * startup, long before anything is worth confirming.
 *
 * Returns the concrete engine rather than the `ActionConfirmationPolicy` port,
 * because both branches do and `surfaceId` is the only way to see from outside
 * which surface a mode actually produced.
 */
export function createConfirmation(
  choice: ConfirmationSurfaceChoice,
  options: { readonly timeoutMs?: number } = {},
): SerialConfirmationPolicy {
  const timeout = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
  switch (choice.mode) {
    case "terminal":
      return createTerminalActionConfirmation(timeout);
    case "graphical":
      return createGraphicalActionConfirmation({
        transport: createStdioGraphicalTransport({
          command: choice.command,
          args: [...choice.args],
        }),
        ...timeout,
      });
  }
}

/**
 * Parses a command line without invoking a shell or expanding variables.
 *
 * `variableName` is required rather than defaulted: more than one environment
 * variable now holds a spawnable command, and a default would let a new caller
 * silently blame the wrong variable in its config error.
 */
export function parseLiteralCommand(
  command: string,
  variableName: string,
): LiteralCommandParseResult {
  if (command.includes("`") || /[\u0000-\u001F\u007F]/u.test(command)) {
    return {
      configError: `${variableName} contains command-substitution or control characters.`,
    };
  }
  const parsed = parse(command, (name) => ({ environmentVariable: name }));
  const executable = parsed[0];
  if (
    parsed.length === 0 ||
    parsed.some((part) => typeof part !== "string") ||
    typeof executable !== "string" ||
    executable.length === 0
  ) {
    return {
      configError: `${variableName} must be one executable plus literal arguments; shell operators, variables, substitutions, comments, and globs are not allowed.`,
    };
  }
  const literalCommand = parsed as string[];
  const [literalExecutable, ...args] = literalCommand;
  return { command: literalExecutable!, args };
}

/**
 * Wires the real MCP transport and dispatcher seams together from the
 * environment variables the watch entry points use — the same split as
 * `watch-provider.ts`: everything env-dependent and dependency-heavy lives
 * here, while the pieces underneath are pure and unit-tested.
 *
 * Returning `undefined` means actions stay off — the default, identical to
 * the pre-dispatch behavior. A recognized variable holding an unrecognized
 * value is a config error, reported before any sink opens, so a typo cannot
 * silently disable execution and look like a working setup.
 */
export async function resolveWatchActions(
  runtime: PredictionRuntime,
  ledger: PredictionLedger,
  env: Record<string, string | undefined> = process.env,
  options: {
    readonly workingDirectory?: string;
    /**
     * Detected once by the session layer and threaded through, so every
     * planning call in this process reuses the same project profile instead of
     * re-reading the directory.
     */
    readonly project?: ProjectProfile;
    readonly actionTrust?: "trusted" | "suggestion_only";
    /**
     * The policy the runtime was built with. Supplying it here keeps one
     * resolution for the whole process; omitting it re-resolves from `env`,
     * which is only safe when no runtime stamped a different id.
     */
    readonly egressPolicy?: EgressPolicy;
    /**
     * Whether that projection narrows action targets, declared by the policy
     * itself rather than inferred from its id. When true, dispatch accepts a
     * raw-state resolver per call so basename proposals can be resolved before
     * planning; when false, none is ever built and proposals are taken as-is.
     */
    readonly redactsActionTargets?: boolean;
  } = {},
): Promise<WatchActionsResolution | undefined | { readonly configError: string }> {
  // Actions are on when the MCP command is present, with or without the
  // explicit `SQUID_ACTIONS=mcp` spelling — open by default: the command is
  // the capability's real opt-in and the variable was a second key for the
  // same door. The explicit spelling still works, and a recognized-but-wrong
  // value still fails startup rather than silently disabling execution.
  //
  // The off check runs before every other validation: a run that never asked
  // for actions must not fail startup over an unrelated provider-trust or
  // egress complaint — staying off is the pre-action behavior, not an error.
  const mode = env.SQUID_ACTIONS;
  const command = env.SQUID_ACTIONS_MCP_COMMAND?.trim();
  if (mode === undefined && (command === undefined || command.length === 0)) {
    return undefined;
  }
  if (mode !== undefined && mode !== "mcp") {
    return { configError: 'SQUID_ACTIONS must be "mcp" or unset.' };
  }
  if (options.actionTrust === "suggestion_only") {
    return { configError: "The selected provider is suggestion-only; actions require a replay-gated trusted provider." };
  }

  if (command === undefined || command.length === 0) {
    return { configError: "SQUID_ACTIONS=mcp requires SQUID_ACTIONS_MCP_COMMAND." };
  }

  const parsedCommand = parseLiteralCommand(command, "SQUID_ACTIONS_MCP_COMMAND");
  if ("configError" in parsedCommand) {
    return parsedCommand;
  }
  const rawTimeoutMs = env.SQUID_ACTION_CONFIRM_TIMEOUT_MS;
  const timeoutMs = rawTimeoutMs === undefined ? undefined : Number(rawTimeoutMs);
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    return { configError: "SQUID_ACTION_CONFIRM_TIMEOUT_MS must be a positive integer number of milliseconds." };
  }
  const confirmationMode = env.SQUID_ACTION_CONFIRM;
  if (
    confirmationMode !== undefined &&
    confirmationMode !== "terminal" &&
    confirmationMode !== "graphical"
  ) {
    return { configError: 'SQUID_ACTION_CONFIRM must be "terminal", "graphical", or unset.' };
  }
  // The timeout belongs to the confirmation engine, not to any one surface, so
  // it is legal with every mode and meaningless without one.
  if (rawTimeoutMs !== undefined && confirmationMode === undefined) {
    return { configError: "SQUID_ACTION_CONFIRM_TIMEOUT_MS requires SQUID_ACTION_CONFIRM." };
  }

  // The graphical surface spawns a separate process, so its command goes
  // through the same no-shell parse as the MCP server command. Parsing happens
  // here, before any transport opens; the process itself is spawned lazily on
  // the first prompt so that resolving configuration never opens a window.
  const graphicalCommand = env.SQUID_GRAPHICAL_UI_COMMAND?.trim();
  if (graphicalCommand !== undefined && confirmationMode !== "graphical") {
    return { configError: "SQUID_GRAPHICAL_UI_COMMAND requires SQUID_ACTION_CONFIRM=graphical." };
  }
  let surfaceChoice: ConfirmationSurfaceChoice | undefined =
    confirmationMode === "terminal" ? { mode: "terminal" } : undefined;
  if (confirmationMode === "graphical") {
    if (graphicalCommand === undefined || graphicalCommand.length === 0) {
      return { configError: "SQUID_ACTION_CONFIRM=graphical requires SQUID_GRAPHICAL_UI_COMMAND." };
    }
    const parsed = parseLiteralCommand(graphicalCommand, "SQUID_GRAPHICAL_UI_COMMAND");
    if ("configError" in parsed) {
      return parsed;
    }
    surfaceChoice = { mode: "graphical", command: parsed.command, args: parsed.args };
  }
  const workingDirectory = env.SQUID_ACTION_WORKDIR ?? options.workingDirectory;
  if (workingDirectory !== undefined && !isAbsolute(workingDirectory)) {
    return { configError: "Action working directory must be an absolute path." };
  }
  if (workingDirectory !== undefined && /[\u0000-\u001F\u007F]/u.test(workingDirectory)) {
    return { configError: "Action working directory must not contain control characters." };
  }
  // Confirmation exists to gate commands, and a command plan is only
  // canonicalizable against a known directory. That is a property of the plan,
  // not of the surface showing it, so every confirmation mode requires one.
  if (confirmationMode !== undefined && workingDirectory === undefined) {
    return { configError: `SQUID_ACTION_CONFIRM=${confirmationMode} requires an action working directory.` };
  }
  // Egress is resolved before any transport opens: an invalid value must fail
  // startup rather than surface once a server is already running. Unset means
  // deny, so search actions stay off unless explicitly enabled.
  const egress = options.egressPolicy ?? resolveSearchEgress(env.SQUID_SEARCH_EGRESS);
  if ("configError" in egress) {
    return egress;
  }

  const client = new Client({ name: "squid", version: "0.1.0" });
  await client.connect(new StdioClientTransport({
    command: parsedCommand.command,
    args: [...parsedCommand.args],
  }));

  const gateway = new McpCapabilityGateway({
    client,
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
  });
  const confirmation: ActionConfirmationPolicy | undefined =
    surfaceChoice === undefined
      ? undefined
      : createConfirmation(surfaceChoice, timeoutMs === undefined ? {} : { timeoutMs });
  const dispatcher = new CapabilityDispatcher({
    runtime,
    gateway,
    ledger,
    ...(confirmation === undefined ? {} : { confirmation }),
  });
  const pending = new Set<Promise<DispatchOutcome | null>>();
  let closing = false;
  return {
    gatewayId: gateway.id,
    egressPolicy: egress,
    dispatchTopCandidate: (outcome, candidates, triggerDisposition, rawState) => {
      if (closing) return Promise.resolve(null);
      const operation = dispatchTopCandidate(outcome, candidates, dispatcher, {
        egressPolicy: egress,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(triggerDisposition === undefined ? {} : { triggerDisposition }),
        // Resolution is armed only when the projection actually redacts
        // targets; the resolver reads the triggering ingest's own raw state.
        ...(options.redactsActionTargets === true && rawState !== undefined
          ? { resolveRedactedSave: (base: string) => uniqueSaveTarget(rawState, base) }
          : {}),
      });
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    },
    close: async () => {
      closing = true;
      await confirmation?.close?.();
      await Promise.allSettled(pending);
      await client.close();
    },
  };
}

/**
 * The action half of the closed loop: after a prediction outcome settles, try to
 * dispatch its single best candidate.
 *
 * Only the top-confidence candidate is ever considered. Falling back to a
 * lower-confidence candidate when the best one is refused would mean the system
 * quietly does something the ranking did not choose, so a refusal ends the
 * attempt rather than starting a search for something that passes.
 *
 * Planning happens exactly once here. The resulting immutable plan — not the
 * candidate — is what the dispatcher confirms, claims, and invokes.
 */
export interface DispatchCandidateOptions {
  readonly egressPolicy: EgressPolicy;
  readonly workingDirectory?: string;
  /**
   * What the project declares it can run, detected once per session by whoever
   * owns the watch loop. Omitted means detection runs per planning call —
   * correct but repeated work on a filesystem-bound path.
   */
  readonly project?: ProjectProfile;
  /**
   * Resolves a redacted basename against raw saves, handed down to the planner.
   * Supplied only when the run's projection redacts action targets — under any
   * other policy a full-path proposal is used exactly as proposed, and no
   * inference about the model's view happens at all.
   */
  readonly resolveRedactedSave?: (basename: string) => string | null;
  readonly now?: () => Date;
  /**
   * Disposition of the event that triggered this prediction. A late event
   * reprojects history and may still produce a useful prediction, but acting on
   * one would mean acting on a world that has already moved past it — so late
   * predictions stay observational. Defaults to "accepted" for callers that only
   * ever ingest in order.
   */
  readonly triggerDisposition?: IngestDisposition;
}

/**
 * The one raw save whose target ends with this basename, or null.
 *
 * Null covers both honest failures — nothing saved under that name, and two
 * files sharing it. The ambiguity case is the safety-critical one: resolving a
 * shared basename by picking either match would run tests for a file nobody
 * proposed, so both matches mean no answer. Only `file_saved` actions count,
 * because that is the fact `run_tests`' guard checks against; other action
 * kinds carry targets but are not what a test run is authorized on.
 */
export function uniqueSaveTarget(
  state: WorldState,
  base: string,
): string | null {
  // Matching uses the same `basename` that produced the narrowed targets, so
  // resolution and redaction are one contract in one file — a change to how
  // basenames are taken cannot leave this side matching on a stale spelling.
  const targets = state.recentActions
    .filter((action) => action.kind === "file_saved" && action.target !== null)
    .map((action) => action.target!)
    .filter((target) => basename(target) === base);
  const unique = new Set(targets);
  return unique.size === 1 ? [...unique][0]! : null;
}

export async function dispatchTopCandidate(
  outcome: { readonly requestId: string },
  candidates: readonly PredictionCandidate[],
  dispatcher: CapabilityDispatcher,
  options: DispatchCandidateOptions,
): Promise<DispatchOutcome | null> {
  const now = options.now ?? (() => new Date());

  // Refused before any planning work: a late trigger cannot authorize an action
  // no matter how good its candidate looks. Admission would refuse the claim
  // anyway, but stopping here means no plan is built and no confirmation is
  // shown for something that could never run.
  if ((options.triggerDisposition ?? "accepted") !== "accepted") {
    return null;
  }

  // Rank first, then take exactly one. `ordinal` is the candidate's position in
  // the original outcome, which is what the ledger's candidate IDs encode.
  const ranked = candidates
    .map((candidate, ordinal) => ({ candidate, ordinal }))
    .sort((left, right) => right.candidate.confidence - left.candidate.confidence);
  const top = ranked[0];
  if (top === undefined) {
    return null;
  }

  // Expiry is checked here and again inside admission. Checking early avoids
  // planning work for a dead candidate; checking late is what actually protects
  // the dispatch, because confirmation can take longer than the TTL.
  if (Date.parse(top.candidate.expiresAt) <= now().getTime()) {
    return null;
  }

  const candidateId = `${outcome.requestId}:candidate:${top.ordinal}`;
  const planned = await planAction(
    {
      candidateId,
      attemptId: outcome.requestId,
      kind: top.candidate.kind,
      toolId: top.candidate.toolId,
      parameters: top.candidate.parameters,
    },
    {
      ...(options.workingDirectory === undefined
        ? {}
        : { workingDirectory: options.workingDirectory }),
      ...(options.project === undefined ? {} : { project: options.project }),
      ...(options.resolveRedactedSave === undefined
        ? {}
        : { resolveRedactedSave: options.resolveRedactedSave }),
    },
  );
  if (isPlanFailure(planned)) {
    // An unmappable top candidate is not an error and not a reason to try the
    // next one: there is simply no action to take for this prediction.
    return null;
  }

  return dispatcher.dispatch({
    plan: planned.plan,
    planDigest: planned.planDigest,
    candidateParametersDigest: planned.candidateParametersDigest,
    candidate: top.candidate,
    egressPolicy: options.egressPolicy,
  });
}
