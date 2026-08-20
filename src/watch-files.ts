import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { HeuristicPredictor } from "./baseline-predictor.js";
import { createWatchRuntime } from "./create-watch-runtime.js";
import { FilesystemActivitySource } from "./filesystem-source.js";
import { SyncPredictorProvider } from "./prediction-provider.js";
import type { FilePayload } from "./protocol.js";
import { sqliteWatchExclusions } from "./sqlite-event-store.js";

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

// Store, ledger, projection, and prediction runtime are identical for every
// watch entry point, so they are built in one place. Everything below this line
// is filesystem-specific and stays here.
const watch = createWatchRuntime({
  ...(databasePath === undefined ? {} : { databasePath }),
  provider: new SyncPredictorProvider(new HeuristicPredictor()),
  onDiagnostic: (diagnostic) => {
    console.error(JSON.stringify({ diagnostic: diagnostic.kind, message: diagnostic.message }));
  },
});

// Rebuild the dedupe index and projection from history before observing, so a
// restart cannot re-ingest an event the store already holds.
const restored = await watch.runtime.restore();

// Both sides must be canonical: the source reports paths relative to
// `realpath(root)`, so comparing against a symlinked spelling would silently
// match nothing and let the feedback loop back in. The store constructor above
// has already created the database file, so it is resolvable here. The ledger is
// a second SQLite database in the same tree and needs the same exclusions.
const excludedPaths = new Set<string>();
if (databasePath !== undefined && watch.ledgerPath !== undefined) {
  const canonicalRoot = await realpath(root);
  for (const sinkPath of [databasePath, watch.ledgerPath]) {
    for (const excluded of sqliteWatchExclusions(canonicalRoot, await realpath(sinkPath))) {
      excludedPaths.add(excluded);
    }
  }
}

const source = new FilesystemActivitySource({
  root,
  include: (relativePath) => !excludedPaths.has(relativePath),
  onDiagnostic: (diagnostic) => {
    console.error(JSON.stringify({ diagnostic: diagnostic.kind, message: diagnostic.message }));
  },
});

await source.start(async (event) => {
  const result = await watch.runtime.ingest(event);
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
  store: watch.databasePath ?? "memory",
  ledger: watch.ledgerPath ?? "memory",
  restoredActions: restored.recentActions.length,
}));

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Drain buffered events before exiting so no observed write is lost, then
    // dispose: a prediction whose outcome has not yet been written still has a
    // ledger write in flight, and closing first drops that record.
    void source.stop().then(async () => {
      await watch.dispose();
      process.exit(0);
    });
  });
}
