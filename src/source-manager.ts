import type { ActivityEventEmitter, ActivitySource, SourceEntry } from "./activity-source.js";
import { describeErrorForAudit } from "./audit-text.js";

/**
 * Hot start and stop for the sources a panel can toggle.
 *
 * The session's own startup path keeps its ordered start and its reverse-order
 * teardown; this manager governs only what happens *after* startup, one source
 * at a time. That narrower job is what keeps it safe:
 *
 * - **Declarations, not instances.** The catalog holds `SourceEntry` recipes.
 *   Every start builds a fresh instance, because `ActivitySource.start` refuses
 *   to run on one already stopped — resurrection is not a thing a source can do.
 *
 * - **`stop()` resolves before removal.** The contract on `stop` is "drain
 *   buffered events, then resolve once quiet", so an emitter callback can still
 *   fire during the stop. The source stays in `running` until the promise
 *   lands; removing it early would let a late event arrive unaccounted for.
 *
 * - **One operation at a time per source.** Each id's work chains on the
 *   previous operation for that same id, so a toggle storm cannot interleave a
 *   start and a stop on one source. Distinct sources run independently.
 *
 * - **The gate never appears here.** `capture-gate` is not an observer; it is
 *   the switch that pauses observation, and the session appends it after the
 *   catalog's observers for ordering reasons this manager must not disturb. It
 *   is simply never declared, so a panel cannot ask to stop it.
 *
 * - **The last running observer cannot be stopped.** The session refuses to
 *   start with zero sources (`sources.length === 0`); letting hot-stop reach
 *   that state would recreate, at runtime, the exact failure startup refuses.
 *   The floor counts sources actually running, not merely declared — three
 *   declarations with two already stopped still leave one stop to refuse.
 *
 * ## The known gap, recorded like the pause precedent
 *
 * Stopping a source does not edit the projection. A browser page observed
 * before its source stopped stays in `currentBrowserPage` until a newer
 * observation overwrites it — the same behavior a paused capture already
 * exhibits, chosen for the same reason: the projection is a rebuild from
 * history, and surgically nulling fields under a live reducer is a second
 * projection implementation waiting to drift. Downstream consumers (the
 * agent's senses, the panel) see a world whose newest reading is simply older
 * for that field. When the source restarts, fresh events resume the update.
 */

/** The wire-facing state of one catalog entry. */
export type SourceState = "running" | "stopped" | "unsupported";

export interface SourceSnapshotEntry {
  readonly id: string;
  readonly label: string;
  readonly state: SourceState;
}

export interface SourceManagerOptions {
  /** The catalog, in declaration order — also the dump order and the start order. */
  readonly entries: readonly SourceEntry[];
  /** Delivery path for every event a started source emits. */
  readonly emit: ActivityEventEmitter;
  /** One line per lifecycle change; the same sink the session's log uses. */
  readonly log: (line: string) => void;
  readonly logError: (line: string) => void;
}

export type SourceToggleResult =
  | { readonly ok: true; readonly state: SourceState }
  | { readonly ok: false; readonly error: string };

export class SourceManager {
  private readonly entries: Map<string, SourceEntry>;
  private readonly running = new Map<string, ActivitySource>();
  /**
   * Per-id operation chains, kept beside `running` but separate: a chain entry
   * outlives its operation so the next toggle for the same id serializes behind
   * it even after the source has left `running`.
   */
  private readonly chains = new Map<string, Promise<unknown>>();

  private readonly emit: ActivityEventEmitter;
  private readonly log: (line: string) => void;
  private readonly logError: (line: string) => void;

  public constructor(options: SourceManagerOptions) {
    // A duplicate id is a declaration bug, not a runtime curiosity: two entries
    // sharing a key would make the dump lie about one of them.
    const ids = new Set<string>();
    for (const entry of options.entries) {
      if (ids.has(entry.id)) {
        throw new Error(`Duplicate source id in the catalog: "${entry.id}".`);
      }
      ids.add(entry.id);
    }
    this.entries = new Map(options.entries.map((entry) => [entry.id, entry]));
    this.emit = options.emit;
    this.log = options.log;
    this.logError = options.logError;
  }

  /** Every catalog entry with its current state, catalog order preserved. */
  public snapshot(): readonly SourceSnapshotEntry[] {
    return [...this.entries.values()].map((entry) => ({
      id: entry.id,
      label: entry.label,
      state: this.stateOf(entry),
    }));
  }

  private stateOf(entry: SourceEntry): SourceState {
    if (entry.create === undefined) return "unsupported";
    if (this.running.has(entry.id)) return "running";
    return "stopped";
  }

  /**
   * Starts the catalog's startable entries in declaration order — the same
   * order the session has always used. A failure reverse-stops what already
   * started and rethrows, so the caller's existing failure path disposes the
   * rest of the pipeline exactly as it did before this manager existed.
   */
  public async startAll(): Promise<void> {
    const started: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.create === undefined) continue;
      const result = await this.start(entry.id);
      if (!result.ok) {
        // Nothing else is running yet — this manager exists only for startup —
        // so a full reverse stop is exactly the partial-start undo.
        await this.stopAll();
        throw new Error(result.error);
      }
      started.push(entry.id);
    }
  }

  /**
   * Starts one declared source: fresh instance, fresh start. A start racing a
   * stop for the same id queues behind it on the chain, so the stop's drain
   * always completes first.
   */
  public async start(id: string): Promise<SourceToggleResult> {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return { ok: false, error: `Unknown source "${id}".` };
    }
    if (entry.create === undefined) {
      return { ok: false, error: `Source "${id}" is not available in this run.` };
    }
    return this.enqueue(id, async () => {
      // Re-checked under the chain: a queued toggle storm may have started or
      // stopped the source between the cheap guard above and this callback.
      if (this.running.has(id)) {
        return { ok: false, error: `Source "${id}" is already running.` };
      }
      // Hoisted so the closure keeps the narrowed non-undefined factory; TS
      // resets property narrowing across a function boundary, and a non-null
      // assertion would be the quiet way around it.
      const create = entry.create;
      if (create === undefined) {
        return { ok: false, error: `Source "${id}" is not available in this run.` };
      }
      let source: ActivitySource;
      try {
        source = create();
      } catch (error) {
        return { ok: false, error: `Source "${id}" could not be built: ${describeErrorForAudit(error)}` };
      }
      if (source.id !== id) {
        // A recipe reporting a different identity splits the catalog key from
        // the event metadata; refuse rather than serve two truths.
        return { ok: false, error: `Source "${id}" built an instance reporting itself as "${source.id}".` };
      }
      try {
        await source.start(this.emit);
      } catch (error) {
        return { ok: false, error: `Source "${id}" failed to start: ${describeErrorForAudit(error)}` };
      }
      this.running.set(id, source);
      this.log(JSON.stringify({ source: id, started: true }));
      // No prompt hook here on purpose: a start emits no event, so there is
      // nothing new to think about. The source's first observation reaches the
      // agent through the ingest path like any other event.
      return { ok: true, state: "running" };
    });
  }

  /**
   * Stops one running source. The source leaves `running` only after `stop()`
   * resolves, per the drain-then-quiet contract, so every buffered event has
   * already reached the emit path when the caller learns it stopped.
   */
  public async stop(id: string): Promise<SourceToggleResult> {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return { ok: false, error: `Unknown source "${id}".` };
    }
    if (entry.create === undefined) {
      return { ok: false, error: `Source "${id}" is not available in this run.` };
    }
    return this.enqueue(id, async () => {
      const source = this.running.get(id);
      if (source === undefined) {
        // Queued behind another operation that stopped it first. Checked before
        // the floor so a not-running source never hears the observer message —
        // that refusal is about *it*, not about the catalog.
        return { ok: false, error: `Source "${id}" is not running.` };
      }
      // The floor counts sources actually running, and a stop that is still in
      // flight holds its `running` seat until it resolves, so size can only
      // shrink between now and this source's own removal. One observer left
      // means refusing here is the same promise startup makes with a
      // zero-source catalog, just enforced at runtime.
      if (this.running.size <= 1) {
        return { ok: false, error: `Source "${id}" is the only observer; a watch session needs at least one.` };
      }
      try {
        await source.stop();
      } catch (error) {
        // The stop contract says quiet, but a source that rejects anyway is
        // still removed: a wedged stop must not leave the panel unable to try
        // again, and its own diagnostics have already reported the failure.
        this.logError(JSON.stringify({ source: id, stopError: describeErrorForAudit(error) }));
      }
      this.running.delete(id);
      this.log(JSON.stringify({ source: id, started: false }));
      return { ok: true, state: "stopped" };
    });
  }

  private enqueue(id: string, work: () => Promise<SourceToggleResult>): Promise<SourceToggleResult> {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.chains.set(id, next);
    return next;
  }

  /** Reverse-order stop of everything still running. Called only by session teardown. */
  public async stopAll(): Promise<void> {
    for (const id of [...this.running.keys()].reverse()) {
      const source = this.running.get(id);
      if (source === undefined) continue;
      try {
        await source.stop();
      } catch {
        // Teardown: a source that will not stop quietly has already been
        // reported by its own diagnostics; the session must still come down.
      }
      this.running.delete(id);
    }
  }
}
