import type { ContextEvent, InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * The attention window: a deterministic, headless inline extension that drops
 * the resident agent's *stale observation breadcrumbs* from the context before
 * every LLM call, keeping only those within a recent wall-clock window.
 *
 * Why breadcrumbs and nothing else. `observe()` appends one custom message per
 * ingested event (`observation`), and it never removes one — so a long-lived
 * session accretes a breadcrumb per event without bound, and a busy tree turns
 * that into hundreds of thousands of near-empty "file_saved @ <time>" lines the
 * model re-reads on every turn. This cut touches only those: every
 * conversation message (system, user, assistant, tool result) and the current
 * world snapshot the sense extension injects are kept whole, whatever their
 * age. Observations are standalone single-message units, so dropping one can
 * never orphan a tool result.
 *
 * Why deterministic rather than a model's judgement. This is the counterpart to
 * the decision curator, not a replacement for its intent — but where the
 * curator asks a model which context matters and fails open on any error, this
 * is arithmetic on a timestamp. It cannot fail open, so it holds when no
 * decision endpoint is configured, when the model reports no token usage, and
 * regardless of what context window the model catalog claims. It is the hard
 * floor under the soft, semantic trimming the curator does above it.
 *
 * Non-destructive, like everything on this side: the store and the session keep
 * every observation. This narrows the *view* the model reads, never the record.
 * Nothing is lost that the injected snapshot does not already carry — the
 * snapshot is "now"; these breadcrumbs are "recently", and this bounds how far
 * back "recently" reaches.
 */
export function attentionWindowExtension(
  windowMs: number,
  now: () => number = () => Date.now(),
): InlineExtension {
  return {
    name: "squid-attention-window",
    hidden: true,
    factory: (pi) => {
      pi.on("context", (event: ContextEvent) => {
        // A non-positive or non-finite bound means "no window" — keep
        // everything. The resolver never produces one, but a filter that read
        // it as a cutoff at `now` would drop every breadcrumb, which is a
        // louder failure than doing nothing.
        if (!Number.isFinite(windowMs) || windowMs <= 0) return;
        const cutoff = now() - windowMs;
        const kept = event.messages.filter((message) => !isStaleObservation(message, cutoff));
        // Nothing dropped: leave the array identity alone so the next context
        // handler is handed exactly what it would have been without this one.
        if (kept.length === event.messages.length) return;
        return { messages: kept };
      });
    },
  };
}

/** One entry of a `context` event's message list. */
type AgentMessage = ContextEvent["messages"][number];

/**
 * Whether a message is an observation breadcrumb older than the cutoff.
 *
 * Only `custom`/`observation` messages are eligible, and only when they carry a
 * usable positive timestamp: a missing, zero, or non-numeric one is kept, so
 * the filter never drops a message it cannot date. That bias — keep when
 * unsure — is what makes it safe to run against every message in the context,
 * including the sense snapshot (custom, but not an observation) and the
 * conversation turns (never custom at all).
 */
function isStaleObservation(message: AgentMessage, cutoff: number): boolean {
  const probe = message as { role?: unknown; customType?: unknown; timestamp?: unknown };
  if (probe.role !== "custom" || probe.customType !== "observation") return false;
  const timestamp = probe.timestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return false;
  return timestamp < cutoff;
}
