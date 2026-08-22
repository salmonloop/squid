import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { sanitizeAuditText } from "./action-egress.js";
import { FilesystemActivitySource } from "./filesystem-source.js";
import type { FilePayload } from "./protocol.js";
import { resolveScreenReader } from "./resolve-screen-reader.js";
import { ScreenTextActivitySource } from "./screen-text-source.js";
import {
  installWatchSignalHandlers,
  startWatchSession,
  watchedSinkExclusions,
} from "./watch-session.js";

/**
 * The only entry point where an action can actually be admitted.
 *
 * `watch:files` and `watch:screen` each observe one half of the desktop, and
 * several admission rules need both halves at once. `run_tests` compares the
 * owner of the newest save against the foreground application: the filesystem
 * source knows the path and reports `applicationId: null`, while the screen
 * source knows which application is in front. Neither alone can satisfy the
 * check, so a single-source run refuses every `run_tests` candidate with
 * `coding_application_mismatch` no matter how the world actually looks.
 *
 * Combining happens in the projection, not here and not in a source: this entry
 * point only makes both fact streams land in one core. Whether an unattributed
 * save may be treated as the foreground application's work stays an admission
 * decision, and today the answer is still no — see the
 * `filesystem-save-run-tests` fixture.
 */

const root = process.argv[2];
if (root === undefined || !isAbsolute(root)) {
  console.error("Usage: bun run watch:desktop -- <absolute-project-root> [frames.json]");
  process.exit(2);
}

const databasePath = process.env.SQUID_DB;
if (databasePath !== undefined && !isAbsolute(databasePath)) {
  console.error("SQUID_DB must be an absolute path.");
  process.exit(2);
}

const reader = await resolveScreenReader(
  process.argv[3] === undefined ? {} : { framesPath: process.argv[3] },
);
if ("configError" in reader) {
  console.error(reader.configError);
  process.exit(2);
}

const canonicalRoot = await realpath(root);

const started = await startWatchSession({
  ...(databasePath === undefined ? {} : { databasePath }),
  // Commands run in the watched root, matching `watch:files`. The screen source
  // contributes no paths, so it has no claim on the working directory.
  workingDirectory: canonicalRoot,
  banner: { watching: root, reader: reader.readerKind },
  createSources: async (context) => {
    // Only the filesystem source needs exclusions: a screen reader observes
    // windows, not the tree the store writes into, so it cannot feed itself.
    const excludedPaths = await watchedSinkExclusions(context, canonicalRoot);
    return [
      new FilesystemActivitySource({
        root,
        include: (relativePath) => !excludedPaths.has(relativePath),
        onDiagnostic: context.onDiagnostic,
      }),
      new ScreenTextActivitySource({
        readerFactory: reader.readerFactory,
        onDiagnostic: context.onDiagnostic,
      }),
    ];
  },
  // One line shape for both sources, read from the projection rather than the
  // raw payload so capture-policy redaction survives into the log. `path` is
  // present only for file events; the rest describe the foreground.
  describeEvent: (event, result) => {
    const state = result.ingest.state;
    const selection = state.textContext?.selection ?? null;
    const path = event.kind === "file_opened" || event.kind === "file_saved"
      ? (event.payload as FilePayload).path
      : null;
    return {
      kind: event.kind,
      disposition: result.ingest.disposition,
      path,
      application: state.activeApplication?.name ?? null,
      window: state.activeWindow?.title ?? null,
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
