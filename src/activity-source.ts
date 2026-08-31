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

/**
 * One toggleable source as the catalog declares it: an identity plus a recipe.
 *
 * `create` is a recipe, not an instance, because `ActivitySource.start` refuses
 * to run on a stopped instance — a hot restart means a fresh instance built by
 * the same recipe, never a resurrection of the old one. The entry's `id` is the
 * single declaration: every instance built from `create` must report the same
 * id, and the source manager refuses to start one that does not, so the catalog
 * key and the event metadata cannot drift apart.
 *
 * `create` is omitted for a capability this run did not configure — a browser
 * reader that was off at startup, say. The entry still appears in the panel's
 * dump (state `unsupported`) and refuses toggles, so the form shows the whole
 * truth about the run instead of hiding a capability that exists in the schema
 * but not in this process.
 */
export interface SourceEntry {
  readonly id: string;
  /** Human-readable name the panel renders; sanitized like every wire string. */
  readonly label: string;
  readonly create?: () => ActivitySource;
}
