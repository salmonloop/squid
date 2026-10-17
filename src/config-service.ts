import {
  DEFAULT_BASE_URL,
  hasReadableCredential,
  readModelEntry,
  readStoredCredentialKey,
  writeModelConfiguration,
  writeModelEndpoint,
} from "./app-model.js";
import { readConfigFile, updateConfigFile } from "./config-file.js";
import { CONFIG_KEYS } from "./config-schema.js";

/**
 * The settings service the control panel talks to.
 *
 * Sits over the two persistent configuration stores — the Squid config file and
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
export type ConfigKind = "text" | "int" | "enum" | "secret";

export interface ConfigDumpEntry {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly description: string;
  readonly kind: ConfigKind;
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
  readonly id: "modelBaseUrl" | "modelId" | "apiKey";
  readonly label: string;
  readonly group: string;
  readonly description: string;
  readonly kind: ConfigKind;
}

/**
 * Standard endpoints and models for well-known providers to streamline setup
 * without clearing fields to blank.
 */
export const KNOWN_PROVIDER_DEFAULTS: Record<string, { baseUrl: string; modelId: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", modelId: "gpt-4o" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", modelId: "openai/gpt-4o" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", modelId: "claude-3-5-sonnet-20241022" },
  ollama: { baseUrl: "http://localhost:11434/v1", modelId: "llama3.1" },
  bifrost: { baseUrl: "http://127.0.0.1:8000/v1", modelId: "deepseek-v4-flash" },
};

/**
 * The three keys that belong to the model connection. They do not appear in
 * `config-schema.ts` because they live in Pi's stores, but they render in the
 * same form, grouped under "Model" alongside `modelProvider`.
 */
export const MODEL_CONFIG_KEYS: readonly ModelConfigKey[] = [
  {
    id: "modelBaseUrl",
    label: "Base URL",
    group: "Model",
    description: "The HTTP endpoint Squid talks to (e.g. https://api.openai.com/v1, https://api.deepseek.com/v1, http://localhost:11434/v1).",
    kind: "text",
  },
  {
    id: "modelId",
    label: "Model ID",
    group: "Model",
    description: "The model Squid asks for (e.g. gpt-4o, deepseek-chat, claude-3-5-sonnet, llama3.1).",
    kind: "text",
  },
  {
    id: "apiKey",
    label: "API key",
    group: "Model",
    description: "The API key for authentication (e.g. sk-..., or leave blank for local models). Displayed in plaintext.",
    kind: "text",
  },
];

export function isModelConfigKey(id: string): id is ModelConfigKey["id"] {
  return MODEL_CONFIG_KEYS.some((key) => key.id === id);
}

export interface ConfigServiceOptions {
  readonly configPath?: string | undefined;
  /** The run's environment, for overridden flags — read, never written. */
  readonly env: Record<string, string | undefined>;
  readonly agentDir: string;
  provider: string;
  /** What an unset entry defaults to when a write needs a full trio. */
  readonly defaultModelId: string;
  readonly defaultBaseUrl: string;
  /** Whether an agent currently holds the model configuration in memory. */
  readonly agentLive: () => boolean;
  readonly getProvider?: (() => string) | undefined;
  readonly setProvider?: ((provider: string) => void) | undefined;
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
 * Modifies one configuration setting and persists it.
 */
export function applyConfigSet(
  options: ConfigServiceOptions,
  id: string,
  value: string,
): ConfigSetResult {
  if (isModelConfigKey(id)) return applyModelSet(options, id, value);
  const fileResult = applyFileSet(options, id, value);
  if (fileResult.ok && id === "modelProvider") {
    const trimmed = value.trim();
    if (options.setProvider) {
      options.setProvider(trimmed);
    } else {
      options.provider = trimmed;
    }
    // Seed new provider with known defaults if it has no models.json entry yet
    const existing = readModelEntry(options.agentDir, trimmed);
    if (!existing) {
      const known = KNOWN_PROVIDER_DEFAULTS[trimmed.toLowerCase()];
      if (known) {
        writeModelEndpoint(options.agentDir, trimmed, {
          baseUrl: known.baseUrl,
          modelId: known.modelId,
        });
      }
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
  const key = CONFIG_KEYS.find((entry) => entry.id === id);
  if (key === undefined) {
    return { ok: false, error: `Unknown setting "${id}".` };
  }
  const checked = key.validate(value);
  if (!checked.ok) return checked;
  const written = updateConfigFile(options.configPath ?? "", { [id]: value });
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

  // Developer efficiency first: endpoint fields can be saved freely without
  // artificially demanding an existing API key first.
  const entry = readModelEntry(options.agentDir, activeProvider);
  writeModelEndpoint(options.agentDir, activeProvider, {
    baseUrl: id === "modelBaseUrl" ? trimmed : entry?.baseUrl ?? options.defaultBaseUrl,
    modelId: id === "modelId" ? trimmed : entry?.modelId ?? options.defaultModelId,
  });
  return { ok: true, applies: "now" };
}

/** The default base URL, re-exported for callers composing options. */
export { DEFAULT_BASE_URL };
