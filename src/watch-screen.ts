import { isAbsolute } from "node:path";
import { sanitizeAuditText } from "./action-egress.js";
import { resolveScreenReader } from "./resolve-screen-reader.js";
import { ScreenTextActivitySource } from "./screen-text-source.js";
import { installWatchSignalHandlers, startWatchSession } from "./watch-session.js";

const databasePath = process.env.SQUID_DB;
if (databasePath !== undefined && !isAbsolute(databasePath)) {
  console.error("SQUID_DB must be an absolute path.");
  process.exit(2);
}

const reader = await resolveScreenReader(
  process.argv[2] === undefined ? {} : { framesPath: process.argv[2] },
);
if ("configError" in reader) {
  console.error(reader.configError);
  process.exit(2);
}

// This entry needs no watcher exclusions: a screen-text reader observes windows,
// not the tree the store writes into, so its own database can never feed itself.
const started = await startWatchSession({
  ...(databasePath === undefined ? {} : { databasePath }),
  workingDirectory: process.cwd(),
  banner: { watching: "foreground-window-text", reader: reader.readerKind },
  createSources: async (context) => [new ScreenTextActivitySource({
    readerFactory: reader.readerFactory,
    onDiagnostic: context.onDiagnostic,
  })],
  // Read window and application from the projection rather than from `event`.
  // The projection is built from the *captured* event, so anything the capture
  // policy redacted stays redacted here; logging `event.payload` would print the
  // raw title this source observed, including one holding a credential.
  // The selection is the one piece of text that needs explicit consent before it
  // may leave the machine, so stdout carries only its length — never the text.
  // Anything else would leak through a log what the egress policy withholds.
  describeEvent: (event, result) => {
    const selection = result.ingest.state.textContext?.selection ?? null;
    return {
      kind: event.kind,
      disposition: result.ingest.disposition,
      application: result.ingest.state.activeApplication?.name ?? null,
      window: result.ingest.state.activeWindow?.title ?? null,
      selectionLength: selection === null
        ? null
        : sanitizeAuditText(selection, "selection").originalLength,
    };
  },
});

if ("configError" in started) {
  console.error(started.configError);
  process.exit(2);
}

console.error(JSON.stringify(started.session.banner));
installWatchSignalHandlers(started.session);
