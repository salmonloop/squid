import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * Heartbeat sink: receives turn_start/turn_end events and pushes them to the panel.
 * Separated from the extension factory so tests can inject a fake sink.
 */
export interface HeartbeatSink {
  turnStarted(): void;
  turnEnded(): void;
}

/**
 * Builds an inline extension that tracks LLM turn lifecycle and pushes events
 * to a sink (typically the panel socket). Mirrors the pattern from Pi's
 * status-line.ts example, reusing Pi's existing turn_start/turn_end events
 * rather than hand-rolling a heartbeat mechanism.
 */
export function heartbeatExtension(sink: HeartbeatSink): InlineExtension {
  return {
    name: "squid-heartbeat",
    hidden: true,
    factory: (pi) => {
      pi.on("turn_start", () => sink.turnStarted());
      pi.on("turn_end", () => sink.turnEnded());
    },
  };
}
