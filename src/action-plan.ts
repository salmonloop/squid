import { createHash } from "node:crypto";
import { canonicalJson } from "./state-digest.js";
import type { PredictionCandidate, PredictionKind } from "./protocol.js";

/**
 * Prediction kinds with a concrete capability mapping.
 *
 * This list is the capability surface: a kind absent here can never become an
 * action, no matter what a provider returns. Planning lives in
 * `action-planner.ts` and validation in `action-admission.ts`; this module
 * holds only the shared vocabulary both depend on, so neither has to import
 * the other.
 */
export const actionablePredictionKinds = [
  "search_selection",
  "run_tests",
] as const satisfies readonly PredictionKind[];

export type ActionablePredictionKind = (typeof actionablePredictionKinds)[number];

/**
 * The immutable operation Squid may ask the outside world to perform.
 *
 * Produced once by the planner, digested once, then carried unchanged through
 * confirmation, the ledger claim, and the gateway invocation. Re-deriving a
 * plan at any later point is the bug this shape exists to prevent: the user
 * would approve one operation while a different one executed.
 */
export interface ImmutableActionPlan {
  readonly planSchemaVersion: 1;
  readonly kind: ActionablePredictionKind;
  readonly candidateId: string;
  readonly attemptId: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, string | number | boolean | null>>;
  /**
   * Operator-facing description shown at the confirmation boundary.
   *
   * Never contains selection text: a summary quoting the selection would put
   * user text into logs and the ledger, which the audit rules forbid. A
   * `run_tests` summary is the literal command, because that is precisely what
   * the user is being asked to approve.
   */
  readonly summary: string;
  readonly confirmation: "none" | "required";
  /** Canonical realpath of the directory a command runs in, or null when none. */
  readonly canonicalWorkingDirectory: string | null;
  /** Canonical realpath of the file a command targets, or null when none. */
  readonly canonicalTarget: string | null;
}

/**
 * Stable digest over the canonical plan — the identity confirmation, the ledger
 * claim, and the gateway invocation all share.
 *
 * Lives here, beside the shape it digests, so the planner that writes a digest
 * and the admission that recomputes it cannot drift apart: two independent
 * implementations of "the same digest" would eventually disagree, and the
 * disagreement would look indistinguishable from tampering.
 */
export function digestActionPlan(plan: ImmutableActionPlan): string {
  const hash = createHash("sha256")
    .update(canonicalJson({ algorithmVersion: "action-plan-v1", plan }))
    .digest("hex");
  return `sha256:${hash}`;
}

/**
 * Digest over candidate parameters, so the ledger can prove two records saw the
 * same parameters without storing the raw values.
 */
export function digestCandidateParameters(
  parameters: PredictionCandidate["parameters"],
): string {
  const hash = createHash("sha256")
    .update(canonicalJson({ algorithmVersion: "candidate-parameters-v1", parameters }))
    .digest("hex");
  return `sha256:${hash}`;
}
