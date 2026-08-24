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
 *   - `requestId` gains a `:shadow` suffix. This is what lets the two records
 *     *coexist*: `assertCanAccept` refuses a second attempt for a request that
 *     already has one, so an unshifted shadow record would lose that collision
 *     (the live write lands first, since `PredictionRuntime` awaits its attempt
 *     write before resolving the outcome the shadow run observes) and never be
 *     written at all. It also puts the record outside the id `claimDispatch`
 *     searches — that lookup is `record.requestId === plan.attemptId`, and a
 *     plan's `attemptId` is always a live request id.
 *   - `candidateId`s follow from the shifted request id, so a shadow candidate
 *     cannot collide with the live candidate at the same ordinal — which the
 *     ledger index would otherwise refuse as a conflict.
 *   - `provider` gains a `shadow:` prefix, which is what makes the split legible
 *     in `bun run ledger:report` rather than merely safe.
 *
 * What actually makes dispatch impossible is narrower than all of that, and worth
 * being precise about: `ShadowCognitionRunner` has no dispatcher. Its only output
 * is an observation, and no caller passes `shadowCandidates` to anything that
 * dispatches. The id and the trust level below are defence in depth around that
 * one fact — remove either and shadow mode still cannot act, so neither should be
 * read as the load-bearing guarantee.
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
    // shadow path has passed no gate for *this* user's world. `admitAction` reads
    // the attempt's own trust level and not just the runtime's, so this genuinely
    // refuses on its own — it is the defence-in-depth layer the header describes,
    // not the reason dispatch is impossible.
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
