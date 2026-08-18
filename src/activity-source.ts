import type { ActivityEvent } from "./protocol.js";

/**
 * Delivers one validated activity event into the Chronicle pipeline.
 *
 * Sources must await each call so per-source ordering is preserved; the emitter
 * owns validation, persistence, and projection.
 */
export type ActivityEventEmitter = (event: ActivityEvent) => Promise<void>;

export interface ActivitySourceDiagnostic {
  kind: "watcher_error" | "delivery_error" | "probe_error";
  message: string;
  occurredAt: string;
}

export interface ActivitySource {
  readonly id: string;
  /** Begins observation. Rejects if the source is already started or stopped. */
  start(emit: ActivityEventEmitter): Promise<void>;
  /** Stops observation, drains buffered events, and resolves once quiet. Idempotent. */
  stop(): Promise<void>;
}
