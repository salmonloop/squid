import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createWatchRuntime } from "./create-watch-runtime.js";
import { createMacosScreenTextReader } from "./screen-text-reader-macos.js";
import {
  createSyntheticScreenTextReader,
  demoScreenTextFrames,
} from "./screen-text-reader-synthetic.js";
import {
  ScreenTextActivitySource,
  type ScreenTextFrame,
  type ScreenTextReaderFactory,
} from "./screen-text-source.js";
import { resolveWatchActions } from "./watch-actions.js";
import { resolveWatchProvider } from "./watch-provider.js";

const readerKind = process.env.SQUID_SCREEN_READER ?? "synthetic";
if (readerKind !== "darwin" && readerKind !== "synthetic") {
  console.error('SQUID_SCREEN_READER must be "darwin" or "synthetic".');
  process.exit(2);
}
// The real backend is chosen here, not inside the source: the adapter stays
// backend-agnostic, and picking the wrong one fails at startup instead of going
// quiet at runtime.
if (readerKind === "darwin" && process.platform !== "darwin") {
  console.error(`SQUID_SCREEN_READER=darwin requires macOS; this host reports ${process.platform}.`);
  process.exit(2);
}

// One knob for both backends: how often the reader produces a frame.
const rawPollMs = process.env.SQUID_SCREEN_POLL_MS;
const pollMs = rawPollMs === undefined ? undefined : Number(rawPollMs);
if (pollMs !== undefined && (!Number.isSafeInteger(pollMs) || pollMs <= 0)) {
  console.error("SQUID_SCREEN_POLL_MS must be a positive integer number of milliseconds.");
  process.exit(2);
}

const databasePath = process.env.SQUID_DB;
if (databasePath !== undefined && !isAbsolute(databasePath)) {
  console.error("SQUID_DB must be an absolute path.");
  process.exit(2);
}

const readerFactory: ScreenTextReaderFactory = readerKind === "darwin"
  ? createMacosScreenTextReader(pollMs === undefined ? {} : { pollMs })
  : createSyntheticScreenTextReader({
    frames: await loadFrames(process.argv[2]),
    ...(pollMs === undefined ? {} : { intervalMs: pollMs }),
  });

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

// Store, ledger, projection, and prediction runtime are identical for every watch
// entry point, so they are built in one place. This entry needs no watcher
// exclusions: a screen-text reader observes windows, not the tree the store
// writes into, so its own database can never feed itself.
const watch = createWatchRuntime({
  ...(databasePath === undefined ? {} : { databasePath }),
  provider: resolved.selection.provider,
  contextPolicy: resolved.selection.contextPolicy,
  actionTrust: resolved.selection.actionTrust,
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
const actions = await resolveWatchActions(
  watch.runtime,
  watch.ledger,
  process.env,
  { workingDirectory: process.cwd(), actionTrust: resolved.selection.actionTrust },
);
if (actions !== undefined && "configError" in actions) {
  console.error(actions.configError);
  await watch.dispose();
  process.exit(2);
}

const source = new ScreenTextActivitySource({
  readerFactory,
  onDiagnostic: (diagnostic) => {
    console.error(JSON.stringify({ diagnostic: diagnostic.kind, message: diagnostic.message }));
  },
});

await source.start(async (event) => {
  const result = await watch.runtime.ingest(event);
  // Read window and application from the projection rather than from `event`.
  // The projection is built from the *captured* event, so anything the capture
  // policy redacted stays redacted here; logging `event.payload` would print the
  // raw title this source observed, including one holding a credential.
  console.log(JSON.stringify({
    kind: event.kind,
    disposition: result.ingest.disposition,
    application: result.ingest.state.activeApplication?.name ?? null,
    window: result.ingest.state.activeWindow?.title ?? null,
    selection: result.ingest.state.textContext?.selection ?? null,
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
        const dispatched = await actions.dispatchTopCandidate(outcome, outcome.candidates);
        if (dispatched !== null) {
          console.log(JSON.stringify({
            candidateId: dispatched.candidateId,
            ...(dispatched.decision !== null
              ? { confirmation: dispatched.decision.outcome, reason: dispatched.decision.reason }
              : {}),
            ...(dispatched.action !== null
              ? {
                  dispatched: dispatched.action.candidateId,
                  outcome: dispatched.action.outcome,
                  ...(dispatched.action.error !== undefined ? { error: dispatched.action.error } : {}),
                }
              : {}),
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
  watching: "foreground-window-text",
  reader: readerKind,
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
    // Drain buffered frames before exiting so no observed sample is lost, then
    // dispose: a prediction whose outcome has not yet been written still has a
    // ledger write in flight, and closing first drops that record.
    void source.stop().then(async () => {
      // Cancel/settle confirmation and dispatch while the runtime is still
      // open: rejection and terminal action feedback must reach the ledger.
      if (actions !== undefined) await actions.close();
      await watch.dispose();
      process.exit(0);
    }).catch((error) => {
      console.error(JSON.stringify({ shutdownError: error instanceof Error ? error.message : String(error) }));
      process.exit(1);
    });
  });
}

/**
 * Reads a scripted frame list, or falls back to the built-in demo so
 * `bun run watch:screen` needs no arguments. Only the array shape is checked
 * here; a malformed frame is rejected later by protocol validation, which the
 * source reports as a delivery diagnostic rather than a crash.
 */
async function loadFrames(path: string | undefined): Promise<readonly ScreenTextFrame[]> {
  if (path === undefined) return demoScreenTextFrames;

  const absolutePath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    console.error(`Could not read frames from ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  if (!Array.isArray(parsed)) {
    console.error(`Frames file ${absolutePath} must contain a JSON array of frames.`);
    process.exit(2);
  }
  return parsed as readonly ScreenTextFrame[];
}
