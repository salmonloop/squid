import { homedir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";

/**
 * Where the config file lives, per platform.
 *
 * One file, one default per platform, the same answer every desktop app's
 * user would look for it in: `~/Library/Application Support` on darwin, the
 * XDG config dir on Linux, `%APPDATA%` on Windows. `SQUID_CONFIG` overrides
 * the whole thing — not a directory to join into, but the file itself, so a
 * test or an unusual layout can point at an exact path without leaving
 * stray directories behind.
 *
 * The override is judged by the host dialect of the platform it is *declared*
 * for, the same rule `defaultPanelEndpoint` uses: a Windows value is absolute
 * by Windows rules, everything else by POSIX rules. A relative override is
 * refused rather than resolved against the current directory, because a
 * config file whose location depends on where you launched from is a config
 * file that moves when you double-click.
 */

export type ConfigPathResolution =
  | { readonly path: string }
  | { readonly configError: string };

export interface ResolveConfigPathOptions {
  readonly env?: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
}

export function resolveConfigPath(
  options: ResolveConfigPathOptions = {},
): ConfigPathResolution {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();

  const override = env.SQUID_CONFIG;
  if (override !== undefined && override.length > 0) {
    return isAbsoluteFor(platform, override)
      ? { path: override }
      : { configError: "SQUID_CONFIG must be an absolute path." };
  }

  return { path: defaultConfigPath(env, platform, home) };
}

function isAbsoluteFor(platform: NodeJS.Platform, value: string): boolean {
  return platform === "win32" ? win32.isAbsolute(value) : posix.isAbsolute(value);
}

function defaultConfigPath(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  home: string,
): string {
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "Squid", "config.json");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Squid", "config.json");
  }
  // The XDG default is the only one of the three a portable environment
  // variable moves, so it is honored — but only when absolute, for the same
  // reason the override above is.
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && posix.isAbsolute(xdg) ? xdg : join(home, ".config");
  return posix.join(base, "squid", "config.json");
}
