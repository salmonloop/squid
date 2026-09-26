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
 * `group` and `description` are display metadata, and they live here for the
 * same reason `label` does: the panel renders what the wire hands it, so a
 * grouping decided in Rust would be a second schema — one that disagrees with
 * this one the first time a setting moves, with nothing to catch it. They are
 * metadata and not *structure*: `group` is a scalar on a flat line, never a
 * nesting, because the panel's parser is flat by design and a tree on the wire
 * would buy nothing that bucketing by value does not already do.
 *
 * A group names the capability or the question a setting belongs to, in the
 * user's terms — "Screen", "Pause control" — never the subsystem that happens
 * to implement it. Rows of one group are deliberately *not* contiguous in table
 * order: the capture gate's poll interval sits at the end beside the other
 * intervals it was added with, and reordering the table would silently reorder
 * the form. So the panel buckets by value rather than assuming runs, and this
 * table stays free to grow in the order settings were introduced.
 *
 * A description says what a setting changes about what the user gets. Not what
 * its name already says: "How long Squid keeps what it recorded before deleting
 * it" earns its line, while "the retention hours" is the label again with more
 * words, and a row nobody can describe except by its own name is a row whose
 * purpose was never decided.
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
 * Deliberately absent: `SQUID_PANEL_SOCKET` and the shell-side
 * `SQUID_LAST_COMMAND`. The panel socket names where *this* process talks to
 * the panel — one half of a pair whose other half must agree — and it stays
 * env-only so a config file cannot point a running session's panel at an
 * arbitrary path. Model *credentials* are absent because they are Pi's own
 * store (`models.json`/`auth.json`), never a Squid-side parallel copy —
 * `app-model.ts` owns that contract.
 *
 * `modelProvider` is the one row here that is not a `SQUID_*` variable, and the
 * distinction it rests on is worth stating: it is the *key* Squid looks Pi's
 * two files up under, not any of their content. Storing a key name is not
 * keeping a parallel copy of what it addresses. It belongs in the file rather
 * than beside the other three model settings because those write *into* Pi's
 * store while this decides which entry they write to — a choice that has to be
 * readable before the settings service is constructed, which is exactly what
 * the file layer is for. Without it, a run supervised by the panel was pinned
 * to whatever `PI_MODEL_PROVIDER` defaults to, because the supervisor clears
 * the environment it spawns the brain with; two logins against one endpoint
 * were unreachable.
 *
 * The three source FIFO paths are *present*, and that is a correction rather
 * than a preference. `captureGate`, `terminal`, and `editorSaves` each offer
 * exactly one legal value, and each of those values is refused at startup
 * unless its companion path is set. While the paths were env-only, the panel
 * offered three settings whose only selectable value guaranteed a `configError`
 * and exit 2 — and because the settings form renders what a *live* brain dumps,
 * a brain that refused to start left no form to undo the choice in. Offering a
 * value the same form cannot satisfy is the defect; a path that names a FIFO
 * this process reads is ordinary configuration, unlike the socket it serves.
 */

import { parsePipeEndpoint } from "./endpoint-transport.js";

/** The value shapes a setting can take, as the panel renders them. */
export type ConfigValueKind = "text" | "int" | "enum";

/**
 * The capabilities a setting can belong to — the panel's whole grouping
 * vocabulary, closed rather than a free string so a new setting has to name an
 * existing capability or argue for a new one in a diff.
 *
 * "Advanced" is absent, and its absence is the point: it is not a capability,
 * it is what a settings screen files a row under when nobody wanted to explain
 * it, and every row here has to be explainable in one sentence to earn its
 * `description` anyway. Making it unspellable turns that from a review comment
 * into a type error.
 *
 * Listed in the order the form is expected to read, which is also first
 * appearance in a dump (the model rows lead it): what answers, how it reaches
 * you, where it looks, what it keeps, what it never touches. That ordering rides
 * no wire field — the panel can recover it from the dump — so this list stays
 * advice about presentation rather than a second protocol.
 */
export type ConfigGroup =
  /** Which model answers, under which login, and how long it may take. */
  | "Model"
  /** Deciding what the agent needs to see. */
  | "Decision curation"
  /** Whether Squid can reach you with the panel closed. */
  | "Notifications"
  /** Which part of the filesystem is watched. */
  | "Files"
  /** Reading the words on screen. */
  | "Screen"
  /** Seeing which pages are open. */
  | "Browser"
  /** Learning which commands ran. */
  | "Terminal"
  /** Learning which files were saved. */
  | "Editor saves"
  /** Stopping and starting capture. */
  | "Pause control"
  /** What is kept, where, and for how long. */
  | "History"
  /** What is never recorded at all. */
  | "Privacy";

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
  /**
   * The capability that owns this setting, in the user's words. The panel
   * buckets rows by this string; see the module comment for why it is a scalar
   * and why the vocabulary has no "Advanced" in it.
   */
  readonly group: ConfigGroup;
  /**
   * One plain sentence on what this changes for the user, shown beside the
   * field. Required, not optional: a setting offered without one is a setting
   * the panel asks a user to decide about with nothing to decide on.
   */
  readonly description: string;
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
  return raw.trim() === raw
    ? { ok: true }
    : { ok: false, error: "Value has leading or trailing whitespace." };
}

/**
 * A source endpoint must be absolute — POSIX-absolute or the Windows named-pipe
 * spelling — and the settings form is where saying so is useful: the resolver
 * refuses a relative path at startup, which for a supervised brain means exit 2
 * and no form left to fix it in. Same rule as each resolver's own check, stated
 * here in the layer that can still refuse the value while a brain is running.
 *
 * `isAbsolute` is deliberately not imported: this validator runs in the brain
 * and in the panel's dump alike, and the pipe spelling is judged by the same
 * parser the panel endpoint uses rather than by the host, because the config
 * file is written in one dialect on every platform — a Windows host must not
 * accept `C:\\fifo` here when the resolvers refuse it there. A pipe spelling
 * is accepted *because the resolvers now read it* (see
 * `endpoint-transport.ts`): refusing it here would offer a legal enum value
 * the same form could not satisfy, the exact trap the enum/path pairing test
 * exists to prevent.
 */
function validateFifoPath(label: string, raw: string): ConfigValidation {
  const whitespace = validateText(raw);
  if (!whitespace.ok) return whitespace;
  return raw.startsWith("/") || parsePipeEndpoint(raw) !== undefined
    ? { ok: true }
    : { ok: false, error: `${label} must be an absolute path or a named pipe (\\\\.\\pipe\\<name>).` };
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
  {
    id: "modelProvider",
    env: "PI_MODEL_PROVIDER",
    label: "Model provider",
    group: "Model",
    description: "Which of your saved model logins this Squid answers with.",
    kind: "text",
    // Pi keys `models.json` and `auth.json` by this string, so it has to be
    // usable as an object key and recognizable in a file a user may open. A
    // path separator or a dot would still work as a key while reading as a
    // path or a nested field to anyone looking at the JSON.
    refine: (raw) =>
      /^[A-Za-z0-9_-]+$/.test(raw)
        ? { ok: true }
        : { ok: false, error: "Model provider must be letters, digits, dashes, or underscores." },
  },
  {
    id: "decisionCuration",
    env: "SQUID_DECISION_CURATOR",
    label: "Decision curation",
    group: "Decision curation",
    // Default on, per the repo's "ships in the state most people want" rule:
    // unset means the curator runs, and with no reachable decision endpoint it
    // fails open to a no-op — harmless. `off` is the explicit decline, offered
    // as a value so turning it off is a choice the form can show.
    description:
      "Whether a fast decision model trims what the agent reads before each thought. Left empty, it does when a decision endpoint is reachable.",
    kind: "enum",
    values: ["on", "off"],
  },
  {
    id: "decisionCuratorBaseUrl",
    env: "SQUID_DECISION_BASE_URL",
    label: "Decision model endpoint",
    group: "Decision curation",
    // The Jev-shaped endpoint. The paid hosted Jev is the default when unset;
    // point it at a free self-hosted OpenJev/Kev (e.g. http://127.0.0.1:8009)
    // to run at no cost. Any /v1/systemone server works.
    description: "Where Squid reaches the decision model. A local replica costs nothing to run.",
    kind: "text",
  },
  {
    id: "decisionCuratorModel",
    env: "SQUID_DECISION_MODEL",
    label: "Decision model id",
    group: "Decision curation",
    description: "Which decision model does the trimming (for example jev-latest, openjev, or kev-4b).",
    kind: "text",
  },
  {
    id: "decisionCuratorThreshold",
    env: "SQUID_DECISION_THRESHOLD",
    label: "Decision keep threshold",
    group: "Decision curation",
    // How sure the model must be that a piece of context matters before it is
    // kept. Higher trims more aggressively. A float in [0,1]; refined here
    // because the schema has no float kind and a bad value would silently
    // sit in the file until the extension defaulted around it.
    description: "How sure the model must be a detail matters before keeping it, from 0 to 1. Higher trims more.",
    kind: "text",
    refine: (raw) => {
      const n = Number(raw);
      return /^\d*\.?\d+$/.test(raw) && Number.isFinite(n) && n >= 0 && n <= 1
        ? { ok: true }
        : { ok: false, error: "Decision keep threshold must be a number from 0 to 1." };
    },
  },
  {
    id: "notify",
    env: "SQUID_NOTIFY",
    label: "Desktop notices",
    group: "Notifications",
    // Unset means on: speaking up is the default wherever the host has a
    // backend, and `off` is the explicit way to decline it — offered as a value
    // so turning the feature off is a choice the form can show, not an empty
    // box a person has to know means anything.
    description:
      "Whether Squid interrupts you on the desktop when a reply lands. Left empty, it does wherever your system can show a notice.",
    kind: "enum",
    values: ["off", "desktop"],
  },
  {
    id: "watchRoot",
    env: "SQUID_WATCH_ROOT",
    label: "Watch root",
    group: "Files",
    description: "The folder whose file activity Squid pays attention to.",
    kind: "text",
  },
  {
    id: "databasePath",
    env: "SQUID_DB",
    label: "Database path",
    group: "History",
    description: "Where on disk Squid keeps the record of what it saw.",
    kind: "text",
  },
  {
    id: "retentionHours",
    env: "SQUID_RETENTION_HOURS",
    label: "Retention (hours)",
    group: "History",
    description: "How long Squid keeps what it recorded before deleting it.",
    kind: "int",
  },
  {
    id: "agentTurnTimeoutMs",
    env: "SQUID_AGENT_TURN_TIMEOUT_MS",
    label: "Agent turn timeout (ms)",
    // Grouped with the model, not filed away as a tuning knob: how long you
    // wait for an answer is a fact about the model you picked, and a user whose
    // answers keep getting cut short looks for the cause beside the model, not
    // under a heading named after the code that enforces the deadline.
    group: "Model",
    description: "How long Squid waits for an answer before giving up on it.",
    kind: "int",
  },
  {
    id: "captureGate",
    env: "SQUID_CONTROL",
    label: "Capture gate",
    group: "Pause control",
    description: "How you tell Squid to stop and start watching.",
    kind: "enum",
    values: ["fifo"],
  },
  {
    id: "captureGatePath",
    env: "SQUID_CONTROL_FIFO",
    label: "Capture gate FIFO",
    group: "Pause control",
    description: "Where Squid listens for your stop and start requests.",
    kind: "text",
    refine: (raw) => validateFifoPath("Capture gate FIFO", raw),
  },
  {
    id: "screenReader",
    env: "SQUID_SCREEN_READER",
    label: "Screen reader",
    group: "Screen",
    description: "How Squid reads the words on your screen.",
    kind: "enum",
    values: ["synthetic", "darwin", "linux", "windows"],
  },
  {
    id: "screenPollMs",
    env: "SQUID_SCREEN_POLL_MS",
    label: "Screen poll (ms)",
    group: "Screen",
    description: "How often Squid looks at the screen. The default is usually right.",
    kind: "int",
  },
  {
    id: "browser",
    env: "SQUID_BROWSER",
    label: "Browser pages",
    group: "Browser",
    description: "How Squid sees which pages you have open.",
    kind: "enum",
    values: ["synthetic", "darwin"],
  },
  {
    id: "browserPollMs",
    env: "SQUID_BROWSER_POLL_MS",
    label: "Browser poll (ms)",
    group: "Browser",
    description: "How often Squid looks at your open pages. The default is usually right.",
    kind: "int",
  },
  {
    id: "terminal",
    env: "SQUID_TERMINAL",
    label: "Terminal commands",
    group: "Terminal",
    description: "How Squid learns which commands you ran.",
    kind: "enum",
    values: ["fifo"],
  },
  {
    id: "terminalPath",
    env: "SQUID_TERMINAL_FIFO",
    label: "Terminal FIFO",
    group: "Terminal",
    description: "Where your shell tells Squid about the commands you ran.",
    kind: "text",
    refine: (raw) => validateFifoPath("Terminal FIFO", raw),
  },
  {
    id: "terminalPollMs",
    env: "SQUID_TERMINAL_POLL_MS",
    label: "Terminal poll (ms)",
    group: "Terminal",
    description: "How often Squid checks for new commands. The default is usually right.",
    kind: "int",
  },
  {
    id: "editorSaves",
    env: "SQUID_EDITOR_SAVES",
    label: "Editor saves",
    group: "Editor saves",
    description: "How Squid learns when you save a file.",
    kind: "enum",
    values: ["fifo"],
  },
  {
    id: "editorSavesPath",
    env: "SQUID_EDITOR_FIFO",
    label: "Editor saves FIFO",
    group: "Editor saves",
    description: "Where your editor tells Squid about the files you saved.",
    kind: "text",
    refine: (raw) => validateFifoPath("Editor saves FIFO", raw),
  },
  {
    id: "editorPollMs",
    env: "SQUID_EDITOR_POLL_MS",
    label: "Editor poll (ms)",
    group: "Editor saves",
    description: "How often Squid checks for saved files. The default is usually right.",
    kind: "int",
  },
  {
    id: "capturePollMs",
    env: "SQUID_CONTROL_POLL_MS",
    label: "Gate poll (ms)",
    // The gate's own interval, grouped with the gate rather than with the other
    // intervals it happens to sit beside in this table. This row is the reason
    // the panel buckets by value: by position it would land under whatever came
    // before it.
    group: "Pause control",
    description: "How often Squid checks whether you asked it to pause. The default is usually right.",
    kind: "int",
  },
  {
    id: "excludeApplications",
    env: "SQUID_EXCLUDE",
    label: "Excluded applications",
    group: "Privacy",
    // The exclusion verdict drops the whole event, structural fact included
    // (`ExcludingCapturePolicy`), which is what lets this description promise
    // more than redaction does without overstating what the code delivers.
    description: "Applications Squid records nothing from, not even that they were open.",
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
