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
