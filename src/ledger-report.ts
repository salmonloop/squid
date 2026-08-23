import { describeErrorForAudit } from "./action-egress.js";
import { SqlitePredictionLedger } from "./sqlite-prediction-ledger.js";
import type {
  PredictionAttemptRecord,
  PredictionLedgerRecord,
} from "./prediction-ledger.js";
import { isShadowProvider } from "./shadow-ledger.js";

/**
 * Shadow-mode report over a persisted prediction ledger.
 *
 * The ledger already records every prediction attempt a live run made —
 * provider, status, latency, candidates — so shadow mode needs no second
 * persistence path; it needs this read side. The report aggregates what an
 * operator asks of a shadow run: is the model answering, how often does it
 * fall back, what does it predict, and how fast.
 *
 * Pure aggregation over `PredictionLedgerRecord[]`, so it is testable against
 * in-memory records and works for any ledger implementation.
 */

export interface PathReport {
  readonly attempts: number;
  readonly byProvider: Readonly<Record<string, number>>;
  readonly byStatus: Readonly<Record<string, number>>;
  /** Attempts whose outcome fell back to the heuristic, with the reasons seen. */
  readonly fallbacks: number;
  readonly fallbackReasons: Readonly<Record<string, number>>;
  /** Candidate kinds across all attempts, counting every candidate emitted. */
  readonly byCandidateKind: Readonly<Record<string, number>>;
  readonly latencyMs: {
    readonly p50: number | null;
    readonly p95: number | null;
    readonly max: number | null;
  };
}

/**
 * The live path's figures at the top level, with both paths broken out beneath.
 *
 * Shadow attempts are *excluded* from the top-level numbers rather than mixed in,
 * and that is the whole point of the split. A shadow run is a second opinion about
 * the same moment, so counting both would double every attempt and average two
 * different providers' latencies into one meaningless figure. The top level stays
 * the answer to "what did this run actually do", which is what it meant before
 * shadow mode existed — so an operator reading an older report and a newer one is
 * comparing the same quantity.
 *
 * `paths.live` repeats the top level by construction. Kept so a reader never has to
 * know that the outer object silently means "live only".
 */
export interface LedgerReport extends PathReport {
  readonly paths: {
    readonly live: PathReport;
    readonly shadow: PathReport;
  };
}

export function buildLedgerReport(records: readonly PredictionLedgerRecord[]): LedgerReport {
  const attempts = records.filter(
    (record): record is PredictionAttemptRecord => record.recordType === "attempt",
  );
  // Split on the provider name, which `createShadowAttemptRecord` prefixes. The
  // marker lives in the record rather than in a separate field because the ledger
  // schema is closed (`additionalProperties: false`), and because a name is what
  // an operator already reads — a shadow row is legible even without this report.
  const shadow = attempts.filter((attempt) => isShadowProvider(attempt.provider));
  const live = attempts.filter((attempt) => !isShadowProvider(attempt.provider));

  return {
    ...buildPathReport(live),
    paths: { live: buildPathReport(live), shadow: buildPathReport(shadow) },
  };
}

function buildPathReport(attempts: readonly PredictionAttemptRecord[]): PathReport {
  const tally = (values: readonly (string | undefined)[]): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const value of values) {
      if (value === undefined) continue;
      counts[value] = (counts[value] ?? 0) + 1;
    }
    return counts;
  };

  const latencies = attempts.map((attempt) => attempt.latencyMs).sort((left, right) => left - right);
  const percentile = (fraction: number): number | null => {
    if (latencies.length === 0) return null;
    const index = Math.min(latencies.length - 1, Math.ceil(latencies.length * fraction) - 1);
    // The index is clamped into range above; `?? null` satisfies
    // noUncheckedIndexedAccess without pretending the empty case is reachable.
    return latencies[index] ?? null;
  };

  return {
    attempts: attempts.length,
    byProvider: tally(attempts.map((attempt) => attempt.provider)),
    byStatus: tally(attempts.map((attempt) => attempt.status)),
    fallbacks: attempts.filter((attempt) => attempt.fallbackReason !== undefined).length,
    fallbackReasons: tally(attempts.map((attempt) => attempt.fallbackReason)),
    byCandidateKind: tally(attempts.flatMap((attempt) => attempt.candidates.map((c) => c.kind))),
    latencyMs: {
      p50: percentile(0.5),
      p95: percentile(0.95),
      max: latencies.at(-1) ?? null,
    },
  };
}

/**
 * Reads the ledger database a durable watch run wrote and prints the report.
 * Usage: `bun run ledger:report -- /absolute/path.db.ledger.db`.
 *
 * Guarded by `import.meta.main` so importing the aggregation for tests does
 * not open a database or exit the process.
 */
if (import.meta.main) {
  const filePath = process.argv[2];
  if (filePath === undefined || filePath.length === 0) {
    console.error("Usage: bun run ledger:report -- <absolute-path-to-.ledger.db>");
    process.exit(1);
  }

  const ledger = new SqlitePredictionLedger(filePath);
  try {
    const records = await ledger.all();
    console.log(JSON.stringify(buildLedgerReport(records), null, 2));
  } catch (error) {
    // A corrupt or non-ledger database should read as an operator error with a
    // stated cause, not an uncaught stack trace from deep inside record parsing.
    console.error("Failed to read ledger:", describeErrorForAudit(error));
    process.exitCode = 1;
  } finally {
    ledger.close();
  }
}


