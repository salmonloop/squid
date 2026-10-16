import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_KEYS, configKeyByEnv, configKeyById } from "../src/config-schema.js";
import { resolveConfigPath, type ConfigPathResolution } from "../src/config-paths.js";
import { readConfigFile, updateConfigFile, type ConfigFileRead } from "../src/config-file.js";
import {
  loadConfiguredEnvironment,
  withConfigFile,
} from "../src/effective-env.js";

/** Unwraps a resolution for an assertion, failing loudly if it was an error. */
function pathOf(result: ConfigPathResolution): string {
  if ("configError" in result) throw new Error(result.configError);
  return result.path;
}

/** Unwraps a read for an `toEqual`, failing loudly if it was an error. */
function readOf(result: ConfigFileRead): { kind: string; values: Record<string, string> } {
  if ("configError" in result) throw new Error(result.configError);
  if (result.kind !== "read") throw new Error(`expected a read, got kind ${result.kind}`);
  return { kind: result.kind, values: { ...result.values } };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "squid-config-"));
}

function writeConfig(path: string, body: string): void {
  writeFileSync(path, body, "utf8");
}

describe("config schema", () => {
  it("maps every id to the env name a resolver already reads", () => {
    // The schema introduces no new configuration language: each row is a
    // rename of an existing variable, so a wrong env spelling here would
    // silently strand a setting the panel offers but nothing reads.
    expect(configKeyById("watchRoot")?.env).toBe("SQUID_WATCH_ROOT");
    expect(configKeyById("databasePath")?.env).toBe("SQUID_DB");
    expect(configKeyByEnv("SQUID_SCREEN_POLL_MS")?.id).toBe("screenPollMs");
    expect(configKeyByEnv("SQUID_PANEL_SOCKET")).toBeUndefined();
  });

  it("accepts the values each kind means and refuses the near-misses", () => {
    const retention = configKeyById("retentionHours")!;
    expect(retention.validate("72")).toEqual({ ok: true });
    // `Number()` would take all three; a lax parser here would store values
    // the resolver then refuses, moving the error to a place with no form.
    expect(retention.validate("1e3").ok).toBe(false);
    expect(retention.validate(" 24").ok).toBe(false);
    expect(retention.validate("0").ok).toBe(false);
    expect(retention.validate("-1").ok).toBe(false);

    const reader = configKeyById("screenReader")!;
    expect(reader.validate("synthetic")).toEqual({ ok: true });
    expect(reader.validate("Synthetic").ok).toBe(false);
    expect(reader.validate("vision").ok).toBe(false);

    const root = configKeyById("watchRoot")!;
    expect(root.validate("/home/me")).toEqual({ ok: true });
    // A pasted trailing newline is a different directory; the file layer's
    // one whitespace rule is refuse, not trim.
    expect(root.validate("/home/me ").ok).toBe(false);
  });

  it("reads the empty string as unset for every key", () => {
    // An empty settings field means "not set", and unset already means the
    // right thing everywhere — home default, capture off, no exclusions.
    for (const key of CONFIG_KEYS) {
      expect(key.validate("")).toEqual({ ok: true });
    }
  });

  it("refuses the empty entry an exclusion list would turn into a typo", () => {
    const exclude = configKeyById("excludeApplications")!;
    expect(exclude.validate("code,terminal")).toEqual({ ok: true });
    expect(exclude.validate("code,,terminal").ok).toBe(false);
    // Whitespace *around* an entry is what the resolver trims, so the file
    // layer accepts it too — refusing here would make a value work by env and
    // fail by file, an asymmetry with no defender.
    expect(exclude.validate("code, terminal").ok).toBe(true);
  });

  it("pairs every backend enum with a path the same form can set", () => {
    // The defect this covers: while the FIFO paths were env-only, each of these
    // three enums offered exactly one legal value, and choosing it guaranteed a
    // startup configError -- from a form that only exists while a brain is
    // running. An enum whose value the same form cannot satisfy is a trap, so
    // the pairing is asserted rather than left to whoever adds the next backend.
    for (const [enumId, pathId] of [
      ["captureGate", "captureGatePath"],
      ["terminal", "terminalPath"],
      ["editorSaves", "editorSavesPath"],
    ] as const) {
      const backend = configKeyById(enumId);
      const path = configKeyById(pathId);
      expect(backend?.kind).toBe("enum");
      expect(backend?.values).toEqual(["fifo"]);
      expect(path?.kind).toBe("text");
    }
  });

  it("judges a source endpoint by one dialect on every host", () => {
    // The config file is written in one dialect, and the resolvers judge the
    // endpoint with their own spelling check: POSIX-absolute, or the Windows
    // named-pipe spelling `\\.\pipe\<name>`. A host-sensitive `isAbsolute`
    // here would accept `C:\\pipe` on Windows and then watch a resolver refuse
    // it, moving the error past the form that could fix it.
    //
    // The pipe spelling is accepted *because the resolvers now read it* —
    // `mkfifo` has no Windows equivalent, so without the pipe dialect the
    // only enum value these paths pair with would be unusable there, the
    // trap the enum/path pairing test above exists to prevent.
    for (const id of ["captureGatePath", "terminalPath", "editorSavesPath"] as const) {
      const key = configKeyById(id)!;
      expect(key.validate("/run/squid/gate")).toEqual({ ok: true });
      expect(key.validate("\\\\.\\pipe\\squid-gate")).toEqual({ ok: true });
      expect(key.validate("//./pipe/squid-gate")).toEqual({ ok: true });
      expect(key.validate("gate.fifo").ok).toBe(false);
      expect(key.validate("./gate.fifo").ok).toBe(false);
      // A drive spelling is a path, not the pipe spelling; the resolvers
      // treat it as relative and the form must not diverge from them.
      expect(key.validate("C:\\pipe\\gate").ok).toBe(false);
      // Same whitespace rule as every other text row: a pasted newline is a
      // different path, and the file layer refuses rather than trims.
      expect(key.validate("/run/squid/gate ").ok).toBe(false);
    }
  });

  it("accounts for every configuration variable the source tree reads", () => {
    // `config-schema.ts` claims this asymmetry IS the check that catches a new
    // SQUID_* variable added without deciding whether a user may configure it.
    // That claim lived only in a comment, so the check it describes never ran:
    // three variables sat outside the table for months while the panel offered
    // the enums that required them. Reading the tree is what makes the claim
    // true rather than aspirational.
    //
    // Every name found in `src` must be one of three things: a row in the
    // table, a documented exemption, or -- if it is neither -- a decision
    // nobody has made yet, which is exactly what should fail here.
    //
    // `PI_MODEL_*` is swept as well as `SQUID_*`, because a check that only
    // knew our own prefix is how `PI_MODEL_PROVIDER` stayed unconfigurable
    // while looking accounted for. The prefix a variable happens to carry is
    // not what decides whether a user may set it.
    const EXEMPT = new Map<string, string>([
      // The panel endpoint names where this process talks to the panel. One
      // half of a pair whose other half must agree; a config file that could
      // repoint it would repoint a running session's panel.
      ["SQUID_PANEL_SOCKET", "interop endpoint, env-only by design"],
      // Written by the shell hook, read as one command's payload. Not a setting.
      ["SQUID_LAST_COMMAND", "shell-side payload, not configuration"],
      // Says where the config file IS; it cannot live inside the file it names.
      ["SQUID_CONFIG", "names the config file, so it cannot be in it"],
      // Set by the supervisor on the child it spawned. A run cannot award
      // itself the right to accept a restart.
      ["SQUID_SUPERVISED", "supervisor's claim about the child, not a setting"],
      // Named only in prose: the egress policy it configured was deleted with
      // the action layer that enforced it. Listed so a reader knows the
      // remaining mentions are history, not a gap.
      ["SQUID_SEARCH_EGRESS", "removed with the action layer; comments only"],
      // The default model id a write falls back to and first-run suggests.
      // Which model a session opens is the id stored in Pi's `models.json`,
      // read by `resolveConfiguredModel` -- a file-backed copy of it would be
      // the parallel store `app-model.ts` exists to prevent.
      ["PI_MODEL_ID", "a write-time default; the stored entry is the answer"],
      ["SQUID_AGENT_DIR", "names the agent directory override, env-only"],
    ]);

    const names = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        for (const match of readFileSync(full, "utf8").matchAll(/\b(?:SQUID|PI_MODEL)_[A-Z_]+/g)) {
          names.add(match[0]);
        }
      }
    };
    walk(join(import.meta.dir, "..", "src"));

    // A guard on the guard: a walk that found nothing would pass every
    // assertion below while checking nothing at all.
    expect(names.size).toBeGreaterThan(CONFIG_KEYS.length);

    const unaccounted = [...names].filter(
      (name) => configKeyByEnv(name) === undefined && !EXEMPT.has(name),
    );
    expect(unaccounted).toEqual([]);

    // And the other direction: an exemption for a name the tree no longer
    // mentions is a stale note that would quietly excuse a future collision.
    const stale = [...EXEMPT.keys()].filter((name) => !names.has(name));
    expect(stale).toEqual([]);
  });

  it("carries every label and kind the panel will render", () => {
    // The wire config message hands these over verbatim so Rust never
    // hardcodes a key; a row missing its label would ship a form with a hole.
    for (const key of CONFIG_KEYS) {
      expect(key.label.length).toBeGreaterThan(0);
      if (key.kind === "enum") expect(key.values?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("files every setting under the capability a user would look for it in", () => {
    // Restated here rather than derived from the table, which is the only way
    // this assertion is worth running: a check that read `key.group` back would
    // agree with any grouping at all, including one that quietly moved a row.
    // The mapping is a product decision, so it is written down twice on purpose.
    const EXPECTED = new Map<string, string>([
      ["modelProvider", "Model"],
      ["agentTurnTimeoutMs", "Model"],
      ["decisionCuration", "Decision curation"],
      ["decisionCuratorBaseUrl", "Decision curation"],
      ["decisionCuratorModel", "Decision curation"],
      ["decisionCuratorThreshold", "Decision curation"],
      ["attentionWindowMinutes", "Decision curation"],
      ["notify", "Notifications"],
      ["watchRoot", "Files"],
      ["screenReader", "Screen"],
      ["screenPollMs", "Screen"],
      ["browser", "Browser"],
      ["browserPollMs", "Browser"],
      ["terminal", "Terminal"],
      ["terminalPath", "Terminal"],
      ["terminalPollMs", "Terminal"],
      ["editorSaves", "Editor saves"],
      ["editorSavesPath", "Editor saves"],
      ["editorPollMs", "Editor saves"],
      ["captureGate", "Pause control"],
      ["captureGatePath", "Pause control"],
      ["capturePollMs", "Pause control"],
      ["databasePath", "History"],
      ["retentionHours", "History"],
      ["excludeApplications", "Privacy"],
    ]);
    // Widened to plain strings on purpose, so this comparison does not inherit
    // the `ConfigGroup` union: adding a group to the type and to the table would
    // still have to answer to the map above rather than typecheck its way past
    // it.
    const actual = new Map<string, string>(CONFIG_KEYS.map((key) => [key.id, key.group]));
    expect(actual).toEqual(EXPECTED);

    // A group names a capability the user has a question about, never the code
    // that implements it — and "Advanced" is neither. It is where a settings
    // screen files the rows nobody wanted to explain, which is exactly the
    // outcome `description` exists to make impossible.
    for (const key of CONFIG_KEYS) expect(key.group).not.toBe("Advanced");
  });

  it("explains every setting in one sentence that is not its own name", () => {
    const seen = new Map<string, string>();
    for (const key of CONFIG_KEYS) {
      // Sentence-shaped, because this is prose the panel prints beside a field
      // and not a keyword list: a fragment reads as a truncated label.
      expect(key.description).toMatch(/^[A-Z].*\.$/);
      expect(key.description).toContain(" ");
      // Not the label again. A row whose only description is its own name is a
      // row whose purpose was never actually decided, and the panel would be
      // spending a line to repeat itself.
      expect(key.description.toLowerCase()).not.toBe(key.label.toLowerCase());
      // Nor a clone of another row's. Four poll intervals share a shape and are
      // the easy place to paste one sentence four times, which would leave the
      // user unable to tell which interval they are looking at.
      const clash = seen.get(key.description);
      expect(clash).toBeUndefined();
      seen.set(key.description, key.id);
    }
    // The sanitizer caps display text at 200 characters, so a description that
    // needed truncating would reach the panel ending mid-word.
    for (const key of CONFIG_KEYS) expect(key.description.length).toBeLessThan(200);
  });
});

describe("resolveConfigPath", () => {
  it("names each platform's own config home", () => {
    const home = "/home/me";
    // Literals, in each platform's own dialect, and that is the whole point: the
    // resolver joins with `posix.join` or `win32.join` per branch rather than the
    // host-sensitive `join`, so these strings are the same on every runner. An
    // expectation rebuilt with the host's `join` would instead agree with a
    // resolver that also used it — the same function on both sides of the equals,
    // passing everywhere and proving nothing.
    expect(pathOf(resolveConfigPath({ env: {}, platform: "darwin", home })))
      .toBe("/home/me/Library/Application Support/Squid/config.json");
    // Windows spells a bare-rooted home this way; the segments are what matter
    // and the separator is the one the branch is written for.
    expect(pathOf(resolveConfigPath({ env: {}, platform: "win32", home })))
      .toBe("\\home\\me\\AppData\\Roaming\\Squid\\config.json");
    // A real Windows home, with APPDATA set the way the OS sets it.
    expect(pathOf(resolveConfigPath({
      env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
      platform: "win32",
      home: "C:\\Users\\me",
    }))).toBe("C:\\Users\\me\\AppData\\Roaming\\Squid\\config.json");
    expect(pathOf(resolveConfigPath({ env: {}, platform: "linux", home })))
      .toBe("/home/me/.config/squid/config.json");
  });

  it("honors an absolute XDG_CONFIG_HOME and refuses a relative one", () => {
    const home = "/home/me";
    expect(pathOf(resolveConfigPath({ env: { XDG_CONFIG_HOME: "/etc/me" }, platform: "linux", home })))
      .toBe("/etc/me/squid/config.json");
    // A relative XDG dir would make the file's location depend on the launch
    // directory — the same reason the override below is absolute-only.
    expect(pathOf(resolveConfigPath({ env: { XDG_CONFIG_HOME: "etc/me" }, platform: "linux", home })))
      .toBe("/home/me/.config/squid/config.json");
  });

  it("takes SQUID_CONFIG as the whole file, and only when absolute", () => {
    expect(pathOf(resolveConfigPath({ env: { SQUID_CONFIG: "/tmp/x/config.json" }, platform: "linux" })))
      .toBe("/tmp/x/config.json");
    expect(resolveConfigPath({ env: { SQUID_CONFIG: "x/config.json" }, platform: "linux" }))
      .toEqual({ configError: "SQUID_CONFIG must be an absolute path." });
    expect(pathOf(resolveConfigPath({ env: { SQUID_CONFIG: "C:\\x\\config.json" }, platform: "win32" })))
      .toBe("C:\\x\\config.json");
  });
});

describe("readConfigFile", () => {
  it("reports absence instead of inventing an error", () => {
    const read = readConfigFile(join(tempDir(), "config.json"));
    expect("configError" in read).toBe(false);
    if ("configError" in read) return;
    expect(read.kind).toBe("absent");
  });

  it("reads known keys after validating them", () => {
    const dir = tempDir();
    const path = join(dir, "config.json");
    writeConfig(path, JSON.stringify({ watchRoot: "/home/me", retentionHours: "72" }));
    expect(readOf(readConfigFile(path))).toEqual({
      kind: "read",
      values: { watchRoot: "/home/me", retentionHours: "72" },
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails on malformed JSON rather than starting without it", () => {
    // A file the user hand-edited that no longer parses is not ours to ignore:
    // starting anyway would run with settings that are not the ones on disk.
    const dir = tempDir();
    const path = join(dir, "config.json");
    writeConfig(path, "{not json");
    const read = readConfigFile(path);
    expect("configError" in read).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses anything but a flat object of strings", () => {
    const dir = tempDir();
    for (const body of [
      JSON.stringify(["watchRoot"]),
      JSON.stringify({ retentionHours: 72 }),
      JSON.stringify({ nested: { watchRoot: "/x" } }),
    ]) {
      const path = join(dir, "config.json");
      writeConfig(path, body);
      expect("configError" in readConfigFile(path)).toBe(true);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("carries unknown keys through honestly, validating only its own", () => {
    // A key from a newer build must survive a downgrade round-trip, and it
    // must not be enforced by a build that cannot name it. What the session
    // sees is filtered later, at the env boundary — not here.
    const dir = tempDir();
    const path = join(dir, "config.json");
    writeConfig(path, JSON.stringify({ futureSetting: "whatever", watchRoot: "/home/me" }));
    expect(readOf(readConfigFile(path))).toEqual({
      kind: "read",
      values: { futureSetting: "whatever", watchRoot: "/home/me" },
    });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("updateConfigFile", () => {
  it("merges updates and preserves keys it cannot name", () => {
    const dir = tempDir();
    const path = join(dir, "config.json");
    writeConfig(path, JSON.stringify({ futureSetting: "kept", watchRoot: "/old" }));

    const written = updateConfigFile(path, { watchRoot: "/new" });
    // The read-back includes the unknown key: a write that swallowed it would
    // be the merge eating an entry it cannot name.
    expect(written).toEqual({
      kind: "read",
      values: { futureSetting: "kept", watchRoot: "/new" },
    });

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    expect(onDisk.futureSetting).toBe("kept");
    expect(onDisk.watchRoot).toBe("/new");
    // No temp litter: the atomic write's scratch file is gone once renamed.
    expect(existsSync(`${path}.squid.tmp`)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes unset as absence, never as an empty string", () => {
    const dir = tempDir();
    const path = join(dir, "config.json");
    writeConfig(path, JSON.stringify({ watchRoot: "/old", retentionHours: "72" }));

    updateConfigFile(path, { watchRoot: "" });
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    expect(onDisk.watchRoot).toBeUndefined();
    expect(onDisk.retentionHours).toBe("72");
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the directory and the file on first write", () => {
    const dir = tempDir();
    const path = join(dir, "nested", "squid", "config.json");
    const written = updateConfigFile(path, { watchRoot: "/new" });
    expect(written).toEqual({ kind: "read", values: { watchRoot: "/new" } });
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to write an unknown or invalid key", () => {
    const dir = tempDir();
    const path = join(dir, "config.json");
    expect("configError" in updateConfigFile(path, { futureSetting: "x" })).toBe(true);
    expect("configError" in updateConfigFile(path, { retentionHours: "0" })).toBe(true);
    expect(existsSync(path)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("withConfigFile", () => {
  it("lets the env win per key and the file fill the gaps", () => {
    // Per key, not per file: one exported variable beats the file for exactly
    // that variable, while every other setting still comes from the file.
    const env = { SQUID_WATCH_ROOT: "/from/env", SQUID_RETENTION_HOURS: "24" };
    const file = { watchRoot: "/from/file", retentionHours: "72", screenPollMs: "500" };
    const merged = withConfigFile(env, file);
    expect(merged.SQUID_WATCH_ROOT).toBe("/from/env");
    expect(merged.SQUID_RETENTION_HOURS).toBe("24");
    expect(merged.SQUID_SCREEN_POLL_MS).toBe("500");
  });

  it("maps file ids to env names through the schema, and nothing else", () => {
    // An id that is not in the table must not leak into the env under any
    // spelling — the endpoints are env-only by design.
    const merged = withConfigFile({}, { unknownKey: "value" });
    expect(merged).toEqual({});
  });

  it("treats a file empty string as unset and an env empty string as the env's", () => {
    // The file layer never has "" semantics — absence is absence. The env
    // layer keeps its own contract: SQUID_DB="" travels verbatim and the
    // resolver refuses it, exactly as it would without a config file.
    const merged = withConfigFile(
      { SQUID_DB: "" },
      { watchRoot: "", databasePath: "", retentionHours: "72" },
    );
    expect(merged.SQUID_DB).toBe("");
    expect(merged.SQUID_WATCH_ROOT).toBeUndefined();
    expect(merged.SQUID_RETENTION_HOURS).toBe("72");
  });
});

describe("loadConfiguredEnvironment", () => {
  it("composes path, file, and precedence in one step-0", () => {
    const dir = tempDir();
    const path = join(dir, "config.json");
    writeConfig(path, JSON.stringify({ retentionHours: "72" }));

    // The host's platform, not a declared one: the path came from the host's
    // own `mkdtemp`, and telling the resolver it is looking at Linux while
    // handing it `C:\Users\...` makes POSIX rules call that path relative.
    // A test that declares a platform must also speak that platform's paths.
    const loaded = loadConfiguredEnvironment(
      { SQUID_CONFIG: path, SQUID_RETENTION_HOURS: "24" },
    );
    expect("env" in loaded).toBe(true);
    if ("env" in loaded) {
      expect(loaded.env.SQUID_RETENTION_HOURS).toBe("24");
      expect(loaded.configPath).toBe(path);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a broken file and a broken path with the same configError shape", () => {
    const brokenFile = join(tempDir(), "config.json");
    writeConfig(brokenFile, "{not json");
    expect("configError" in loadConfiguredEnvironment(
      { SQUID_CONFIG: brokenFile },
    )).toBe(true);

    expect("configError" in loadConfiguredEnvironment(
      { SQUID_CONFIG: "relative.json" },
      { platform: "linux" },
    )).toBe(true);
  });

  it("produces the raw env unchanged when no file exists", () => {
    const loaded = loadConfiguredEnvironment(
      { SQUID_CONFIG: join(tempDir(), "absent.json"), SQUID_WATCH_ROOT: "/tmp/demo" },
    );
    expect("env" in loaded).toBe(true);
    if ("env" in loaded) expect(loaded.env.SQUID_WATCH_ROOT).toBe("/tmp/demo");
  });
});
