import {
  configKeyById,
  CONFIG_KEYS,
  type ConfigValueKind,
} from "./config-schema.js";
import { readConfigFile, updateConfigFile } from "./config-file.js";
import {
  DEFAULT_BASE_URL,
  hasStoredCredential,
  readModelEntry,
  writeModelConfiguration,
  writeModelEndpoint,
} from "./app-model.js";

/**
 * The semantics between the panel and the stores.
 *
 * The panel sends `{id, value}` and draws whatever a dump tells it; every
 * decision about *what a setting is and where it lives* lives here. Two stores
 * answer to it, and the split is not ours to blur: the fifteen file-backed
 * settings go to the Squid config file, and the three model settings go to
 * Pi's own `models.json`/`auth.json` — never a Squid-side parallel copy, per
 * the contract in `app-model.ts`.
 *
 * The secret rule is structural, not a convention to remember: `apiKey`'s
 * *value* never leaves this module's callers' sight — the dump reports it as
 * the empty string, and a set with an empty value means "keep the stored
 * credential". Nothing here ever reads the key back to restate it, which is
 * why an endpoint edit goes through `writeModelEndpoint` (models.json only):
 * the credential half is simply not touched.
 *
 * Applies is per key, not global: file-backed settings are read once at
 * startup by the resolvers, so any write to them can only land after a
 * restart. A model setting saved while no agent is live can take effect
 * immediately — `watch-session` starts the agent from the same files on
 * recovery — but once an agent is running, Pi's session already holds the old
 * endpoint, and honesty wins: that set also says "restart".
 */

/** The kinds a dump can name — the schema's three plus the secret case. */
export type ConfigSettingKind = ConfigValueKind | "secret";

export interface ConfigDumpEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: ConfigSettingKind;
  /** Empty string means unset — the form starts from empty, not from a guess. */
  readonly value: string;
  readonly applies: "now" | "restart";
  /** An env var is governing this run, so the file value is not the live one. */
  readonly overridden: boolean;
  readonly values?: readonly string[];
}

export type ConfigDump =
  | { readonly ok: true; readonly entries: readonly ConfigDumpEntry[] }
  | { readonly ok: false; readonly error: string };

export type ConfigSetResult =
  | { readonly ok: true; readonly applies: "now" | "restart" }
  | { readonly ok: false; readonly error: string };

export interface ModelConfigKey {
  readonly id: string;
  readonly label: string;
  readonly kind: ConfigSettingKind;
}

/**
 * The three model settings, in dump order (first, so the panel's model section
 * reads top-down). They are deliberately not in CONFIG_KEYS: they validate by
 * their own rules and write to Pi's store, and a key that names the wrong
 * store in the shared table would be one subtle bug away from writing a
 * credential into the Squid config file.
 */
export const MODEL_CONFIG_KEYS: readonly ModelConfigKey[] = [
  { id: "modelBaseUrl", label: "Model API base URL", kind: "text" },
  { id: "modelId", label: "Model id", kind: "text" },
  { id: "apiKey", label: "API key", kind: "secret" },
];

export function isModelConfigKey(id: string): boolean {
  return MODEL_CONFIG_KEYS.some((key) => key.id === id);
}

export interface ConfigServiceOptions {
  /** Where the Squid config file lives; undefined disables file-backed sets. */
  readonly configPath: string | undefined;
  /** The run's environment, for overridden flags — read, never written. */
  readonly env: Record<string, string | undefined>;
  readonly agentDir: string;
  readonly provider: string;
  /** What an unset entry defaults to when a write needs a full trio. */
  readonly defaultModelId: string;
  readonly defaultBaseUrl: string;
  /** Whether an agent currently holds the model configuration in memory. */
  readonly agentLive: () => boolean;
}

/**
 * Everything the settings form starts from. Re-reads the config file on every
 * call — there is no cache to go stale when a set lands mid-run — and reads
 * the model entry from Pi's files. A value an env var is overriding is still
 * the file value here, because the form edits the file; the `overridden` flag
 * is the disclosure that the live run disagrees.
 */
export function configDumpEntries(options: ConfigServiceOptions): ConfigDump {
  const file = readConfigFile(options.configPath ?? "");
  if ("configError" in file) {
    return { ok: false, error: file.configError };
  }
  const values = file.kind === "read" ? file.values : {};
  const entry = readModelEntry(options.agentDir, options.provider);

  const entries: ConfigDumpEntry[] = [];
  const overriddenEnv = (name: string): boolean => options.env[name] !== undefined;
  const applies = (): "now" | "restart" => (options.agentLive() ? "restart" : "now");

  for (const key of MODEL_CONFIG_KEYS) {
    entries.push({
      id: key.id,
      label: key.label,
      kind: key.kind,
      // The secret's value is structurally absent from every dump: empty is
      // "nothing to show", which is also exactly what "keep what is stored"
      // means on the way back in.
      value: key.kind === "secret"
        ? ""
        : key.id === "modelBaseUrl"
          ? entry?.baseUrl ?? ""
          : entry?.modelId ?? "",
      applies: applies(),
      overridden: key.id === "modelId" ? overriddenEnv("PI_MODEL_ID") : false,
    });
  }

  for (const key of CONFIG_KEYS) {
    entries.push({
      id: key.id,
      label: key.label,
      kind: key.kind,
      value: values[key.id] ?? "",
      applies: "restart",
      overridden: overriddenEnv(key.env),
      ...(key.values === undefined ? {} : { values: key.values }),
    });
  }

  return { ok: true, entries };
}

/**
 * One set, one decision. The panel never batches; a form with five edits sends
 * five messages and sees five results, which keeps every refusal attributable
 * to exactly the field the user was editing.
 */
export function applyConfigSet(
  options: ConfigServiceOptions,
  id: string,
  value: string,
): ConfigSetResult {
  return isModelConfigKey(id)
    ? applyModelSet(options, id, value)
    : applyFileSet(options, id, value);
}

function applyFileSet(
  options: ConfigServiceOptions,
  id: string,
  value: string,
): ConfigSetResult {
  if (options.configPath === undefined) {
    return { ok: false, error: "No configuration file is available for this session." };
  }
  const key = configKeyById(id);
  if (key === undefined) {
    return { ok: false, error: `Unknown setting "${id}".` };
  }
  const written = updateConfigFile(options.configPath, { [id]: value });
  if ("configError" in written) {
    return { ok: false, error: written.configError };
  }
  // Every file-backed value is read once at startup, so a write can only take
  // effect when the process that reads it is next started.
  return { ok: true, applies: "restart" };
}

function applyModelSet(
  options: ConfigServiceOptions,
  id: string,
  value: string,
): ConfigSetResult {
  const key = MODEL_CONFIG_KEYS.find((entry) => entry.id === id)!;
  const trimmed = value.trim();

  if (key.kind === "secret") {
    // Empty means "keep the stored credential" — the only meaning an empty
    // field can carry when the value is never displayed back. Refusing when
    // there is none stored keeps the two cases ("nothing entered" and "no
    // key exists") from being mistaken for each other.
    if (trimmed.length === 0) {
      return hasStoredCredential(options.agentDir, options.provider)
        ? { ok: true, applies: appliesForModel(options) }
        : { ok: false, error: "No API key is stored yet; enter one to save." };
    }
    const entry = readModelEntry(options.agentDir, options.provider);
    writeModelConfiguration(options.agentDir, options.provider, {
      baseUrl: entry?.baseUrl ?? options.defaultBaseUrl,
      modelId: entry?.modelId ?? options.defaultModelId,
      apiKey: trimmed,
    });
    return { ok: true, applies: appliesForModel(options) };
  }

  if (trimmed.length === 0) {
    return { ok: false, error: `${key.label} cannot be empty.` };
  }
  // An endpoint is worthless without the credential half beside it, and this
  // layer has no way to prompt for one — so the gate is here, before the
  // write, where the refusal can name what is missing.
  if (!hasStoredCredential(options.agentDir, options.provider)) {
    return {
      ok: false,
      error: "An API key is required before this can be saved; set the API key first.",
    };
  }
  const entry = readModelEntry(options.agentDir, options.provider);
  writeModelEndpoint(options.agentDir, options.provider, {
    baseUrl: id === "modelBaseUrl" ? trimmed : entry?.baseUrl ?? options.defaultBaseUrl,
    modelId: id === "modelId" ? trimmed : entry?.modelId ?? options.defaultModelId,
  });
  return { ok: true, applies: appliesForModel(options) };
}

function appliesForModel(options: ConfigServiceOptions): "now" | "restart" {
  // A live agent already holds the old endpoint in memory; only an agent not
  // yet started can pick the new files up in-session (needs_config recovery).
  return options.agentLive() ? "restart" : "now";
}

/** The default base URL, re-exported for callers composing options. */
export { DEFAULT_BASE_URL };
