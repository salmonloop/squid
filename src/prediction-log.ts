import type { PredictionOutcome } from "./prediction-provider.js";

/**
 * A structured record of a prediction attempt, persisted for offline analysis
 * in shadow mode. The coordinator calls `onOutcome` for every attempt; the log
 * collects these records without affecting any real-time path.
 */
export interface PredictionRecord {
  readonly timestamp: string;
  readonly requestId: string;
  readonly provider: string;
  readonly status: string;
  readonly candidateKinds: readonly string[];
  readonly latencyMs: number;
  readonly fallbackReason?: string;
}

export function toPredictionRecord(outcome: PredictionOutcome): PredictionRecord {
  return {
    timestamp: new Date().toISOString(),
    requestId: outcome.requestId,
    provider: outcome.provider,
    status: outcome.status,
    candidateKinds: outcome.candidates.map((c) => c.kind),
    latencyMs: outcome.latencyMs,
    ...(outcome.fallbackReason !== undefined ? { fallbackReason: outcome.fallbackReason } : {}),
  };
}

/**
 * In-memory prediction log for tests and offline analysis.
 * In production this would write to a structured log file or database,
 * but for shadow mode an in-memory collector is sufficient.
 */
export class PredictionLog {
  private readonly records: PredictionRecord[] = [];

  public record(outcome: PredictionOutcome): void {
    this.records.push(toPredictionRecord(outcome));
  }

  public get all(): readonly PredictionRecord[] {
    return [...this.records];
  }

  public get count(): number {
    return this.records.length;
  }

  public filter(predicate: (record: PredictionRecord) => boolean): readonly PredictionRecord[] {
    return this.records.filter(predicate);
  }

  public clear(): void {
    this.records.length = 0;
  }
}
