import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import {
  panelExecutablePath,
  resolveAppPanel,
  resolveWatchRoot,
} from "./app-defaults.js";
import {
  askFirstRunAnswers,
  modelConfigurationStatus,
  writeModelConfiguration,
  type FirstRunIO,
} from "./app-model.js";
import { ensureDefaultConfigFile } from "./config-file.js";
import { resolveAgentDirPath } from "./config-paths.js";
import { loadConfiguredEnvironment } from "./effective-env.js";
import { resolvePiModel } from "./pi-session-factory.js";
import { startDesktopWatch } from "./watch-desktop.js";
import { installWatchSignalHandlers } from "./watch-session.js";

/**
 * The packaged entry point: the binary a user double-clicks.
 *
 * A double-click supplies no arguments and, on Windows, no PATH guarantees —
 * but it does supply a console the process keeps, which is why the first-run
 * conversation below is a console one rather than something the panel window
 * would have to grow. The flow is deliberately linear:
 *
 *   resolve model config (first-run when absent)
 *   → resolve watch root (home by default)
 *   → resolve the panel endpoint (platform default)
 *   → start the desktop watch through the one shared source assembly
 *   → spawn the panel binary sitting next to this one
 *
 * Everything with a default delegates to `app-defaults`, and every default
 * passes through the same resolvers a CLI run uses. This file owns only the
 * order and the two things genuinely new to a packaged run: the first-run
 * conversation and launching the panel.
 */

export interface LaunchPreparation {
  readonly env: Record<string, string | undefined>;
  readonly root: string;
  readonly panelSocket: string;
  /** The one resolved location the panel-first path may initialize when absent. */
  readonly configPath: string;
  /**
   * The provider this run keys Pi's files under, resolved from the merged env so
   * a file-backed `modelProvider` is honoured. Returned rather than recomputed
   * by the caller: it decides which entry first-run writes and which entry the
   * settings service edits, and two resolutions of it could disagree.
   */
  readonly provider: string;
}

export type PrepareLaunchResult =
  | { readonly configError: string }
  | {
      readonly needsFirstRun: true;
      /** The provider first-run must write under; see `LaunchPreparation`. */
      readonly provider: string;
    }
  | { readonly ready: LaunchPreparation };

/**
 * Resolves everything a packaged run needs before any sink opens, mirroring
 * the pre-sink resolution order `startWatchSession` enforces one layer down:
 * a config problem fails here, cheaply, rather than after a store exists.
 *
 * The panel endpoint is resolved here (not left to the layer below) because
 * the spawned panel child needs the same string in its environment — one
 * resolution, both consumers, no second opinion.
 */
export function prepareLaunch(options: {
  readonly env: Record<string, string | undefined>;
  readonly platform: NodeJS.Platform;
  readonly agentDir: string;
  /**
   * Overrides the provider instead of reading it from the merged env. Tests and
   * callers that already know which entry they mean pass it; a production launch
   * omits it so the config file's `modelProvider` is what decides.
   */
  readonly provider?: string;
  /**
   * The panel-supervised child has no interactive stdin: an absent model is not
   * a console-first-run question there, it is the `needs_config` state the panel
   * was built to render. Other packaged launches preserve the console first-run
   * flow, so a command-line `squid` still asks exactly once.
   */
  readonly allowNeedsConfig?: boolean;
}): PrepareLaunchResult {
  // Step 0: the config file pre-fills the variables everything below reads,
  // so a broken file fails before the model check — the same fail-fast spine
  // `startDesktopWatch` runs, one link further up. The merged env is what the
  // rest of this function sees, so `resolveWatchRoot` and the watch session
  // itself get the file's values through the variables they already read;
  // this layer adds no second reading of them.
  const loaded = loadConfiguredEnvironment(options.env, { platform: options.platform });
  if ("configError" in loaded) {
    return { configError: loaded.configError };
  }
  const mergedEnv = loaded.env;

  // After step 0, because `modelProvider` is a file-backed setting and the
  // supervisor clears the environment it spawns this process with: resolving the
  // provider before the merge would read the hardcoded default in exactly the
  // launch the panel recommends.
  const provider = resolvePiModel({ env: mergedEnv, ...(options.provider === undefined ? {} : { provider: options.provider }) }).provider;

  const status = modelConfigurationStatus(options.agentDir, provider);
  if (status.kind !== "ready") {
    if (status.kind === "malformed-models") {
      return {
        configError:
          "The Pi models.json is not valid JSON; fix or remove it — first-run will not overwrite a file it cannot read.",
      };
    }
    // The supervising panel is the first-run UI. Its child inherits no stdin, so
    // sending it into readline would be a blocked console prompt behind a window
    // that says nothing. Let the watch session start headless instead; it sees its
    // panel endpoint and reports `needs_config`, then this same process starts the
    // agent once the form writes the missing model files.
    if (options.allowNeedsConfig !== true) return { needsFirstRun: true, provider };
  }

  const root = resolveWatchRoot(mergedEnv, options.platform);
  if (!isAbsoluteRoot(root, options.platform)) {
    return { configError: "SQUID_WATCH_ROOT must be an absolute path." };
  }

  const panel = resolveAppPanel(mergedEnv, options.platform);
  if ("configError" in panel) {
    return { configError: panel.configError };
  }

  // The endpoint the session will listen on is exactly what the child gets —
  // including the resolver's normalized pipe spelling on Windows. The env is
  // the merged one, so file-configured settings travel to the session and the
  // spawned panel through the variables they already read.
  const env: Record<string, string | undefined> = {
    ...mergedEnv,
    SQUID_PANEL_SOCKET: panel.enabled ? panel.socketPath : undefined,
  };
  return {
    ready: {
      env,
      root,
      panelSocket: panel.enabled ? panel.socketPath : "",
      configPath: loaded.configPath,
      provider,
    },
  };
}

/**
 * Makes the settings file tangible for the panel-first run, and only that run.
 *
 * The supervisor is the source of `SQUID_SUPERVISED=1`; no other entry gets to
 * write a default file merely by launching. The config resolver stays the sole
 * authority for its path and its validity — this helper only creates `{}` when
 * the resolved file is absent, never repairs or overwrites an existing file.
 */
export function ensureSupervisedConfig(options: {
  readonly env: Record<string, string | undefined>;
  readonly configPath: string;
}): { readonly ok: true } | { readonly configError: string } {
  if (options.env.SQUID_SUPERVISED !== "1") return { ok: true };
  const created = ensureDefaultConfigFile(options.configPath);
  return "configError" in created ? { configError: created.configError } : { ok: true };
}

function isAbsoluteRoot(root: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    return /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\");
  }
  return root.startsWith("/");
}

/** Spawns the panel binary packaged next to this one. Best-effort; see header. */
export function spawnPanelProcess(options: {
  readonly socketPath: string;
  readonly env: Record<string, string | undefined>;
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly logError: (line: string) => void;
  readonly exists?: (path: string) => boolean;
  /** Checkout root, when this run has one; lets a from-source run find its build. */
  readonly projectRoot?: string;
}): void {
  if (options.socketPath.length === 0) return;
  // A supervised run was started *by* a panel, which is already attached and
  // already watching this process. Spawning one here would put a second window
  // on the same endpoint — and worse, one this process kills on shutdown while
  // the supervisor's own panel stays up expecting to respawn us. The supervisor
  // owns the panel's lifetime in that direction; this branch is what keeps the
  // ownership one-way.
  if (options.env.SQUID_SUPERVISED === "1") return;
  const exists = options.exists ?? existsSync;
  const exe = panelExecutablePath(
    options.platform === "win32" ? "windows" : "other",
    options.execPath,
    { exists, ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }) },
  );
  if (!exists(exe)) {
    // A diagnostic, not an error: the session runs, only the window is absent.
    options.logError(
      `The panel binary was not found at ${exe}; the session runs without a window.`,
    );
    return;
  }
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  // The child reads the endpoint from the same variable every other panel
  // client does; there is no second way to point a panel at a session.
  childEnv.SQUID_PANEL_SOCKET = options.socketPath;
  const child = Bun.spawn([exe], {
    env: childEnv,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  });
  // A session that exits leaves an orphan window reconnecting forever unless
  // the child dies with it. The cleanup rides the signals the watch session
  // treats as shutdown rather than the `exit` event, because Bun never runs
  // `exit` handlers — measured, not guessed: a natural exit skips them the
  // same way a signal exit does. Every registered SIGINT/SIGTERM handler runs,
  // so this does not compete with the session's own graceful shutdown; it
  // only makes sure the panel does not outlive its parent.
  const killPanel = (): void => {
    try {
      child.kill();
    } catch {
      // Already gone is the good case.
    }
  };
  process.on("SIGINT", killPanel);
  process.on("SIGTERM", killPanel);
}

/** The real first-run conversation: the double-clicked console. */
function consoleFirstRunIO(): FirstRunIO {
  const io = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return {
    prompt: (message, defaultValue) => io.question(`${message} [${defaultValue}]: `),
    // A plain prompt, no echo suppression: raw-mode tricks are terminal-shaped
    // and a double-clicked process's console may be none of those things. The
    // key lands in Pi's auth.json, which is where Pi's own CLI puts one too.
    secret: (message) => io.question(`${message}: `),
    say: (line) => console.log(line),
  };
}

if (import.meta.main) {
  const platform = process.platform;
  const env = process.env;
  const agentDir = resolveAgentDirPath({ env, platform });
  if (!process.env.PI_CODING_AGENT_DIR) {
    process.env.PI_CODING_AGENT_DIR = agentDir;
  }

  // No provider is passed: `prepareLaunch` resolves it after its own step 0, so
  // the config file's `modelProvider` decides. Resolving it here would read the
  // hardcoded default under the supervisor, which clears the environment.
  const supervised = env.SQUID_SUPERVISED === "1";
  let prepared = prepareLaunch({
    env,
    platform,
    agentDir,
    ...(supervised ? { allowNeedsConfig: true } : {}),
  });
  if ("needsFirstRun" in prepared) {
    const provider = prepared.provider;
    const answers = await askFirstRunAnswers(consoleFirstRunIO(), {
      // The suggestion only; whatever the user types is what gets written and,
      // from then on, what `resolveConfiguredModel` reports.
      modelId: resolvePiModel({ env }).modelId,
    });
    // Under the provider the preparation resolved, not a second reading of it:
    // first-run must write the entry the settings service will later edit.
    writeModelConfiguration(agentDir, provider, answers);
    prepared = prepareLaunch({ env, platform, agentDir, provider });
    // The setup wrote both halves of the configuration; still not ready means
    // something outside this conversation's control (permissions, a full
    // disk). Reporting beats looping back into the same questions.
    if ("needsFirstRun" in prepared) {
      console.error("First-run setup did not take; check permissions on " + agentDir);
      process.exit(2);
    }
  }
  if ("configError" in prepared) {
    console.error(prepared.configError);
    process.exit(2);
  }

  // Only the panel's supervised child gets a tangible empty settings file. The
  // file was already resolved and read above, so this cannot overwrite malformed
  // hand-written content; it only turns absence into the `{}` the settings form
  // can later update atomically.
  const config = ensureSupervisedConfig({
    env: prepared.ready.env,
    configPath: prepared.ready.configPath,
  });
  if ("configError" in config) {
    console.error(config.configError);
    process.exit(2);
  }

  const started = await startDesktopWatch({
    root: prepared.ready.root,
    env: prepared.ready.env,
    agentDir,
  });
  if ("configError" in started) {
    console.error(started.configError);
    process.exit(2);
  }

  installWatchSignalHandlers(started.session);
  spawnPanelProcess({
    socketPath: prepared.ready.panelSocket,
    env: prepared.ready.env,
    platform,
    execPath: process.execPath,
    // The checkout this module is running out of, when there is one. In a release
    // this resolves inside the unpacked zip and the `ui/target/release` candidate
    // simply does not exist, so the packaged path still wins by being the only one
    // there. From source it is what lets `bun run start` find the panel that
    // `cargo build --release` produced, rather than looking beside `bun.exe`.
    projectRoot: resolve(dirname(fileURLToPath(new URL(import.meta.url))), ".."),
    logError: (line) => console.error(line),
  });
}
