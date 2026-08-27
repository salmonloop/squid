import type { EventStore } from "./event-store.js";

/**
 * History deletion: ranged removal of captured events.
 *
 * There used to be a second half here — a prediction ledger whose records had
 * to be closed over whatever history lost, so no attempt survived without its
 * trigger event. That ledger is gone: the agent's own actions live in its Pi
 * session history, which Pi owns, and Squid keeps exactly one durable store of
 * its own. So deletion is now a single commit against a single store, and the
 * ordering problem that made this module interesting no longer exists.
 *
 * What remains is still the one place that decides what "delete a time range"
 * means, shared by the startup retention pass and the `history:delete` command.
 */
export interface RetentionPruneResult {
  /** Events deleted from the store. */
  readonly removedEvents: number;
}

/**
 * Deletes every event whose `occurredAt` falls inside `[from, until]`
 * (inclusive, epoch-millisecond semantics shared by every store backend).
 */
export async function deleteHistoryRange(
  store: EventStore,
  range: { readonly from: string; readonly until: string },
): Promise<RetentionPruneResult> {
  return { removedEvents: await store.deleteRange(range) };
}

/** The startup retention pass: everything at or before the cutoff goes. */
export async function runRetentionPrune(
  store: EventStore,
  options: {
    /** Epoch ms; everything at or before this instant goes. */
    readonly cutoffMs: number;
  },
): Promise<RetentionPruneResult> {
  // ISO spelling so the same range string works on every backend: all stores
  // decode both bounds to epoch milliseconds before comparing.
  return deleteHistoryRange(store, {
    from: EPOCH_START,
    until: new Date(options.cutoffMs).toISOString(),
  });
}

const EPOCH_START = "1970-01-01T00:00:00.000Z";
