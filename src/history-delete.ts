import { isAbsolute, resolve } from "node:path";
import { describeErrorForAudit } from "./action-egress.js";
import { parseDeletionRange } from "./event-store.js";
import { SqliteEventStore } from "./sqlite-event-store.js";
import { SqlitePredictionLedger } from "./sqlite-prediction-ledger.js";
import { deleteHistoryRange } from "./retention-prune.js";

/**
 * `bun run history:delete` — the stated interface for deleting a time range.
 *
 * Issue #6's Done-when asks for deletion "from a stated interface"; this is
 * it. The watch session's startup prune enforces retention going forward;
 * this command covers the deliberate one-off: "delete everything between
 * lunch and dinner". It opens the same two databases a durable run wrote,
 * deletes the ranged events, and lets the ledger close over what history
 * lost — so no attempt survives without its trigger event.
 *
 * The database path is required and absolute, mirroring SQUID_DB's posture:
 * the command refuses to guess which file the user means, because deleting
 * the wrong file's history is not recoverable. A malformed range (inverted or
 * unparseable) fails before any open.
 */

const USAGE = `Usage: bun run history:delete -- <events.db> <from> <until>

  <events.db>  absolute path to the SQLite event database (the SQUID_DB value)
  <from>       inclusive ISO start of the range to delete
  <until>      inclusive ISO end of the range to delete

The prediction ledger (<events.db>.ledger.db) is pruned automatically, so no
record survives without its trigger event.`;

if (import.meta.main) {
  const [databaseArg, from, until] = process.argv.slice(2);
  if (databaseArg === undefined || from === undefined || until === undefined) {
    console.error(USAGE);
    process.exit(2);
  }
  const databasePath = resolve(databaseArg);
  if (!isAbsolute(databasePath)) {
    console.error("The event database path must be absolute.");
    process.exit(2);
  }

  // Validated before any file is opened: refusing early is free, refusing late
  // after a half-deletion is not an option this command offers.
  try {
    parseDeletionRange(from, until);
  } catch (error) {
    console.error(`Invalid range: ${describeErrorForAudit(error)}`);
    process.exit(2);
  }

  const store = new SqliteEventStore(databasePath);
  const ledger = new SqlitePredictionLedger(`${databasePath}.ledger.db`);
  try {
    const result = await deleteHistoryRange(store, ledger, { from, until });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error("history:delete failed:", describeErrorForAudit(error));
    process.exitCode = 1;
  } finally {
    store.close();
    ledger.close();
  }
}
