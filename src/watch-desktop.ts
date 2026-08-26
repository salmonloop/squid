import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { sanitizeAuditText } from "./action-egress.js";
import { BrowserPageActivitySource } from "./browser-page-source.js";
import { EditorSaveActivitySource } from "./editor-save-source.js";
import { FilesystemActivitySource } from "./filesystem-source.js";
import type { ActivitySource } from "./activity-source.js";
import type { FilePayload } from "./protocol.js";
import { resolveBrowserReader } from "./resolve-browser-reader.js";
import { resolveEditorSaveReader } from "./resolve-editor-save-reader.js";
import { resolveScreenReader } from "./resolve-screen-reader.js";
import { resolveTerminalReader } from "./resolve-terminal-reader.js";
import { ScreenTextActivitySource } from "./screen-text-source.js";
import { TerminalCommandActivitySource } from "./terminal-command-source.js";
import {
  installWatchSignalHandlers,
  startWatchSession,
  watchedSinkExclusions,
} from "./watch-session.js";

/**
 * The only entry point where an action can actually be admitted.
 *
 * `watch:files` and `watch:screen` each observe one part of the desktop, and
 * every admission rule reads the whole projection. `run_tests` compares the
 * owner of the newest save against the foreground application: the filesystem
 * source knows the path and reports `applicationId: null`, while the screen
 * source knows which application is in front. `search_selection` needs a current
 * browser page as well, so it takes a third source. No single-source run can
 * satisfy either rule, whatever the user is actually doing.
 *
 * Combining happens in the projection, not here and not in a source: this entry
 * point only makes the fact streams land in one core. Whether an unattributed
 * save may be treated as the foreground application's work stays an admission
 * decision, and today the answer is still no — see the
 * `filesystem-save-run-tests` fixture.
 *
 * The browser source is opt-in via `SQUID_BROWSER` — there is no default
 * browser to observe, so this names a capability rather than lifting a gate.
 * Egress allows by default; `SQUID_SEARCH_EGRESS=deny` is the restriction.
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

const browser = await resolveBrowserReader(
  process.argv[4] === undefined ? {} : { framesPath: process.argv[4] },
);
if ("configError" in browser) {
  console.error(browser.configError);
  process.exit(2);
}

const terminal = resolveTerminalReader();
if ("configError" in terminal) {
  console.error(terminal.configError);
  process.exit(2);
}

const editorSaves = resolveEditorSaveReader();
if ("configError" in editorSaves) {
  console.error(editorSaves.configError);
  process.exit(2);
}

const canonicalRoot = await realpath(root);

const started = await startWatchSession({
  ...(databasePath === undefined ? {} : { databasePath }),
  // Commands run in the watched root, matching `watch:files`. The screen source
  // contributes no paths, so it has no claim on the working directory.
  workingDirectory: canonicalRoot,
  banner: {
    watching: root,
    reader: reader.readerKind,
    browser: browser.enabled ? browser.readerKind : "off",
    terminal: terminal.enabled ? terminal.readerKind : "off",
    editorSaves: editorSaves.enabled ? editorSaves.readerKind : "off",
  },
  createSources: async (context) => {
    // Only the filesystem source needs exclusions: neither a screen reader nor a
    // browser reader observes the tree the store writes into, so they cannot
    // feed themselves.
    const excludedPaths = await watchedSinkExclusions(context, canonicalRoot);
    const sources: ActivitySource[] = [
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
    if (browser.enabled) {
      // Before the terminal source but after the screen source, so a page is
      // observed once a foreground exists to attribute it to. The reducer drops
      // an owner that does not match the current foreground, and `admitSearch`
      // requires the selection to have been observed *after* the page, so
      // ordering here decides whether the three ever agree.
      sources.push(new BrowserPageActivitySource({
        readerFactory: browser.readerFactory,
        onDiagnostic: context.onDiagnostic,
      }));
    }
    if (terminal.enabled) {
      sources.push(new TerminalCommandActivitySource({
        readerFactory: terminal.readerFactory,
        onDiagnostic: context.onDiagnostic,
      }));
    }
    if (editorSaves.enabled) {
      // Last, and the only source that reports ownership rather than
      // observation: the editor names itself as the writer, so its events are
      // admissible for `run_tests` without the foreground pairing a watcher's
      // unattributed save can never satisfy. Ordering after the screen source
      // keeps the projection's foreground current before the strongest claim
      // lands.
      sources.push(new EditorSaveActivitySource({
        readerFactory: editorSaves.readerFactory,
        root: canonicalRoot,
        onDiagnostic: context.onDiagnostic,
      }));
    }
    return sources;
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
      // Host only, never the full URL: a path or query string is user browsing
      // history, and this line goes to stdout. `RedactingContextPolicy` makes the
      // same distinction for what a provider may see.
      browserHost: state.currentBrowserPage?.host ?? null,
      // Class and exit code only. The raw command line never entered the
      // timeline, so there is nothing here to withhold — but naming the fields
      // explicitly keeps that visible at the log boundary.
      commandClass: state.lastCommandOutcome?.commandClass ?? null,
      commandExit: state.lastCommandOutcome?.exitCode ?? null,
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
