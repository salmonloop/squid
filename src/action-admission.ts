import { createHash } from "node:crypto";
import { canonicalJson } from "./state-digest.js";
import type { EgressPolicy } from "./action-egress.js";
import type { ActionablePredictionKind } from "./action-plan.js";
import type { PredictionAttemptRecord } from "./prediction-ledger.js";
import type { PredictionCandidate, WorldState } from "./protocol.js";

/**
 * The immutable plan a single admitted candidate will execute.
 *
 * Everything that could still vary — a relative path, a symlinked working
 * directory, a selection read from a stale projection — is already resolved
 * by the planner. Admission only validates; it never re-plans. Confirmation,
 * claim, and gateway invocation all reference this exact object, so the user
 * cannot approve one operation while another is dispatched.
 */
export interface ImmutableActionPlan {
  readonly planSchemaVersion: 1;
  readonly kind: ActionablePredictionKind;
  readonly candidateId: string;
  readonly attemptId: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, string | number | boolean | null>>;
  /**
   * Operator-facing description. Never contains selection text: a summary that
   * quoted the selection would put user text into logs and the ledger, which is
   * exactly what the audit rules forbid.
   */
  readonly summary: string;
  readonly confirmation: "none" | "required";
  /** Canonical realpath of the directory a command runs in, or null for non-command plans. */
  readonly canonicalWorkingDirectory: string | null;
  /** Canonical realpath of the file a command targets, or null when there is none. */
  readonly canonicalTarget: string | null;
}

/** Stable digest over the canonical plan. Shared by confirm, claim, and invoke. */
export function digestActionPlan(plan: ImmutableActionPlan): string {
  const hash = createHash("sha256")
    .update(canonicalJson({ algorithmVersion: "action-plan-v1", plan }))
    .digest("hex");
  return `sha256:${hash}`;
}

/** Digest over candidate parameters, so the ledger can prove sameness without raw text. */
export function digestCandidateParameters(
  parameters: PredictionCandidate["parameters"],
): string {
  const hash = createHash("sha256")
    .update(canonicalJson({ algorithmVersion: "candidate-parameters-v1", parameters }))
    .digest("hex");
  return `sha256:${hash}`;
}

/**
 * Fixed vocabulary of admission refusals. Reason codes are stable identifiers
 * rather than prose: they are compared in tests, counted in diagnostics, and
 * written to the ledger, so they must never carry user text.
 */
export type AdmissionReasonCode =
  | "attempt_missing"
  | "attempt_schema_unsupported"
  | "candidate_unknown"
  | "runtime_session_mismatch"
  | "episode_mismatch"
  | "state_digest_mismatch"
  | "projection_generation_mismatch"
  | "trigger_disposition_late"
  | "action_trust_insufficient"
  | "context_policy_mismatch"
  | "egress_policy_mismatch"
  | "candidate_expired"
  | "selection_changed"
  | "selection_empty"
  | "browser_page_missing"
  | "owner_mismatch"
  | "observation_out_of_order"
  | "search_egress_denied"
  | "coding_application_mismatch"
  | "saved_path_mismatch"
  | "plan_kind_unsupported";

export type AdmissionResult =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reasonCode: AdmissionReasonCode };

/**
 * Everything admission is allowed to look at. Passing the current metadata
 * explicitly (rather than reading a live runtime) is what makes this function
 * pure: the same inputs always produce the same verdict, and the caller is
 * forced to snapshot state before the check rather than after.
 */
export interface AdmissionContext {
  readonly plan: ImmutableActionPlan;
  readonly attempt: PredictionAttemptRecord | undefined;
  readonly candidate: PredictionCandidate | undefined;
  readonly state: WorldState;
  readonly runtimeSessionId: string;
  readonly stateDigest: string;
  readonly projectionGeneration: number;
  readonly contextPolicyId: string;
  readonly actionTrust: "trusted" | "suggestion_only";
  readonly egressPolicy: EgressPolicy;
  readonly now: Date;
}

/**
 * Decides whether one already-planned action may run, right now, against this
 * exact projection.
 *
 * Every check is a refusal, never a repair: a mismatch means the world moved
 * since the prediction was made, and the correct response is to drop the action
 * rather than to re-plan it against newer state. Callers re-run this inside the
 * serial claim boundary, because a verdict computed before confirmation says
 * nothing about the world after it.
 */
export function admitAction(context: AdmissionContext): AdmissionResult {
  const { plan, attempt, candidate, state } = context;

  if (attempt === undefined) return refuse("attempt_missing");
  if (attempt.schemaVersion !== 2) return refuse("attempt_schema_unsupported");
  if (candidate === undefined) return refuse("candidate_unknown");

  if (attempt.runtimeSessionId !== context.runtimeSessionId) return refuse("runtime_session_mismatch");
  if (attempt.episodeId !== (state.episode?.id ?? null)) return refuse("episode_mismatch");
  if (attempt.stateDigest !== context.stateDigest) return refuse("state_digest_mismatch");
  if (attempt.projectionGeneration !== context.projectionGeneration) {
    return refuse("projection_generation_mismatch");
  }
  if (attempt.triggerDisposition !== "accepted") return refuse("trigger_disposition_late");
  if (attempt.actionTrust !== "trusted" || context.actionTrust !== "trusted") {
    return refuse("action_trust_insufficient");
  }
  if (attempt.contextPolicyId !== context.contextPolicyId) return refuse("context_policy_mismatch");
  if (attempt.egressPolicyId !== context.egressPolicy.id) return refuse("egress_policy_mismatch");
  if (Date.parse(candidate.expiresAt) <= context.now.getTime()) return refuse("candidate_expired");

  switch (plan.kind) {
    case "search_selection":
      return admitSearch(context);
    case "run_tests":
      return admitRunTests(context);
    default:
      return refuse("plan_kind_unsupported");
  }
}

/**
 * Search sends user text off the machine, so it carries the strictest checks:
 * the selection must still be exactly what was predicted on, the browser page
 * must still be the one that owned it, and egress must be explicitly allowed.
 */
function admitSearch(context: AdmissionContext): AdmissionResult {
  const { state, candidate, plan } = context;
  if (context.egressPolicy.searchEgress !== "allow") return refuse("search_egress_denied");

  const text = state.textContext;
  const page = state.currentBrowserPage;
  if (text === null || text.selection.trim().length === 0) return refuse("selection_empty");
  if (page === null) return refuse("browser_page_missing");

  const predicted = candidate?.parameters.selection;
  if (typeof predicted !== "string" || predicted !== text.selection) return refuse("selection_changed");
  if (plan.arguments.query !== text.selection) return refuse("selection_changed");

  // Three owners must agree: whoever produced the text, whoever owns the page,
  // and whoever holds the foreground now. Any disagreement means the selection
  // and the page belong to different windows, so searching would send text from
  // one context into a browser that is showing another.
  const foreground = state.focus === null
    ? null
    : { applicationId: state.focus.applicationId, windowTitle: state.focus.windowTitle };
  if (!sameOwner(text.owner, page.owner) || !sameOwner(text.owner, foreground)) {
    return refuse("owner_mismatch");
  }
  // The selection must have been observed after the page was: a selection older
  // than the current page was made against a document that is no longer shown.
  if (text.observationOrdinal <= page.observationOrdinal) return refuse("observation_out_of_order");
  return { admitted: true };
}

/**
 * run_tests executes a command locally, so its checks are about identity of the
 * target: the same coding application must still be in front, and the newest
 * save must still be the file the plan was built for.
 */
function admitRunTests(context: AdmissionContext): AdmissionResult {
  const { state, plan } = context;
  const application = state.activeApplication;
  if (application === null || !application.id.includes("code")) {
    return refuse("coding_application_mismatch");
  }
  const lastSave = state.recentActions.find((action) => action.kind === "file_saved");
  if (
    lastSave === undefined ||
    lastSave.applicationId === null ||
    lastSave.applicationId !== application.id
  ) {
    return refuse("coding_application_mismatch");
  }
  if (lastSave.target === null || plan.canonicalTarget === null) return refuse("saved_path_mismatch");
  if (!plan.canonicalTarget.endsWith(lastSave.target)) return refuse("saved_path_mismatch");
  return { admitted: true };
}

function sameOwner(
  left: { applicationId: string; windowTitle: string } | null,
  right: { applicationId: string; windowTitle: string } | null,
): boolean {
  if (left === null || right === null) return false;
  return left.applicationId === right.applicationId && left.windowTitle === right.windowTitle;
}

function refuse(reasonCode: AdmissionReasonCode): AdmissionResult {
  return { admitted: false, reasonCode };
}
