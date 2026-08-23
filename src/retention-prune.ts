import type { EventStore } from "./event-store.js";
import type { PredictionLedger, PredictionLedgerRecord } from "./prediction-ledger.js";

/**
 * History deletion: ranged event removal plus the ledger closure that must
 * follow it.
 *
 * The order is forced. Events go first because the ledger closure is computed
 * from *what history lost* — and that is derived after the store's deletion
 * commits, by diffing the trigger ids attempts name against the surviving
 * events. No second copy of "which events existed" is kept anywhere.
 *
 * A failure in the ledger half leaves fewer events but an intact,
 * still-self-contained ledger — attempts whose triggers are gone survive
 * until the next pass prunes them. That is the safe direction: over-retention
 * waits for the next run; under-retention cannot be undone.
 */
export interface RetentionPruneResult {
  /** Events deleted from the store. */
  readonly removedEvents: number;
  /** Ledger records removed with them (attempts, feedback, plans, decisions…). */
  readonly removedRecords: number;
}

/**
 * Deletes every event whose `occurredAt` falls inside `[from, until]`
 * (inclusive, epoch-millisecond semantics shared by all three stores) and then
 * removes every ledger record whose only anchor was one of those events.
 *
 * Both the startup retention prune and the `history:delete` command funnel
 * through here, so there is exactly one place that decides how a deletion of
 * events reaches the prediction ledger.
 */
export async function deleteHistoryRange(
  store: EventStore,
  ledger: PredictionLedger,
  range: { readonly from: string; readonly until: string },
): Promise<RetentionPruneResult> {
  const removedEvents = await store.deleteRange(range);

  if (removedEvents === 0) {
    return { removedEvents: 0, removedRecords: 0 };
  }

  const records = await ledger.all();
  const survivorIds = new Set((await store.all()).map((event) => event.eventId));
  return {
    removedEvents,
    removedRecords: await ledger.deleteRecordsRemovedWithEvents(
      resolveRemovedEventIds(records, survivorIds),
    ),
  };
}

/** The startup retention pass: everything at or before the cutoff goes. */
export async function runRetentionPrune(
  store: EventStore,
  ledger: PredictionLedger,
  options: {
    /** Epoch ms; everything at or before this instant goes. */
    readonly cutoffMs: number;
  },
): Promise<RetentionPruneResult> {
  // ISO spelling so the same range string works on every backend: all three
  // stores decode both bounds to epoch milliseconds before comparing.
  return deleteHistoryRange(store, ledger, {
    from: EPOCH_START,
    until: new Date(options.cutoffMs).toISOString(),
  });
}

const EPOCH_START = "1970-01-01T00:00:00.000Z";

/**
 * The event ids whose loss explains dangling references: every trigger id an
 * attempt names that no surviving event carries.
 *
 * Computed from the ledger's own view rather than a pre-delete snapshot of the
 * store — exact without an extra read, and correct across repeated passes
 * where an earlier run deleted events but died before pruning their records.
 */
function resolveRemovedEventIds(
  records: readonly PredictionLedgerRecord[],
  survivorIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const removed = new Set<string>();
  for (const record of records) {
    if (record.recordType === "attempt" && !survivorIds.has(record.triggerEventId)) {
      removed.add(record.triggerEventId);
    }
  }
  return removed;
}
