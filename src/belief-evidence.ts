import type { WorldState } from "./protocol.js";

/**
 * The event timeline a belief validator checks evidence against, derived from the
 * projection the belief provider was actually shown.
 *
 * `BeliefValidationContext.eventOccurredAt` exists so a belief cannot cite an
 * event that never happened, or one that happened *after* the belief was
 * inferred. Deriving that map from the same projected state the provider read is
 * what makes the check meaningful: a provider can only cite what it could see, so
 * an ID outside this map is either a hallucination or a reference to something a
 * `ContextPolicy` withheld — and neither may be accepted as evidence.
 *
 * Reading the event store instead would be both slower and wrong: it would let a
 * belief cite an event the projection had already dropped, which is precisely the
 * stale-evidence case the contract rejects.
 *
 * Every eventId-bearing field in `WorldState` carries its own timestamp, so no
 * clock is consulted and the result is a pure function of the state.
 */
export function evidenceTimeline(state: WorldState): ReadonlyMap<string, string> {
  const timeline = new Map<string, string>();

  // Actions first: `recentActions` is the richest source, and it is ordered
  // newest-first, so a later `set` for the same ID would only ever re-state the
  // same pair (an event produces one action).
  for (const action of state.recentActions) {
    timeline.set(action.sourceEventId, action.occurredAt);
  }
  if (state.textContext !== null) {
    timeline.set(state.textContext.sourceEventId, state.textContext.observedAt);
  }
  if (state.currentBrowserPage !== null) {
    timeline.set(state.currentBrowserPage.sourceEventId, state.currentBrowserPage.observedAt);
  }
  if (state.captureGate !== null) {
    timeline.set(state.captureGate.sourceEventId, state.captureGate.occurredAt);
  }

  return timeline;
}
