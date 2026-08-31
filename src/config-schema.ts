/**
 * The one table of file-backed configurable settings.
 *
 * Every setting the Squid config file may hold is a row here, and nothing else
 * names a setting: the file reader validates through `validate`, and the wire
 * `config` message (a later phase) carries `label`/`kind` to the panel so the
 * Rust side never hardcodes a key. A key that exists in a resolver but not
 * here is a key the panel cannot offer — that asymmetry is the check that
 * catches a new SQUID_* variable added without deciding whether a user may
 * configure it.
 *
 * Everything is a string at the storage layer; typing lives in `validate`.
 * That is what keeps a value crossing to the panel as one string (never an
 * inferred number) and what keeps the file diffable against the wire: the file
 * holds exactly the strings a settings form submits.
 *
 * Two layers, two jobs. This table validates *syntax* — digits, enum
 * membership, no empty list entries — because that is shape, knowable without
 * a host. The resolvers keep validating *semantics* — absoluteness, platform
 * availability — exactly as they do for env vars today, with their own
 * messages. Nothing here duplicates a resolver's decision.
 *
 * The empty string is not a value: for every key, `""` means *unset*, and
 * `effective-env` implements that by omitting the variable entirely rather
 * than passing it through. That is why there is no per-key `emptyMeans` here —
 * unset already means the right thing everywhere, because each resolver's
 * undefined case (home default, capture off, no exclusions, default timeout)
 * is exactly what an empty settings field should mean. An env var set to `""`
 * is a different thing and stays the resolver's business: it travels verbatim,
 * so a shell-exported empty `SQUID_RETENTION_HOURS` still fails the way it
 * always has. The env layer keeps its `""` semantics; the file layer never
 * has any.
 *
 * Deliberately absent: the interop endpoints (`SQUID_PANEL_SOCKET`,
 * `SQUID_CONTROL_FIFO`, `SQUID_TERMINAL_FIFO`, `SQUID_EDITOR_FIFO`) and the
 * shell-side `SQUID_LAST_COMMAND`. The endpoints name where *this* process
 * talks to others — one half of a pair whose other half must agree — and a
 * settings form is the wrong place to hand-edit a socket path; they stay
 * env-only, which also keeps a config file from being able to point a running
 * session's panel at an arbitrary path. Model credentials are absent because
 * they are Pi's own store (`models.json`/`auth.json`), never a Squid-side
 * parallel copy — `app-model.ts` owns that contract.
 */

/** The value shapes a setting can take, as the panel renders them. */
export type ConfigValueKind = "text" | "int" | "enum";

export type ConfigValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export interface ConfigKey {
  /** File key, camelCase so it reads as one word in the JSON. */
  readonly id: string;
  /** The environment variable a resolver already reads. Never a new name. */
  readonly env: string;
  /** What the panel shows. Carried on the wire, never re-typed in Rust. */
  readonly label: string;
  readonly kind: ConfigValueKind;
  /** The allowed spellings, for `kind: "enum"`. */
  readonly values?: readonly string[];
  /**
   * A key's own extra rule, run after the kind check. Only keys that need one
   * carry it — the table stays declarative instead of the shared validator
   * growing a per-id special case.
   */
  readonly refine?: (raw: string) => ConfigValidation;
  validate(raw: string): ConfigValidation;
}

/** Strict digits, no `Number()`: the latter accepts "1e3" and " 24". */
function validateInt(label: string, raw: string): ConfigValidation {
  const error = `${label} must be a positive integer.`;
  if (!/^\d+$/.test(raw)) return { ok: false, error };
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return { ok: false, error };
  return { ok: true };
}

function validateEnum(raw: string, values: readonly string[]): ConfigValidation {
  if (values.includes(raw)) return { ok: true };
  return { ok: false, error: `must be one of: ${values.join(", ")}.` };
}

/**
 * Text accepts anything but untrimmed values: a pasted newline is a different
 * directory. Never called with `""` — unset is decided before validation.
 */
function validateText(raw: string): ConfigValidation {
  return raw.trim() !== raw
    ? { ok: false, error: "Value has leading or trailing whitespace." }
    : { ok: true };
}

function validatorFor(key: Omit<ConfigKey, "validate">): ConfigKey["validate"] {
  return (raw: string): ConfigValidation => {
    // Unset, not a value: the caller omits the variable, so there is nothing
    // for the kind check to see.
    if (raw.length === 0) return { ok: true };
    if (key.kind === "int") return validateInt(key.label, raw);
    if (key.kind === "enum") return validateEnum(raw, key.values ?? []);
    return key.refine ? key.refine(raw) : validateText(raw);
  };
}

const CONFIG_KEY_TABLE: readonly Omit<ConfigKey, "validate">[] = [
  { id: "watchRoot", env: "SQUID_WATCH_ROOT", label: "Watch root", kind: "text" },
  { id: "databasePath", env: "SQUID_DB", label: "Database path", kind: "text" },
  { id: "retentionHours", env: "SQUID_RETENTION_HOURS", label: "Retention (hours)", kind: "int" },
  { id: "agentTurnTimeoutMs", env: "SQUID_AGENT_TURN_TIMEOUT_MS", label: "Agent turn timeout (ms)", kind: "int" },
  { id: "captureGate", env: "SQUID_CONTROL", label: "Capture gate", kind: "enum", values: ["fifo"] },
  { id: "screenReader", env: "SQUID_SCREEN_READER", label: "Screen reader", kind: "enum", values: ["synthetic", "darwin", "linux", "windows"] },
  { id: "screenPollMs", env: "SQUID_SCREEN_POLL_MS", label: "Screen poll (ms)", kind: "int" },
  { id: "browser", env: "SQUID_BROWSER", label: "Browser pages", kind: "enum", values: ["synthetic", "darwin"] },
  { id: "browserPollMs", env: "SQUID_BROWSER_POLL_MS", label: "Browser poll (ms)", kind: "int" },
  { id: "terminal", env: "SQUID_TERMINAL", label: "Terminal commands", kind: "enum", values: ["fifo"] },
  { id: "terminalPollMs", env: "SQUID_TERMINAL_POLL_MS", label: "Terminal poll (ms)", kind: "int" },
  { id: "editorSaves", env: "SQUID_EDITOR_SAVES", label: "Editor saves", kind: "enum", values: ["fifo"] },
  { id: "editorPollMs", env: "SQUID_EDITOR_POLL_MS", label: "Editor poll (ms)", kind: "int" },
  { id: "capturePollMs", env: "SQUID_CONTROL_POLL_MS", label: "Gate poll (ms)", kind: "int" },
  {
    id: "excludeApplications",
    env: "SQUID_EXCLUDE",
    label: "Excluded applications",
    kind: "text",
    // An empty entry is the one typo that changes what gets captured, so it is
    // refused here as it is in `parseExclusionList` — same rule, stated once in
    // each layer's own terms.
    refine: (raw) =>
      raw.split(",").some((entry) => entry.trim().length === 0)
        ? { ok: false, error: "Excluded applications contains an empty entry." }
        : { ok: true },
  },
];

/** Every file-backed setting, in the order the panel lists them. */
export const CONFIG_KEYS: readonly ConfigKey[] = CONFIG_KEY_TABLE.map((key) => ({
  ...key,
  validate: validatorFor(key),
}));

export function configKeyById(id: string): ConfigKey | undefined {
  return CONFIG_KEYS.find((key) => key.id === id);
}

export function configKeyByEnv(env: string): ConfigKey | undefined {
  return CONFIG_KEYS.find((key) => key.env === env);
}
