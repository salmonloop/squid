import { orderActivityEvents } from "./chronicle-ordering.js";
import { parseActivityEvent, type ActivityEvent } from "./protocol.js";

export interface Episode {
  id: string;
  startedAt: string;
  endedAt: string;
  eventIds: readonly string[];
}

export const DEFAULT_EPISODE_GAP_MS = 5 * 60_000;

export function segmentEpisodes(
  inputs: readonly ActivityEvent[],
  gapMs = DEFAULT_EPISODE_GAP_MS,
): readonly Episode[] {
  assertEpisodeGap(gapMs);
  const events = orderActivityEvents(inputs.map(parseActivityEvent));
  const episodes: Episode[] = [];

  for (const event of events) {
    const current = episodes.at(-1);
    if (current === undefined || elapsedMs(current.endedAt, event.occurredAt) >= gapMs) {
      episodes.push({
        id: episodeIdForEvent(event),
        startedAt: event.occurredAt,
        endedAt: event.occurredAt,
        eventIds: [event.eventId],
      });
      continue;
    }

    episodes[episodes.length - 1] = {
      ...current,
      endedAt: event.occurredAt,
      eventIds: [...current.eventIds, event.eventId],
    };
  }

  return episodes;
}

export function episodeIdForEvent(event: ActivityEvent): string {
  return `episode-${event.occurredAt}-${event.eventId}`;
}

export function assertEpisodeGap(gapMs: number): void {
  if (!Number.isFinite(gapMs) || gapMs < 0) {
    throw new TypeError("Episode gap must be a finite, non-negative duration in milliseconds.");
  }
}

export function elapsedMs(earlier: string, later: string): number {
  return new Date(later).getTime() - new Date(earlier).getTime();
}
