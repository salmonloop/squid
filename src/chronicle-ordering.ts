import type { ActivityEvent } from "./protocol.js";

export type ActivityEventIdentity = string;

export function eventIdentity(event: ActivityEvent): ActivityEventIdentity {
  return JSON.stringify([
    event.source.kind,
    event.source.instanceId,
    event.sessionId,
    event.sequence,
  ]);
}

/**
 * Total order over events with distinct `eventId`s — `eventId` is the final
 * tiebreak, so any two such events compare non-zero.
 *
 * Two *different* events sharing one `eventId` compare equal, and their relative
 * order then depends on input order rather than on the timeline. `SquidCore`
 * makes that unreachable by rejecting a colliding `eventId` at ingest
 * (`inspectDuplicate`), so anything read back from a store is safely orderable.
 * A caller assembling events by hand owes itself the same uniqueness.
 */
export function compareActivityEvents(left: ActivityEvent, right: ActivityEvent): number {
  return new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime()
    || compareStrings(left.source.kind, right.source.kind)
    || compareStrings(left.source.instanceId, right.source.instanceId)
    || compareStrings(left.sessionId, right.sessionId)
    || left.sequence - right.sequence
    || compareStrings(left.eventId, right.eventId);
}

export function orderActivityEvents(events: readonly ActivityEvent[]): ActivityEvent[] {
  return [...events].sort(compareActivityEvents);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
