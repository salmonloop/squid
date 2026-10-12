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
 * What the dump does say is whether a credential can be *read*, as
 * `secretPresent` — deliberately weaker than whether one is stored, because an
 * unreadable store answers no.
 * That is the one fact the rule above accidentally hid: two very different
 * states — a key is stored, or none ever was — both render as an empty field,
 * so the only way to distinguish them was to save nothing and read the refusal.
 * A yes/no is not the secret, and it is derived from `hasReadableCredential`,
 * which is the only question this module asks about a stored key. Its absence
 * is therefore never evidence about what the user has done, and no surface
 * downstream may narrate it that way.
 *
 * Applies is per key, not global: file-backed settings are read once at
 * startup by the resolvers, so any write to them can only land after a
 * restart. A model setting saved while no agent is live can take effect
 * immediately — `watch-session` starts the agent from the same files on
 * recovery — but once an agent is running, Pi's session already holds the old
 * endpoint, and honesty wins: that set also says "restart".
 *
 * Display metadata rides along with every entry, `group` and `description`
 * beside `label`. It comes from `config-schema.ts` for the file-backed keys and
 * from `MODEL_CONFIG_KEYS` for the three that live in Pi's store, which is the
 * same split as everything else here — but the panel must not be able to tell,
 * because a form that grouped one store's rows and not the other's would be
 * confessing an implementation detail the user has no use for. So both halves
 * carry the same three display fields, and neither is optional: an entry cannot
 * reach the wire without having been placed under a capability and explained.
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
  /**
   * A credential for this row can be read — that it is reachable, never any part
   * of it. Only a `secret` kind carries this, and only when there is one to
   * report, so an absent flag reads as "nothing readable" without a second
   * spelling for it. Readable, not stored: `hasReadableCredential` answers no
   * for a store it cannot open or parse just as it does for one with no entry,
   * so this absence must never be rendered as "not set yet" — that tells a user
   * they never entered a key that may well be sitting there, in the one field
   * where acting on the belief overwrites something unrecoverable.
   *
   * It exists because the secret rule left one honest question unanswerable. A
   * secret's value is always the empty string here, so a stored key and no key
   * at all render identically, and the only way to tell them apart was to save
   * an empty field and read back either "kept" or a refusal —
   * a probe, in the one field where a mistaken save is least recoverable.
   * Reporting presence is not reporting the secret: nothing in this module
   * reads a stored key back, and this flag is derived from
   * `hasReadableCredential`, which answers only yes or no.
   */
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
    // Describes what the key is *for*, not what it is: this row's value is the
    // one thing the dump never carries, so the sentence beside an always-empty
    // field is all the user has to go on.
    description: "The secret that lets Squid use that model on your behalf.",
    kind: "secret",
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
  // Asked once for the whole dump rather than per row: it reads Pi's auth store,
  // and only the one secret row has any use for the answer.
  const readableCredential = hasReadableCredential(options.agentDir, options.provider);

  for (const key of MODEL_CONFIG_KEYS) {
    entries.push({
      id: key.id,
      label: key.label,
      group: key.group,
      description: key.description,
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
      // Keyed off the kind, not off the id: whichever row is the secret one is
      // the row that can say whether a credential is behind its empty field.
      // Whether one can be *read*, which is all `hasReadableCredential` knows:
      // absent is "nothing Squid can use", not "nothing was ever set", and the
      // form is required to keep those two apart.
      ...(key.kind === "secret" && readableCredential ? { secretPresent: true } : {}),
    });
  }

  for (const key of CONFIG_KEYS) {
    entries.push({
      id: key.id,
      label: key.label,
      // Copied from the table, not decided here: this module owns *where a
      // setting lives*, and how it is presented is the schema's business.
      group: key.group,
      description: key.description,
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
  if (isModelConfigKey(id)) return applyModelSet(options, id, value);
  return applyFileSet(options, id, value);
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
    // none can be read keeps the two cases ("nothing entered" and "nothing
    // here works") from being mistaken for each other. The refusal names what
    // Squid can do rather than what the user did: a store this process cannot
    // open must not be reported back as a key they never entered.
    if (trimmed.length === 0) {
      return hasReadableCredential(options.agentDir, options.provider)
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
  if (!hasReadableCredential(options.agentDir, options.provider)) {
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
