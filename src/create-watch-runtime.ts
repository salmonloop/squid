import type { EventStore } from "./event-store.js";
import { InMemoryEventStore } from "./event-store.js";
import { PredictionRuntime } from "./prediction-runtime.js";
import { resolveCaptureExclusion } from "./capture-exclusion.js";
import { SqliteEventStore } from "./sqlite-event-store.js";
import { SquidCore } from "./squid-core.js";

/**
 * The shared setup both watch entry points need: a store, a core projection,
 * and the capture runtime layered over it. The entry point owns everything
 * source-specific — root canonicalization, watcher exclusions, the source
 * itself, signal handling — so this function carries no filesystem or
 * screen-text assumptions.
 *
 * It used to also build a prediction ledger, a context policy, and a
 * coordinator wrapping a provider, because Squid decided what happened next and
 * had to record why. The resident agent decides now, and Pi's session history is
 * where its reasoning and tool calls live, so what is left is the sensory spine:
 * capture, ingest, project.
 *
 * `databasePath` is read and validated by the caller; this function only
 * branches on whether it was provided, so it stays a pure function of its input
 * and never touches `process.env`.
 */
export interface WatchRuntime {
  readonly core: SquidCore;
  readonly runtime: PredictionRuntime;
  readonly store: EventStore;
  readonly databasePath: string | undefined;
  /**
   * Drain in-flight ingests, then close the durable sink. Closing first would
   * drop an event mid-write.
   */
  dispose(): Promise<void>;
}

export interface CreateWatchRuntimeOptions {
  /**
   * Absolute path to the SQLite database, or `undefined` for in-memory storage.
   * The caller validates absoluteness; this function only decides durability
   * from whether a path is present.
   */
  readonly databasePath?: string;
  /**
   * Raw `SQUID_EXCLUDE` value: comma-separated application names to drop at
   * capture, before the store. Resolved here so a malformed list fails the
   * run before any sink opens rather than silently capturing everything.
   */
  readonly excludeApplications?: string;
}

export function createWatchRuntime(options: CreateWatchRuntimeOptions): WatchRuntime {
  const databasePath = options.databasePath;
  const store: EventStore = databasePath === undefined
    ? new InMemoryEventStore()
    : new SqliteEventStore(databasePath);

  // Capture composes here, once per process: exclusion wraps redaction, so an
  // excluded event is dropped and every kept one is still redacted. A malformed
  // exclusion list is a startup error — the caller resolves before any sink
  // opens.
  const captureExclusion = resolveCaptureExclusion(options.excludeApplications);
  if ("configError" in captureExclusion) {
    throw new TypeError(captureExclusion.configError);
  }

  const core = new SquidCore(store);
  const runtime = new PredictionRuntime(core, {
    // Both paths redact: there is no reason to ever let a credential cross the
    // ingress boundary unredacted, durable or not. Exclusion (when configured)
    // narrows further on top of this policy.
    capturePolicy: captureExclusion,
  });

  return {
    core,
    runtime,
    store,
    databasePath,
    async dispose() {
      await runtime.dispose();
      if (store instanceof SqliteEventStore) store.close();
    },
  };
}
