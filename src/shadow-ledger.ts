import { sanitizeAuditText } from "./action-egress.js";
import {
  candidateEnvelopes,
  createAttemptRecord,
  type PredictionAttemptRecord,
} from "./prediction-ledger.js";
import type { ShadowObservation } from "./shadow-cognition.js";

/**
 * Turns a shadow observation into an attempt record the ledger accepts, and that
 * no dispatch claim can ever match.
 *
 * Shadow mode needs no second persistence path — the ledger already records what
 * a prediction attempt was, and that is exactly what a shadow run is. What it does
 * need is for the two to stay *distinguishable* while sharing one file, which is
 * what the naming below buys.
 *
 * Three separate namespaces are shifted, not one:
 *
 *   - `requestId` gains a `:shadow` suffix. `claimDispatch` finds an attempt by
 *     `record.requestId === plan.attemptId`, and a plan's `attemptId` is a live
 *     request id, so a shadow record is unreachable by that lookup. This is the
 *     structural reason shadow mode cannot dispatch: not a flag anyone remembered
 *     to check, but an id no claim will ever ask for.
 *   - `candidateId`s follow from the shifted request id, so a shadow candidate
 *     cannot collide with the live candidate at the same ordinal — which the
 *     ledger index would otherwise refuse as a conflict.
 *   - `provider` gains a `shadow:` prefix, which is what makes the split legible
 *     in `bun run ledger:report` rather than merely safe.
 *
 * `triggerEventId` is deliberately *not* shifted: both records describe the same
 * ingest, and retention deletion removes records by trigger event. Renaming it
 * would leave shadow records behind after the event they describe was deleted —
 * an attempt pointing at history that no longer exists, which is the one thing
 * ledger closure guarantees against.
 */

/** Prefix that marks a provider name as a shadow run. */
export const SHADOW_PROVIDER_PREFIX = "shadow:";

/** Suffix that moves a shadow attempt out of the live request namespace. */
export const SHADOW_REQUEST_SUFFIX = ":shadow";

export function shadowRequestId(liveRequestId: string): string {
  return `${liveRequestId}${SHADOW_REQUEST_SUFFIX}`;
}

export function shadowProviderName(cognitionName: string): string {
  return `${SHADOW_PROVIDER_PREFIX}${cognitionName}`;
}

/** True for a provider name written by `createShadowAttemptRecord`. */
export function isShadowProvider(provider: string): boolean {
  return provider.startsWith(SHADOW_PROVIDER_PREFIX);
}

export function createShadowAttemptRecord(input: {
  readonly observation: ShadowObservation;
  readonly completedAt: string;
  readonly runtimeSessionId: string;
  readonly egressPolicyId: string;
}): PredictionAttemptRecord {
  const { observation } = input;
  const requestId = shadowRequestId(observation.requestId);

  return createAttemptRecord({
    triggerEventId: observation.context.triggerEventId,
    episodeId: observation.episodeId,
    triggeredAt: observation.context.triggeredAt,
    completedAt: input.completedAt,
    outcome: {
      requestId,
      provider: shadowProviderName(observation.shadowProvider),
      status: observation.shadowStatus === "succeeded" ? "succeeded" : "failed",
      candidates: observation.shadowCandidates,
      latencyMs: observation.latencyMs,
      // The belief status rides here because it is the one fact about a shadow run
      // an operator most needs and the attempt schema has nowhere else to put. It
      // is sanitized despite being a closed vocabulary today: `reasonCode` can
      // carry `describeErrorForAudit` output from a belief provider, and an error
      // message routinely quotes the thing that failed.
      fallbackReason: shadowFallbackReason(observation),
    },
    candidates: candidateEnvelopes(requestId, observation.shadowCandidates),
    runtimeSessionId: input.runtimeSessionId,
    stateDigest: observation.context.stateDigest,
    projectionGeneration: observation.context.projectionGeneration,
    triggerDisposition: observation.context.triggerDisposition,
    contextPolicyId: observation.context.contextPolicyId,
    // Always suggestion-only, regardless of how the live run is configured. A
    // shadow path has passed no gate for *this* user's world, and the trust field
    // is what `action-admission.ts` reads — so this is the second, independent
    // reason a shadow candidate cannot be dispatched, after the unreachable id.
    actionTrust: "suggestion_only",
    egressPolicyId: input.egressPolicyId,
  });
}

/**
 * Why the shadow run produced what it did, as a stable short string.
 *
 * Belief status is always included, so an operator can tell "the cognition layer
 * ran without beliefs" from "the cognition layer ran with them" — the two are
 * different providers in effect, and a report that conflated them would be
 * measuring an average over two populations.
 */
function shadowFallbackReason(observation: ShadowObservation): string {
  const parts = [`beliefs=${observation.beliefStatus}`];
  if (observation.reasonCode !== undefined) {
    // Preview-class sanitization: the reason may be error text that quoted a path
    // or a selection. `previewAllowed` is always true for this class, so the text
    // is the redacted, control-character-free, length-capped form.
    parts.push(`reason=${sanitizeAuditText(observation.reasonCode, "rationale").text}`);
  }
  return parts.join(" ");
}
