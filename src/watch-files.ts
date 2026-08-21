import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createWatchRuntime } from "./create-watch-runtime.js";
import { FilesystemActivitySource } from "./filesystem-source.js";
import type { FilePayload } from "./protocol.js";
import { sqliteWatchExclusions } from "./sqlite-event-store.js";
import {
  dispatchTopCandidate,
  resolveWatchActions,
} from "./watch-actions.js";
import { resolveWatchProvider } from "./watch-provider.js";

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

// Choose the primary predictor before opening any sink: a config error or a
// declined model must not leave a half-created database behind. The default
// `SQUID_PROVIDER=heuristic` never touches a model.
const resolved = await resolveWatchProvider();
if (!resolved.ok) {
  console.error(resolved.configError);
  process.exit(2);
}
if (resolved.selection.declineReason !== null) {
  console.error(JSON.stringify({
    provider: resolved.selection.provider.name,
    declined: resolved.selection.declineReason,
  }));
}

// Store, ledger, projection, and prediction runtime are identical for every
// watch entry point, so they are built in one place. Everything below this line
// is filesystem-specific and stays here.
const watch = createWatchRuntime({
  ...(databasePath === undefined ? {} : { databasePath }),
  provider: resolved.selection.provider,
  onDiagnostic: (diagnostic) => {
    console.error(JSON.stringify({ diagnostic: diagnostic.kind, message: diagnostic.message }));
  },
});

// Rebuild the dedupe index and projection from history before observing, so a
// restart cannot re-ingest an event the store already holds.
const restored = await watch.runtime.restore();

// The action half of the closed loop, off unless SQUID_ACTIONS opts in. Like
// the provider above it is resolved before the source starts: a typo in the
// variable must fail loudly here, not silently disable execution.
const actions = await resolveWatchActions(watch.runtime, watch.ledger);
if (actions !== undefined && "configError" in actions) {
  console.error(actions.configError);
  process.exit(2);
}

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
    void result.prediction.then(async (outcome) => {
      console.log(JSON.stringify({
        requestId: outcome.requestId,
        status: outcome.status,
        provider: outcome.provider,
        predictions: outcome.candidates.map((prediction) => prediction.kind),
      }));
      if (actions !== undefined) {
        const action = await dispatchTopCandidate(outcome, outcome.candidates, actions.dispatcher);
        if (action !== null) {
          console.log(JSON.stringify({
            dispatched: action.candidateId,
            outcome: action.outcome,
            ...(action.error !== undefined ? { error: action.error } : {}),
          }));
        }
      }
    }).catch((error) => {
      // The prediction promise itself never rejects (the coordinator resolves
      // every request); this guards the dispatch half so one failed dispatch
      // cannot take down the ingest loop.
      console.error(JSON.stringify({ dispatchError: error instanceof Error ? error.message : String(error) }));
    });
  }
});

console.error(JSON.stringify({
  watching: root,
  source: source.id,
  provider: resolved.selection.provider.name,
  ...(actions !== undefined ? { actions: actions.gatewayId } : {}),
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
      // The MCP client transport is closed last so a dispatch still in flight
      // during drain keeps its connection.
      if (actions !== undefined) await actions.close();
      process.exit(0);
    }).catch((error) => {
      console.error(JSON.stringify({ shutdownError: error instanceof Error ? error.message : String(error) }));
      process.exit(1);
    });
  });
}
