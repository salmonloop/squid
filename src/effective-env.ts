import { resolveConfigPath } from "./config-paths.js";
import { readConfigFile } from "./config-file.js";
import { configKeyById, configKeyByEnv } from "./config-schema.js";

/**
 * The one precedence decision: config file values, then environment.
 *
 * The resolvers read process env and nothing else, and they are not changing —
 * every one of them already has a tested contract about unset, empty, and
 * invalid. So the config file is not a second configuration language; it is a
 * way for those same variables to be *pre-filled*. `withConfigFile` takes the
 * file's strings, maps each through the schema to the env name its resolver
 * reads, and lays them under the caller's env, which wins per key.
 *
 * Per key, not per file: a shell that exports one variable still beats the
 * file for that one variable while every other setting still comes from the
 * file. Whole-file precedence would make one stray export silence the entire
 * settings form, which is not a rule anyone would design on purpose.
 *
 * The empty string is absent, not passed through: file `""` is written as
 * absence by `updateConfigFile` and honored here if a hand-edited file
 * contains it, so every resolver sees exactly what it sees when the setting
 * was never configured. Env `""` is different — it travels verbatim and keeps
 * whatever meaning its resolver already gives it, because the env layer's
 * semantics are its own tested contract, not ours to reinterpret.
 */
export function withConfigFile(
  env: Record<string, string | undefined>,
  fileValues: Readonly<Record<string, string>>,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...env };
  for (const [id, value] of Object.entries(fileValues)) {
    const key = configKeyById(id);
    if (key === undefined || value.length === 0) continue;
    if (env[key.env] !== undefined) continue;
    merged[key.env] = value;
  }
  return merged;
}

/**
 * The one step-0: resolve the file's location, read it, and merge it under the
 * given env. Both entries (`startDesktopWatch` and `prepareLaunch`) call this
 * before anything else so a config problem fails before any sink opens — the
 * same fail-fast spine `startWatchSession` runs one layer down, one link
 * further up.
 *
 * The resolved path rides along because `config_set` (a later phase) writes
 * back to the same file this call read; resolving it twice would be two
 * opinions about where "the config file" is.
 */
export type StepZeroEnvironment =
  | { readonly env: Record<string, string | undefined>; readonly configPath: string }
  | { readonly configError: string };

export function loadConfiguredEnvironment(
  env: Record<string, string | undefined>,
  options: { readonly platform?: NodeJS.Platform; readonly home?: string } = {},
): StepZeroEnvironment {
  const path = resolveConfigPath({ env, ...(options.platform === undefined ? {} : { platform: options.platform }), ...(options.home === undefined ? {} : { home: options.home }) });
  if ("configError" in path) return { configError: path.configError };

  const file = readConfigFile(path.path);
  if ("configError" in file) return file;

  return {
    env: withConfigFile(env, file.kind === "read" ? file.values : {}),
    configPath: path.path,
  };
}
