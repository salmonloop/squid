import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isAbsolute } from "node:path";
import { parse } from "shell-quote";
import {
  CapabilityDispatcher,
  type ActionRequest,
  type ActionResult,
} from "./capability-gateway.js";
import {
  TerminalActionConfirmation,
  type ActionConfirmationDecision,
  type ActionConfirmationPolicy,
} from "./action-confirmation.js";
import {
  isActionPlanFailure,
  planCapabilityAction,
  type CapabilityActionPlan,
  type CapabilityActionPlanFailure,
} from "./action-plan.js";
import { McpCapabilityGateway } from "./mcp-gateway.js";
import type { PredictionCandidate } from "./protocol.js";
import type {
  PredictionFeedbackInput,
  PredictionLedger,
} from "./prediction-ledger.js";
import type { PredictionRuntime } from "./prediction-runtime.js";

export interface WatchActionsResolution {
  readonly gatewayId: string;
  dispatchTopCandidate(
    outcome: { readonly requestId: string },
    candidates: readonly PredictionCandidate[],
  ): Promise<DispatchCandidateResult | null>;
  /** Closes the client transport. */
  close(): Promise<void>;
}

export type LiteralCommandParseResult =
  | { readonly command: string; readonly args: readonly string[] }
  | { readonly configError: string };

/** Parses a command line without invoking a shell or expanding variables. */
export function parseLiteralCommand(command: string): LiteralCommandParseResult {
  if (command.includes("`") || /[\u0000-\u001F\u007F]/u.test(command)) {
    return {
      configError: "SQUID_ACTIONS_MCP_COMMAND contains command-substitution or control characters.",
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
      configError: "SQUID_ACTIONS_MCP_COMMAND must be one executable plus literal arguments; shell operators, variables, substitutions, comments, and globs are not allowed.",
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
  options: { readonly workingDirectory?: string } = {},
): Promise<WatchActionsResolution | undefined | { readonly configError: string }> {
  const mode = env.SQUID_ACTIONS;
  if (mode === undefined) {
    return undefined;
  }
  if (mode !== "mcp") {
    return { configError: 'SQUID_ACTIONS must be "mcp" or unset.' };
  }

  const command = env.SQUID_ACTIONS_MCP_COMMAND?.trim();
  if (command === undefined || command.length === 0) {
    return { configError: "SQUID_ACTIONS=mcp requires SQUID_ACTIONS_MCP_COMMAND." };
  }

  const parsedCommand = parseLiteralCommand(command);
  if ("configError" in parsedCommand) {
    return parsedCommand;
  }
  const rawTimeoutMs = env.SQUID_ACTION_CONFIRM_TIMEOUT_MS;
  const timeoutMs = rawTimeoutMs === undefined ? undefined : Number(rawTimeoutMs);
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    return { configError: "SQUID_ACTION_CONFIRM_TIMEOUT_MS must be a positive integer number of milliseconds." };
  }
  const confirmationMode = env.SQUID_ACTION_CONFIRM;
  if (confirmationMode !== undefined && confirmationMode !== "terminal") {
    return { configError: 'SQUID_ACTION_CONFIRM must be "terminal" or unset.' };
  }
  if (rawTimeoutMs !== undefined && confirmationMode !== "terminal") {
    return { configError: "SQUID_ACTION_CONFIRM_TIMEOUT_MS requires SQUID_ACTION_CONFIRM=terminal." };
  }
  const workingDirectory = env.SQUID_ACTION_WORKDIR ?? options.workingDirectory;
  if (workingDirectory !== undefined && !isAbsolute(workingDirectory)) {
    return { configError: "Action working directory must be an absolute path." };
  }
  if (workingDirectory !== undefined && /[\u0000-\u001F\u007F]/u.test(workingDirectory)) {
    return { configError: "Action working directory must not contain control characters." };
  }
  if (confirmationMode === "terminal" && workingDirectory === undefined) {
    return { configError: "SQUID_ACTION_CONFIRM=terminal requires an action working directory." };
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
  const dispatcher = new CapabilityDispatcher({ runtime, gateway, ledger });
  const confirmation = confirmationMode === "terminal"
    ? new TerminalActionConfirmation(timeoutMs === undefined ? {} : { timeoutMs })
    : undefined;
  const pending = new Set<Promise<DispatchCandidateResult | null>>();
  let closing = false;
  return {
    gatewayId: gateway.id,
    dispatchTopCandidate: (outcome, candidates) => {
      if (closing) return Promise.resolve(null);
      const operation = dispatchTopCandidate(outcome, candidates, dispatcher, {
        ...(confirmation === undefined ? {} : { confirmation }),
        planner: (request) => gateway.plan(request),
        recordFeedback: (input) => runtime.recordFeedback(input),
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
 * The action half of the closed loop: after a prediction outcome settles,
 * dispatch its best still-fresh planned candidate through the given dispatcher,
 * optionally passing confirmation-required plans through the configured policy.
 *
 * Expiry is enforced here because nothing else does — the coordinator ranks
 * candidates but never checks `expiresAt`, so an expired candidate that sat at
 * the top would otherwise execute on stale context. Confirmation-required
 * plans are ignored unless both a policy and feedback recorder are present.
 *
 * The candidate ID format (`requestId:candidate:ordinal`) is derived from the
 * candidate's position in the outcome rather than carried separately — the
 * dispatcher re-resolves it against the ledger and refuses unknown IDs, so a
 * wrong derivation surfaces as a failed dispatch, not a silent no-op.
 */
export interface DispatchCandidateResult {
  readonly candidateId: string;
  readonly decision: ActionConfirmationDecision | null;
  readonly action: ActionResult | null;
}

export interface DispatchCandidateOptions {
  readonly confirmation?: ActionConfirmationPolicy;
  readonly now?: () => Date;
  readonly recordFeedback?: (input: PredictionFeedbackInput) => Promise<void>;
  readonly planner?: (
    request: ActionRequest,
  ) => CapabilityActionPlan | CapabilityActionPlanFailure;
}

export async function dispatchTopCandidate(
  outcome: { readonly requestId: string },
  candidates: readonly PredictionCandidate[],
  dispatcher: CapabilityDispatcher,
  options: DispatchCandidateOptions = {},
): Promise<DispatchCandidateResult | null> {
  const confirmation = options.confirmation;
  const now = options.now ?? (() => new Date());
  const recordFeedback = options.recordFeedback;
  const planner = options.planner ?? ((request: ActionRequest) =>
    planCapabilityAction(request.kind, request.parameters));
  const nowMs = now().getTime();
  const eligible = candidates
    .map((candidate, ordinal) => ({
      candidate,
      ordinal,
      candidateId: `${outcome.requestId}:candidate:${ordinal}`,
    }))
    .map((item) => ({
      ...item,
      plan: planner({
        candidateId: item.candidateId,
        kind: item.candidate.kind,
        parameters: item.candidate.parameters,
      }),
    }))
    .filter((item): item is typeof item & { plan: Exclude<typeof item.plan, { readonly error: string }> } =>
      !isActionPlanFailure(item.plan))
    .filter(({ plan }) =>
      plan.confirmation !== "required" ||
      (confirmation !== undefined && recordFeedback !== undefined))
    .filter(({ candidate }) => Date.parse(candidate.expiresAt) > nowMs)
    .sort((left, right) => right.candidate.confidence - left.candidate.confidence);

  const chosen = eligible[0];
  if (chosen === undefined) {
    return null;
  }

  const { candidateId } = chosen;
  if (isActionPlanFailure(chosen.plan)) {
    throw new TypeError("Filtered action plan unexpectedly failed.");
  }
  if (chosen.plan.confirmation === "required") {
    if (confirmation === undefined || recordFeedback === undefined) {
      throw new TypeError("Confirmation-required action reached dispatch without its policy and feedback recorder.");
    }
    const decision = await confirmation.confirm({
      candidateId,
      plan: chosen.plan,
      expiresAt: chosen.candidate.expiresAt,
    });
    await recordConfirmation(outcome.requestId, candidateId, decision, chosen.plan.summary, recordFeedback);
    if (decision.outcome !== "accepted") {
      return { candidateId, decision, action: null };
    }
    // Confirmation may have taken long enough for the candidate to go stale.
    if (Date.parse(chosen.candidate.expiresAt) <= now().getTime()) {
      const expired: ActionConfirmationDecision = {
        outcome: "expired",
        reason: "candidate_expired",
      };
      await recordConfirmation(outcome.requestId, candidateId, expired, chosen.plan.summary, recordFeedback);
      return { candidateId, decision: expired, action: null };
    }
    return {
      candidateId,
      decision,
      action: await dispatcher.dispatch(candidateId),
    };
  }

  return {
    candidateId,
    decision: null,
    action: await dispatcher.dispatch(candidateId),
  };
}

async function recordConfirmation(
  requestId: string,
  candidateId: string,
  decision: ActionConfirmationDecision,
  action: string,
  recordFeedback: (input: PredictionFeedbackInput) => Promise<void>,
): Promise<void> {
  const input: PredictionFeedbackInput = {
    feedbackId: `${candidateId}:${decision.outcome}:confirmation:${crypto.randomUUID()}`,
    requestId,
    candidateId,
    feedback: decision.outcome,
    details: { source: "terminal_confirmation", reason: decision.reason, action },
  };
  await recordFeedback(input);
}
