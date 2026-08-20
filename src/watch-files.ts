import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { InMemoryEventStore, type EventStore } from "./event-store.js";
import { InMemoryPredictionLedger } from "./prediction-ledger.js";
import { SqlitePredictionLedger } from "./sqlite-prediction-ledger.js";
import { FilesystemActivitySource } from "./filesystem-source.js";
import type { FilePayload } from "./protocol.js";
import { HeuristicPredictor } from "./baseline-predictor.js";
import { PredictionCoordinator } from "./prediction-coordinator.js";
import { SyncPredictorProvider } from "./prediction-provider.js";
import { PredictionRuntime } from "./prediction-runtime.js";
import { RedactingCapturePolicy } from "./capture-policy.js";
import { SqliteEventStore, sqliteWatchExclusions } from "./sqlite-event-store.js";
import { SquidCore } from "./squid-core.js";

const root = process.argv[2];
if (root === undefined || !isAbsolute(root)) {
  console.error("Usage: bun run watch:files -- <absolute-project-root>");
  process.exit(2);
}

const databasePath = process.env.SQUID_DB;
if (databasePath !== undefined && !isAbsolute(databasePath)) {
  console.error("SQUID_DB must be an absolute path.");
  process.exit(2);
}

const store: EventStore = databasePath === undefined
  ? new InMemoryEventStore()
  : new SqliteEventStore(databasePath);

// The ledger follows the same durability switch as the event store: a run that
// persists its timeline should also persist why it predicted what it did. It
// lives in a sibling file rather than the event database so replaying the
// timeline never contends with prediction writes.
const ledgerPath = databasePath === undefined ? undefined : `${databasePath}.ledger.db`;
const ledger = ledgerPath === undefined
  ? new InMemoryPredictionLedger()
  : new SqlitePredictionLedger(ledgerPath);

const core = new SquidCore(store);
const runtime = new PredictionRuntime(
  core,
  new PredictionCoordinator({
    provider: new SyncPredictorProvider(new HeuristicPredictor()),
  }),
  {
    ledger,
    // The durable path persists events, so capture redacts credential content
    // before it reaches the store — the same opt-in posture as the ledger.
    capturePolicy: new RedactingCapturePolicy(),
    onDiagnostic: (diagnostic) => {
      console.error(JSON.stringify({ diagnostic: diagnostic.kind, message: diagnostic.message }));
    },
  },
);

// Rebuild the dedupe index and projection from history before observing, so a
// restart cannot re-ingest an event the store already holds.
const restored = await runtime.restore();

// Both sides must be canonical: the source reports paths relative to
// `realpath(root)`, so comparing against a symlinked spelling would silently
// match nothing and let the feedback loop back in. The store constructor above
// has already created the database file, so it is resolvable here.
const canonicalRoot = databasePath === undefined ? null : await realpath(root);
const excludedPaths = new Set(
  canonicalRoot === null
    ? []
    : [
      ...sqliteWatchExclusions(canonicalRoot, await realpath(databasePath!)),
      // The ledger is a second SQLite database in the same tree, so it needs
      // the same exclusions or its own writes re-enter the timeline.
      ...sqliteWatchExclusions(canonicalRoot, await realpath(ledgerPath!)),
    ],
);

const source = new FilesystemActivitySource({
  root,
  include: (relativePath) => !excludedPaths.has(relativePath),
  onDiagnostic: (diagnostic) => {
    console.error(JSON.stringify({ diagnostic: diagnostic.kind, message: diagnostic.message }));
  },
});

await source.start(async (event) => {
  const result = await runtime.ingest(event);
  console.log(JSON.stringify({
    kind: event.kind,
    path: (event.payload as FilePayload).path,
    disposition: result.ingest.disposition,
  }));
  if (result.prediction !== null) {
    void result.prediction.then((outcome) => {
      console.log(JSON.stringify({
        requestId: outcome.requestId,
        status: outcome.status,
        provider: outcome.provider,
        predictions: outcome.candidates.map((prediction) => prediction.kind),
      }));
    });
  }
});

console.error(JSON.stringify({
  watching: root,
  source: source.id,
  store: databasePath ?? "memory",
  ledger: ledgerPath ?? "memory",
  restoredActions: restored.recentActions.length,
}));

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Drain buffered events before exiting so no observed write is lost.
    void source.stop().then(async () => {
      // Dispose before closing. A prediction whose outcome has not yet been
      // written still has a ledger write in flight, and `dispose` drains it;
      // closing first drops that record — measured as 0 records versus 1.
      await runtime.dispose();
      if (store instanceof SqliteEventStore) store.close();
      if (ledger instanceof SqlitePredictionLedger) ledger.close();
      process.exit(0);
    });
  });
}
