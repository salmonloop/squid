import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { sanitizeAuditText } from "./audit-text.js";
import { loadConfiguredEnvironment } from "./effective-env.js";
import { BrowserPageActivitySource } from "./browser-page-source.js";
import { EditorSaveActivitySource } from "./editor-save-source.js";
import { FilesystemActivitySource } from "./filesystem-source.js";
import type { SourceEntry } from "./activity-source.js";
import type { FilePayload } from "./protocol.js";
import { resolveDesktopNotice } from "./resolve-desktop-notice.js";
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
  type WatchSessionOptions,
  type WatchSessionResult,
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
 *
 * The source assembly is a function, not script code, because it has two
 * callers: this CLI and the packaged `squid-app` entry. Both must observe the
 * desktop through exactly one assembly — the ordering below decides what the
 * admission rules can ever see, and a second copy of it would be a second,
 * silently diverging answer to that question.
 */
export interface StartDesktopWatchOptions {
  /** Absolute directory to watch. Validated by the caller for the CLI shape. */
  readonly root: string;
  readonly databasePath?: string;
  /** Replay frames for the screen reader; production omits it. */
  readonly framesPath?: string;
  /** Replay frames for the browser reader; production omits it. */
  readonly browserFramesPath?: string;
  /** Injected in tests; production reads the process environment. */
  readonly env?: Record<string, string | undefined>;
  readonly log?: (line: string) => void;
  readonly logError?: (line: string) => void;
  readonly agentDir?: string;
  /** Injected in tests so no suite starts a real model runtime. */
  readonly createAgentSession?: WatchSessionOptions["createAgentSession"];
}

export async function startDesktopWatch(
  options: StartDesktopWatchOptions,
): Promise<WatchSessionResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const logError = options.logError ?? ((line: string) => console.error(line));

  // Step 0: the config file pre-fills the same variables the env carries, and
  // a problem with it fails before the fail-fast chain below even starts.
  // Tests point it at a temp file through SQUID_CONFIG in the injected env —
  // the one override the resolver already defines, so there is no second way
  // to relocate the file.
  const loaded = loadConfiguredEnvironment(options.env ?? process.env);
  if ("configError" in loaded) {
    return { configError: loaded.configError };
  }
  const env = loaded.env;

  const databasePath = options.databasePath ?? env.SQUID_DB;
  if (databasePath !== undefined && !isAbsolute(databasePath)) {
    return { configError: "SQUID_DB must be an absolute path." };
  }

  // Every reader resolves against the *merged* env, not `process.env`.
  //
  // `loadConfiguredEnvironment` returns a merged object and deliberately does not
  // touch `process.env`, so a resolver called with no env reads the raw
  // environment and never sees the config file at all. These four used to be
  // called that way, which made `screenReader`, `browser`, `terminal`, and
  // `editorSaves` settings that saved, reported "takes effect on restart", and
  // then did nothing — the settings form offering switches wired to nothing. The
  // gate, retention, panel, and turn watchdog were already resolved from the
  // merged env one layer down; this is the same env reaching the other half of the
  // capabilities. A new reader added here must be passed it too.
  const reader = await resolveScreenReader({
    env,
    ...(options.framesPath === undefined ? {} : { framesPath: options.framesPath }),
  });
  if ("configError" in reader) {
    return { configError: reader.configError };
  }

  const browser = await resolveBrowserReader({
    env,
    ...(options.browserFramesPath === undefined
      ? {}
      : { framesPath: options.browserFramesPath }),
  });
  if ("configError" in browser) {
    return { configError: browser.configError };
  }

  const terminal = resolveTerminalReader({ env });
  if ("configError" in terminal) {
    return { configError: terminal.configError };
  }

  const editorSaves = resolveEditorSaveReader({ env });
  if ("configError" in editorSaves) {
    return { configError: editorSaves.configError };
  }

  // Not a reader — the one capability here that talks instead of listening — but
  // it resolves in the same place and against the same merged env, because the
  // alternative is the asymmetry above: a settings field that saves, reports
  // "takes effect on restart", and changes nothing.
  const notice = resolveDesktopNotice({ env });
  if ("configError" in notice) {
    return { configError: notice.configError };
  }

  const root = options.root;
  const canonicalRoot = await realpath(root);

  const started = await startWatchSession({
    env,
    log,
    logError,
    ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
    ...(options.createAgentSession === undefined
      ? {}
      : { createAgentSession: options.createAgentSession }),
    ...(databasePath === undefined ? {} : { databasePath }),
    ...(notice.enabled ? { notifierFactory: notice.notifierFactory } : {}),
    // Settings sets write back to the same file step zero read, so a form edit
    // and the next startup agree about what "saved" means.
    configPath: loaded.configPath,
    // Commands run in the watched root, matching `watch:files`. The screen source
    // contributes no paths, so it has no claim on the working directory.
    workingDirectory: canonicalRoot,
    banner: {
      watching: root,
      reader: reader.readerKind,
      browser: browser.enabled ? browser.readerKind : "off",
      terminal: terminal.enabled ? terminal.readerKind : "off",
      editorSaves: editorSaves.enabled ? editorSaves.readerKind : "off",
      notify: notice.enabled ? notice.noticeKind : "off",
    },
    createSources: async (context) => {
      // Only the filesystem source needs exclusions: neither a screen reader nor a
      // browser reader observes the tree the store writes into, so they cannot
      // feed themselves.
      const isSinkPath = await watchedSinkExclusions(context, canonicalRoot);
      const entries: SourceEntry[] = [
        {
          id: "filesystem-local",
          label: "Files",
          create: () => new FilesystemActivitySource({
            root,
            include: (relativePath) => !isSinkPath(relativePath),
            onDiagnostic: context.onDiagnostic,
          }),
        },
        {
          id: "screen-text-host",
          label: "Screen",
          create: () => new ScreenTextActivitySource({
            readerFactory: reader.readerFactory,
            onDiagnostic: context.onDiagnostic,
          }),
        },
      ];
      // Declared even when disabled, with no `create`: the panel's dump shows
      // the capability exists but this run cannot start it (state
      // `unsupported`), rather than hiding it and implying an all-seeing run.
      if (browser.enabled) {
        // Before the terminal source but after the screen source, so a page is
        // observed once a foreground exists to attribute it to. The reducer drops
        // an owner that does not match the current foreground, so ordering here
        // decides whether the two ever agree.
        entries.push({
          id: "browser-page-host",
          label: "Browser",
          create: () => new BrowserPageActivitySource({
            readerFactory: browser.readerFactory,
            onDiagnostic: context.onDiagnostic,
          }),
        });
      } else {
        entries.push({ id: "browser-page-host", label: "Browser" });
      }
      if (terminal.enabled) {
        entries.push({
          id: "terminal-command-host",
          label: "Terminal",
          create: () => new TerminalCommandActivitySource({
            readerFactory: terminal.readerFactory,
            onDiagnostic: context.onDiagnostic,
          }),
        });
      } else {
        entries.push({ id: "terminal-command-host", label: "Terminal" });
      }
      if (editorSaves.enabled) {
        // Last, and the only source that reports ownership rather than
        // observation: the editor names itself as the writer, so its events are
        // admissible for `run_tests` without the foreground pairing a watcher's
        // unattributed save can never satisfy. Ordering after the screen source
        // keeps the projection's foreground current before the strongest claim
        // lands.
        entries.push({
          id: "editor-save-host",
          label: "Editor saves",
          create: () => new EditorSaveActivitySource({
            readerFactory: editorSaves.readerFactory,
            root: canonicalRoot,
            onDiagnostic: context.onDiagnostic,
          }),
        });
      } else {
        entries.push({ id: "editor-save-host", label: "Editor saves" });
      }
      return entries;
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
    return started;
  }

  logError(JSON.stringify(started.session.banner));
  return started;
}

if (import.meta.main) {
  const root = process.argv[2];
  if (root === undefined || !isAbsolute(root)) {
    console.error("Usage: bun run watch:desktop -- <absolute-project-root> [frames.json]");
    process.exit(2);
  }

  const started = await startDesktopWatch({
    root,
    ...(process.argv[3] === undefined ? {} : { framesPath: process.argv[3] }),
    ...(process.argv[4] === undefined ? {} : { browserFramesPath: process.argv[4] }),
  });
  if ("configError" in started) {
    console.error(started.configError);
    process.exit(2);
  }
  installWatchSignalHandlers(started.session);
}
