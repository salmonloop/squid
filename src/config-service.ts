import {
  configKeyById,
  CONFIG_KEYS,
  type ConfigGroup,
  type ConfigValueKind,
} from "./config-schema.js";
import { readConfigFile, updateConfigFile } from "./config-file.js";
import {
  DEFAULT_BASE_URL,
  hasReadableCredential,
  readModelEntry,
  readStoredCredentialKey,
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
 * Model configurations (provider, baseUrl, modelId, apiKey) support hot reload:
 * any change applies immediately ("now") and triggers in-session agent reload
 * without restarting the application.
 *
 * API keys and credentials are displayed directly in plaintext in the UI for
 * developer transparency and rapid iteration during MVP.
 */

/** The kinds a dump can name — the schema's three plus the secret case. */
export type ConfigSettingKind = ConfigValueKind | "secret";

export interface ConfigDumpEntry {
  readonly id: string;
  readonly label: string;
  /** The capability the form files this row under. Never decided in the panel. */
  readonly group: ConfigGroup;
  /** One sentence on what this changes for the user, shown beside the field. */
  readonly description: string;
  readonly kind: ConfigSettingKind;
  /** Empty string means unset — the form starts from empty, not from a guess. */
  readonly value: string;
  readonly applies: "now" | "restart";
  /** An env var is governing this run, so the file value is not the live one. */
  readonly overridden: boolean;
  readonly values?: readonly string[];
  /** A credential for this row can be read. */
  readonly secretPresent?: boolean;
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
  /**
   * Typed as the schema's own union rather than a loose string, so these three
   * cannot invent a tenth capability that the nineteen file-backed rows have no
   * way to join. The vocabulary is one vocabulary even though the table is two.
   */
  readonly group: ConfigGroup;
  readonly description: string;
  readonly kind: ConfigSettingKind;
}

/**
 * The three model settings, in dump order (first, so the panel's model section
 * reads top-down). They are deliberately not in CONFIG_KEYS: they validate by
 * their own rules and write to Pi's store, and a key that names the wrong
 * store in the shared table would be one subtle bug away from writing a
 * credential into the Squid config file.
 *
 * All three group under "Model" alongside `modelProvider`, which does live in
 * the shared table — the store a setting is written to is not a fact the form
 * organizes by. The user asks one question here ("what answers me, and with
 * what login"), and four rows answer it from two files.
 */
export const MODEL_CONFIG_KEYS: readonly ModelConfigKey[] = [
  {
    id: "modelBaseUrl",
    label: "Model API base URL",
    group: "Model",
    description: "Where Squid reaches the model it asks.",
    kind: "text",
  },
  {
    id: "modelId",
    label: "Model id",
    group: "Model",
    description: "Which model does the thinking.",
    kind: "text",
  },
  {
    id: "apiKey",
    label: "API key",
    group: "Model",
    description: "The secret that lets Squid use that model on your behalf.",
    kind: "text",
  },
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
  provider: string;
  /** What an unset entry defaults to when a write needs a full trio. */
  readonly defaultModelId: string;
  readonly defaultBaseUrl: string;
  /** Whether an agent currently holds the model configuration in memory. */
  readonly agentLive: () => boolean;
  readonly getProvider?: () => string;
  readonly setProvider?: (provider: string) => void;
}

/**
 * Everything the settings form starts from. Re-reads the config file on every
 * call — there is no cache to go stale when a set lands mid-run — and reads
 * the model entry from Pi's files.
 */
export function configDumpEntries(options: ConfigServiceOptions): ConfigDump {
  const file = readConfigFile(options.configPath ?? "");
  if ("configError" in file) {
    return { ok: false, error: file.configError };
  }
  const values = file.kind === "read" ? file.values : {};
  const activeProvider = options.getProvider ? options.getProvider() : options.provider;
  const entry = readModelEntry(options.agentDir, activeProvider);

  const entries: ConfigDumpEntry[] = [];
  const overriddenEnv = (name: string): boolean => options.env[name] !== undefined;
  const readableCredential = hasReadableCredential(options.agentDir, activeProvider);

  for (const key of MODEL_CONFIG_KEYS) {
    entries.push({
      id: key.id,
      label: key.label,
      group: key.group,
      description: key.description,
      kind: key.kind,
      value: key.id === "apiKey"
        ? readStoredCredentialKey(options.agentDir, activeProvider) ?? ""
        : key.id === "modelBaseUrl"
          ? entry?.baseUrl ?? ""
          : entry?.modelId ?? "",
      applies: "now",
      overridden: key.id === "modelId" ? overriddenEnv("PI_MODEL_ID") : false,
      ...(readableCredential ? { secretPresent: true } : {}),
    });
  }

  for (const key of CONFIG_KEYS) {
    entries.push({
      id: key.id,
      label: key.label,
      group: key.group,
      description: key.description,
      kind: key.kind,
      value: values[key.id] ?? "",
      applies: key.id === "modelProvider" ? "now" : "restart",
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
  if (isModelConfigKey(id)) return applyModelSet(options, id, value);
  const fileResult = applyFileSet(options, id, value);
  if (fileResult.ok && id === "modelProvider") {
    if (options.setProvider) {
      options.setProvider(value);
    } else {
      options.provider = value;
    }
    return { ok: true, applies: "now" };
  }
  return fileResult;
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
  // Model provider hot reloads; other file-backed settings apply on restart.
  return { ok: true, applies: id === "modelProvider" ? "now" : "restart" };
}

function applyModelSet(
  options: ConfigServiceOptions,
  id: string,
  value: string,
): ConfigSetResult {
  const key = MODEL_CONFIG_KEYS.find((entry) => entry.id === id)!;
  const trimmed = value.trim();
  const activeProvider = options.getProvider ? options.getProvider() : options.provider;

  if (id === "apiKey") {
    if (trimmed.length === 0) {
      return hasReadableCredential(options.agentDir, activeProvider)
        ? { ok: true, applies: "now" }
        : { ok: false, error: "No API key is stored yet; enter one to save." };
    }
    const entry = readModelEntry(options.agentDir, activeProvider);
    writeModelConfiguration(options.agentDir, activeProvider, {
      baseUrl: entry?.baseUrl ?? options.defaultBaseUrl,
      modelId: entry?.modelId ?? options.defaultModelId,
      apiKey: trimmed,
    });
    return { ok: true, applies: "now" };
  }

  if (trimmed.length === 0) {
    return { ok: false, error: `${key.label} cannot be empty.` };
  }
  // An endpoint is worthless without the credential half beside it, and this
  // layer has no way to prompt for one — so the gate is here, before the
  // write, where the refusal can name what is missing.
  if (!hasReadableCredential(options.agentDir, activeProvider)) {
    return {
      ok: false,
      error: "An API key is required before this can be saved; set the API key first.",
    };
  }
  const entry = readModelEntry(options.agentDir, activeProvider);
  writeModelEndpoint(options.agentDir, activeProvider, {
    baseUrl: id === "modelBaseUrl" ? trimmed : entry?.baseUrl ?? options.defaultBaseUrl,
    modelId: id === "modelId" ? trimmed : entry?.modelId ?? options.defaultModelId,
  });
  return { ok: true, applies: "now" };
}

/** The default base URL, re-exported for callers composing options. */
export { DEFAULT_BASE_URL };
