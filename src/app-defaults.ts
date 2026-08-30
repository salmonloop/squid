import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix } from "node:path";
import { PANEL_PIPE_PREFIX, resolvePanel, type PanelResolution } from "./resolve-panel.js";

/**
 * Default answers for a double-click.
 *
 * The packaged binary is started with no arguments and often no environment: a
 * user downloads it and runs it. Everything the watch session needs must
 * therefore have a default, and each default here is the least surprising
 * answer for the machine it runs on — overridable by the same variables the
 * CLI entry reads, so nothing about the packaged run is a second configuration
 * language.
 */

/** The watched root when the user names nothing: their home directory. */
export function resolveWatchRoot(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string {
  const value = env.SQUID_WATCH_ROOT;
  if (value !== undefined && value.length > 0) return value;
  return platform === "win32" ? (env.USERPROFILE ?? homedir()) : homedir();
}

/**
 * The panel endpoint when the user names nothing.
 *
 * Deliberately *not* a second resolution path: whatever this returns is handed
 * to `resolvePanel` — the same function every explicit `SQUID_PANEL_SOCKET`
 * passes through. A default that bypassed that check would be a spelling the
 * TypeScript server accepts but the Rust panel never connects to, which is
 * exactly the two-ends-disagree failure the resolver exists to prevent.
 */
export function defaultPanelEndpoint(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return PANEL_PIPE_PREFIX + "squid-panel";
  // The runtime directory is the per-user scratch space a socket belongs in.
  // /tmp is the fallback when it is unset or relative — `resolvePanel` refuses
  // a relative path, so honoring a malformed XDG_RUNTIME_DIR here would only
  // move the failure from a sane default to a broken startup.
  const runtimeDir = env.XDG_RUNTIME_DIR;
  const base = runtimeDir !== undefined && isAbsolute(runtimeDir)
    ? runtimeDir
    : "/tmp";
  // The non-win32 branch judges paths by POSIX rules whatever host it runs on,
  // for the same reason `resolvePanel` does.
  return posix.join(base, "squid-panel.sock");
}

/**
 * Resolves the panel capability for a packaged run: the user's value when set,
 * otherwise the platform default — and the result, whichever half produced it,
 * is the same `resolvePanel` answer a CLI run gets.
 */
export function resolveAppPanel(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): PanelResolution {
  const explicit = env.SQUID_PANEL_SOCKET;
  const endpoint = explicit === undefined || explicit.length === 0
    ? defaultPanelEndpoint(env, platform)
    : explicit;
  return resolvePanel({ env: { SQUID_PANEL_SOCKET: endpoint }, platform });
}

/**
 * Where the panel binary should sit: next to the app binary, in the release
 * zip. The `.exe` follows the *target*, not the host — a Windows zip unpacked
 * on a non-Windows host still names its panel `squid-ui.exe`.
 */
export function panelExecutablePath(
  target: "windows" | "other",
  execPath: string = process.execPath,
): string {
  const name = target === "windows" ? "squid-ui.exe" : "squid-ui";
  return join(dirname(execPath), name);
}
