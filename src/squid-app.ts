import { existsSync } from "node:fs";
import * as readline from "node:readline/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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
 *
 * The panel launch is best-effort on purpose, and not defensively: the panel
 * is an observer, and "a dead panel must not take down the watch session" is
 * the standing rule the panel server itself is written against. A zip missing
 * its `squid-ui` still leaves a working capture session; it just reports why
 * nothing opened.
 */

export interface LaunchPreparation {
  readonly env: Record<string, string | undefined>;
  readonly root: string;
  readonly panelSocket: string;
}

export type PrepareLaunchResult =
  | { readonly configError: string }
  | { readonly needsFirstRun: true }
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
  readonly provider: string;
}): PrepareLaunchResult {
  const status = modelConfigurationStatus(options.agentDir, options.provider);
  if (status.kind !== "ready") {
    if (status.kind === "malformed-models") {
      return {
        configError:
          "The Pi models.json is not valid JSON; fix or remove it — first-run will not overwrite a file it cannot read.",
      };
    }
    return { needsFirstRun: true };
  }

  const root = resolveWatchRoot(options.env, options.platform);
  if (!isAbsoluteRoot(root, options.platform)) {
    return { configError: "SQUID_WATCH_ROOT must be an absolute path." };
  }

  const panel = resolveAppPanel(options.env, options.platform);
  if ("configError" in panel) {
    return { configError: panel.configError };
  }

  // The endpoint the session will listen on is exactly what the child gets —
  // including the resolver's normalized pipe spelling on Windows.
  const env: Record<string, string | undefined> = {
    ...options.env,
    SQUID_PANEL_SOCKET: panel.enabled ? panel.socketPath : undefined,
  };
  return {
    ready: {
      env,
      root,
      panelSocket: panel.enabled ? panel.socketPath : "",
    },
  };
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
}): void {
  if (options.socketPath.length === 0) return;
  const exe = panelExecutablePath(
    options.platform === "win32" ? "windows" : "other",
    options.execPath,
  );
  const exists = options.exists ?? existsSync;
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
  const agentDir = getAgentDir();
  const model = resolvePiModel({});

  let prepared = prepareLaunch({ env, platform, agentDir, provider: model.provider });
  if ("needsFirstRun" in prepared) {
    const answers = await askFirstRunAnswers(consoleFirstRunIO(), {
      modelId: model.modelId,
    });
    writeModelConfiguration(agentDir, model.provider, answers);
    prepared = prepareLaunch({ env, platform, agentDir, provider: model.provider });
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

  const started = await startDesktopWatch({
    root: prepared.ready.root,
    env: prepared.ready.env,
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
    logError: (line) => console.error(line),
  });
}
