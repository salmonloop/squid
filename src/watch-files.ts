import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { FilesystemActivitySource } from "./filesystem-source.js";
import type { FilePayload } from "./protocol.js";
import {
  installWatchSignalHandlers,
  startWatchSession,
  watchedSinkExclusions,
} from "./watch-session.js";

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

const canonicalRoot = await realpath(root);

const started = await startWatchSession({
  ...(databasePath === undefined ? {} : { databasePath }),
  workingDirectory: canonicalRoot,
  banner: { watching: root },
  createSources: async (context) => {
    const excludedPaths = await watchedSinkExclusions(context, canonicalRoot);
    return [{
      id: "filesystem-local",
      label: "Files",
      create: () => new FilesystemActivitySource({
        root,
        include: (relativePath) => !excludedPaths.has(relativePath),
        onDiagnostic: context.onDiagnostic,
      }),
    }];
  },
  describeEvent: (event, result) => ({
    kind: event.kind,
    path: (event.payload as FilePayload).path,
    disposition: result.ingest.disposition,
  }),
});

if ("configError" in started) {
  console.error(started.configError);
  process.exit(2);
}

console.error(JSON.stringify(started.session.banner));
installWatchSignalHandlers(started.session);
