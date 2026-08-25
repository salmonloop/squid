import type { EgressPolicy } from "./action-egress.js";
import { digestCandidateParameters, type ImmutableActionPlan } from "./action-plan.js";
import type { PredictionAttemptRecord } from "./prediction-ledger.js";
import type { PredictionCandidate, WorldState } from "./protocol.js";
import { admissionDescriptors } from "./tool-descriptors.js";

/**
 * Fixed vocabulary of admission refusals. Reason codes are stable identifiers
 * rather than prose: they are compared in tests, counted in diagnostics, and
 * written to the ledger, so they must never carry user text.
 */
export type AdmissionReasonCode =
  | "attempt_missing"
  | "attempt_schema_unsupported"
  | "candidate_unknown"
  | "candidate_parameters_mismatch"
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
  | "command_outcome_missing"
  | "command_outcome_changed"
  | "command_succeeded"
  | "descriptor_unknown"
  | "descriptor_kind_mismatch";

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

  // The ledger keeps only a digest of the parameters it saw, so the in-process
  // candidate has to prove it is that same one. Without this, a caller could
  // hand admission a candidate whose parameters differ from the recorded
  // prediction and every later check would compare against the substitute.
  const envelope = attempt.candidates.find((item) => item.candidateId === plan.candidateId);
  if (envelope === undefined) return refuse("candidate_unknown");
  if (envelope.parametersDigest !== digestCandidateParameters(candidate.parameters)) {
    return refuse("candidate_parameters_mismatch");
  }
  if (envelope.kind !== candidate.kind) return refuse("candidate_parameters_mismatch");
  if (envelope.expiresAt !== candidate.expiresAt) return refuse("candidate_parameters_mismatch");

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

  /**
   * The per-tool checks live on the descriptor, not here. Looked up by the
   * plan's own descriptor id over the built-in catalog — the guards are pure
   * world-state checks, so they need neither the run's project-scoped registry
   * nor the filesystem. The plan carries the id it was rendered from, so two
   * tools sharing a category can never be re-paired with each other's guards.
   * An unknown descriptor is refused rather than waved through: an action
   * nobody can vouch for does not run.
   */
  const descriptor = admissionDescriptors().find((tool) => tool.id === plan.descriptorId);
  if (descriptor === undefined) return refuse("descriptor_unknown");
  if (descriptor.category !== plan.kind) return refuse("descriptor_kind_mismatch");
  return descriptor.guard?.(context) ?? { admitted: true };
}

function refuse(reasonCode: AdmissionReasonCode): AdmissionResult {
  return { admitted: false, reasonCode };
}
