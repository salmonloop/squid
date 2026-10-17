import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyConfigSet,
  configDumpEntries,
  DEFAULT_BASE_URL,
  isModelConfigKey,
  MODEL_CONFIG_KEYS,
  type ConfigDumpEntry,
  type ConfigServiceOptions,
} from "../src/config-service.js";
import { CONFIG_KEYS, configKeyById } from "../src/config-schema.js";
import { writeModelConfiguration } from "../src/app-model.js";

/**
 * The service's two stores are real files in a temp dir: the Squid config file
 * at `configPath`, and Pi's `models.json`/`auth.json` under `agentDir`. Both
 * halves must agree with what actually lands on disk — a test that only read
 * the return value would pass while the credential landed in the wrong store.
 */

const API_KEY = "sk-test-1234567890";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `squid-${prefix}-`));
}

function options(dir: string, overrides: Partial<ConfigServiceOptions> = {}): ConfigServiceOptions {
  return {
    configPath: join(dir, "config.json"),
    env: {},
    agentDir: join(dir, "agent"),
    provider: "bifrost",
    defaultModelId: "deepseek-v4-flash",
    defaultBaseUrl: DEFAULT_BASE_URL,
    agentLive: () => false,
    ...overrides,
  };
}

/** Stores the credential directly, so the endpoint paths have their other half. */
function seedCredential(agentDir: string, provider: string): void {
  writeModelConfiguration(agentDir, provider, {
    baseUrl: "https://seed.example/v1",
    modelId: "seed-model",
    apiKey: API_KEY,
  });
}

/** Unwraps one dump entry for an assertion, failing loudly when it is missing. */
function entryOf(result: ReturnType<typeof configDumpEntries>, id: string): ConfigDumpEntry {
  if (!result.ok) throw new Error(result.error);
  const found = result.entries.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no entry named ${id}`);
  return found;
}

describe("MODEL_CONFIG_KEYS", () => {
  it("are the three model keys, and only they", () => {
    expect(MODEL_CONFIG_KEYS.map((key) => key.id)).toEqual(["modelBaseUrl", "modelId", "apiKey"]);
    expect(isModelConfigKey("apiKey")).toBe(true);
    expect(isModelConfigKey("watchRoot")).toBe(false);
    // The guard's job is routing; a file key that leaked in here would be one
    // subtle bug from a credential written to the Squid config file.
    for (const key of CONFIG_KEYS) expect(isModelConfigKey(key.id)).toBe(false);
  });

  it("groups all three under Model, alongside the provider row in the other table", () => {
    // Which store a setting is written to is not a fact the form organizes by.
    // These three live in Pi's files and `modelProvider` lives in the Squid
    // config file, and the user asking "what answers me, and with what login"
    // is asking one question — a form that split them by storage would be
    // confessing an implementation detail nobody asked about.
    for (const key of MODEL_CONFIG_KEYS) expect(key.group).toBe("Model");
    expect(configKeyById("modelProvider")?.group).toBe("Model");
  });
});

describe("configDumpEntries", () => {
  it("lists the three model keys first, then every file key in schema order", () => {
    const dir = tempDir("dump");
    const result = configDumpEntries(options(dir));
    if (!result.ok) throw new Error(result.error);
    expect(result.entries.map((entry) => entry.id)).toEqual([
      ...MODEL_CONFIG_KEYS.map((key) => key.id),
      ...CONFIG_KEYS.map((key) => key.id),
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("carries plaintext apiKey value for MVP display", () => {
    const dir = tempDir("dump");
    seedCredential(options(dir).agentDir, "bifrost");
    const result = configDumpEntries(options(dir));
    if (!result.ok) throw new Error(result.error);
    expect(entryOf(result, "apiKey").kind).toBe("text");
    expect(entryOf(result, "apiKey").value).toBe(API_KEY);
    rmSync(dir, { recursive: true, force: true });
  });

  it("says whether a credential is stored and displays value in plaintext", () => {
    const dir = tempDir("secret-present");
    const before = configDumpEntries(options(dir));
    if (!before.ok) throw new Error(before.error);
    expect(entryOf(before, "apiKey").secretPresent).toBeUndefined();
    expect(entryOf(before, "apiKey").value).toBe("");

    seedCredential(options(dir).agentDir, "bifrost");
    const after = configDumpEntries(options(dir));
    if (!after.ok) throw new Error(after.error);
    expect(entryOf(after, "apiKey").secretPresent).toBe(true);
    expect(entryOf(after, "apiKey").value).toBe(API_KEY);
    rmSync(dir, { recursive: true, force: true });
  });

  it("carries a group and a description for every setting", () => {
    // The panel groups by what the wire tells it, so an entry that reached the
    // form without a group would be a row the user has to place themselves. The
    // count is asserted too: the two tables are joined here, and a setting
    // that silently stopped being dumped would otherwise still pass every
    // field check below.
    const dir = tempDir("dump");
    const result = configDumpEntries(options(dir));
    if (!result.ok) throw new Error(result.error);
    // Model rows + file-backed rows. Counted from the schema, not a literal,
    // so adding a setting is not a test failure.
    expect(result.entries).toHaveLength(MODEL_CONFIG_KEYS.length + CONFIG_KEYS.length);
    for (const entry of result.entries) {
      expect(entry.group.length).toBeGreaterThan(0);
      expect(entry.group).not.toBe("Advanced");
      expect(entry.description).toMatch(/^[A-Z].*\.$/);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the model entry for display and the file for the rest", () => {
    const dir = tempDir("dump");
    seedCredential(options(dir).agentDir, "bifrost");
    const result = configDumpEntries(options(dir));
    if (!result.ok) throw new Error(result.error);
    expect(entryOf(result, "modelBaseUrl").value).toBe("https://seed.example/v1");
    expect(entryOf(result, "modelId").value).toBe("seed-model");
    expect(entryOf(result, "watchRoot").value).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a file value even when an env var overrides it", () => {
    // The form edits the file, so it shows the file; `overridden` is the
    // disclosure that the live run disagrees — hiding the file value would
    // make a save look like a no-op with no reason attached.
    const dir = tempDir("dump");
    const result = configDumpEntries(options(dir, {
      env: { SQUID_WATCH_ROOT: "/from/env", PI_MODEL_ID: "env-model" },
    }));
    if (!result.ok) throw new Error(result.error);
    expect(entryOf(result, "watchRoot").value).toBe("");
    expect(entryOf(result, "watchRoot").overridden).toBe(true);
    expect(entryOf(result, "retentionHours").overridden).toBe(false);
    expect(entryOf(result, "modelId").overridden).toBe(true);
    // baseUrl and apiKey have no env channel; the flag stays false.
    expect(entryOf(result, "modelBaseUrl").overridden).toBe(false);
    expect(entryOf(result, "apiKey").overridden).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies model configuration now for hot-reloading", () => {
    const dir = tempDir("dump");
    const live = configDumpEntries(options(dir, { agentLive: () => true }));
    if (!live.ok) throw new Error(live.error);
    expect(entryOf(live, "modelBaseUrl").applies).toBe("now");
    expect(entryOf(live, "modelId").applies).toBe("now");
    expect(entryOf(live, "apiKey").applies).toBe("now");
    expect(entryOf(live, "inputSuggestions").applies).toBe("now");
    expect(entryOf(live, "watchRoot").applies).toBe("restart");

    const idle = configDumpEntries(options(dir, { agentLive: () => false }));
    if (!idle.ok) throw new Error(idle.error);
    expect(entryOf(idle, "modelBaseUrl").applies).toBe("now");
    expect(entryOf(idle, "inputSuggestions").applies).toBe("now");
    expect(entryOf(idle, "watchRoot").applies).toBe("restart");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a malformed config file as a dump failure, not an empty form", () => {
    // An empty form would invite a save that silently rewrites a file the
    // session could not even read; failing loudly keeps the user in the loop.
    const dir = tempDir("dump");
    writeFileSync(join(dir, "config.json"), "{not json", "utf8");
    const result = configDumpEntries(options(dir));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(typeof result.error).toBe("string");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("applyConfigSet on file-backed keys", () => {
  it("writes a valid value and reports restart", () => {
    const dir = tempDir("file-set");
    const outcome = applyConfigSet(options(dir), "watchRoot", "/new/root");
    expect(outcome).toEqual({ ok: true, applies: "restart" });
    const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, string>;
    expect(onDisk.watchRoot).toBe("/new/root");
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes inputSuggestions and reports now", () => {
    const dir = tempDir("input-sug-set");
    const outcome = applyConfigSet(options(dir), "inputSuggestions", "off");
    expect(outcome).toEqual({ ok: true, applies: "now" });
    const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, string>;
    expect(onDisk.inputSuggestions).toBe("off");
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes unset as an empty string for a valid kind", () => {
    const dir = tempDir("file-set");
    applyConfigSet(options(dir), "retentionHours", "72");
    const outcome = applyConfigSet(options(dir), "retentionHours", "");
    expect(outcome).toEqual({ ok: true, applies: "restart" });
    const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, string>;
    expect(onDisk.retentionHours).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an invalid value with the schema's message and writes nothing", () => {
    const dir = tempDir("file-set");
    const outcome = applyConfigSet(options(dir), "retentionHours", "1e3");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("Retention (hours)");
    expect(existsSync(join(dir, "config.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an unknown id and refuses to run at all without a config file", () => {
    const dir = tempDir("file-set");
    const unknown = applyConfigSet(options(dir), "notAKey", "x");
    expect(unknown).toEqual({ ok: false, error: 'Unknown setting "notAKey".' });

    const noFile = applyConfigSet(options(dir, { configPath: undefined }), "watchRoot", "/x");
    expect(noFile.ok).toBe(false);
    if (noFile.ok) return;
    expect(noFile.error).toContain("No configuration file is available");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("applyConfigSet on apiKey", () => {
  it("writes the full trio, defaulting the halves it does not have", () => {
    // The first-run case: apiKey arrives with no existing models.json or
    // auth.json. Both files must appear under the provider the service was
    // given, with the default base URL and default model id.
    const dir = tempDir("api-key");
    const opts = options(dir);
    const outcome = applyConfigSet(opts, "apiKey", `  ${API_KEY}  `);
    expect(outcome).toEqual({ ok: true, applies: "now" });

    const models = JSON.parse(readFileSync(join(opts.agentDir, "models.json"), "utf8")) as {
      providers: Record<string, { baseUrl: string; models: { id: string }[] }>;
    };
    const provider = models.providers.bifrost;
    if (provider === undefined) throw new Error("bifrost provider missing from models.json");
    expect(provider.baseUrl).toBe(DEFAULT_BASE_URL);
    const firstModel = provider.models[0];
    if (firstModel === undefined) throw new Error("no model id was written for bifrost");
    expect(firstModel.id).toBe("deepseek-v4-flash");

    const auth = JSON.parse(readFileSync(join(opts.agentDir, "auth.json"), "utf8")) as {
      bifrost: { key: string };
    };
    expect(auth.bifrost.key).toBe(API_KEY);
    rmSync(dir, { recursive: true, force: true });
  });

  it("treats an empty set as keep-what-is-stored, and refuses when nothing is stored", () => {
    const dir = tempDir("api-key");
    const opts = options(dir);
    // Nothing stored yet: an empty field cannot mean "keep" when there is no
    // credential to keep, and the refusal says what would fix it.
    const refused = applyConfigSet(opts, "apiKey", "");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain("No API key is stored yet");

    // Seed a key, then save empty. The stored key must not have moved.
    seedCredential(opts.agentDir, "bifrost");
    const kept = applyConfigSet(opts, "apiKey", "");
    expect(kept).toEqual({ ok: true, applies: "now" });
    const auth = JSON.parse(readFileSync(join(opts.agentDir, "auth.json"), "utf8")) as {
      bifrost: { key: string };
    };
    expect(auth.bifrost.key).toBe(API_KEY);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports now for hot-reloading when apiKey is updated", () => {
    const dir = tempDir("api-key");
    const live = options(dir, { agentLive: () => true });
    expect(applyConfigSet(live, "apiKey", API_KEY)).toEqual({ ok: true, applies: "now" });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("applyConfigSet on the endpoint keys", () => {
  it("refuses an empty value and permits saving without a prior credential", () => {
    const dir = tempDir("endpoint");
    const opts = options(dir);
    const empty = applyConfigSet(opts, "modelBaseUrl", "   ");
    if (empty.ok) throw new Error("empty endpoint was accepted");
    expect(empty.error).toBe("Base URL cannot be empty.");

    // Developer efficiency first: endpoint fields can be saved freely without
    // artificially demanding an existing API key first.
    const urlSet = applyConfigSet(opts, "modelBaseUrl", "https://new.example/v1");
    expect(urlSet).toEqual({ ok: true, applies: "now" });

    const modelSet = applyConfigSet(opts, "modelId", "new-model");
    expect(modelSet).toEqual({ ok: true, applies: "now" });
    expect(existsSync(join(opts.agentDir, "models.json"))).toBe(true);

    const models = JSON.parse(readFileSync(join(opts.agentDir, "models.json"), "utf8")) as {
      providers: Record<string, { baseUrl: string; models: { id: string }[] }>;
    };
    expect(models.providers.bifrost?.baseUrl).toBe("https://new.example/v1");
    expect(models.providers.bifrost?.models[0]?.id).toBe("new-model");
    rmSync(dir, { recursive: true, force: true });
  });

  it("edits the endpoint without needing or touching the credential", () => {
    // The whole point of writeModelEndpoint: this layer cannot read the key
    // back, so an endpoint edit must never depend on restating it — and it
    // must not rewrite auth.json, which would mean it read it.
    const dir = tempDir("endpoint");
    const opts = options(dir);
    seedCredential(opts.agentDir, "bifrost");
    const authBefore = readFileSync(join(opts.agentDir, "auth.json"), "utf8");

    expect(applyConfigSet(opts, "modelBaseUrl", "https://moved.example/v1"))
      .toEqual({ ok: true, applies: "now" });
    // Order independence: the endpoint edit kept the seeded model id, so the
    // entry stays coherent without a second set.
    const models = JSON.parse(readFileSync(join(opts.agentDir, "models.json"), "utf8")) as {
      providers: Record<string, { baseUrl: string; models: { id: string }[] }>;
    };
    const entry = models.providers.bifrost;
    if (entry === undefined) throw new Error("bifrost provider missing from models.json");
    expect(entry.baseUrl).toBe("https://moved.example/v1");
    const firstModel = entry.models[0];
    if (firstModel === undefined) throw new Error("the seeded model id vanished");
    expect(firstModel.id).toBe("seed-model");
    expect(readFileSync(join(opts.agentDir, "auth.json"), "utf8")).toBe(authBefore);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the entry coherent when the endpoint keys arrive out of order", () => {
    // Key first, then endpoint: the sets must compose into one correct entry
    // regardless of the order the form sends them.
    const dir = tempDir("endpoint");
    const opts = options(dir);
    expect(applyConfigSet(opts, "apiKey", API_KEY)).toEqual({ ok: true, applies: "now" });
    expect(applyConfigSet(opts, "modelId", "chosen-model")).toEqual({ ok: true, applies: "now" });
    const models = JSON.parse(readFileSync(join(opts.agentDir, "models.json"), "utf8")) as {
      providers: Record<string, { baseUrl: string; models: { id: string }[] }>;
    };
    const entry = models.providers.bifrost;
    if (entry === undefined) throw new Error("bifrost provider missing from models.json");
    expect(entry.baseUrl).toBe(DEFAULT_BASE_URL);
    const firstModel = entry.models[0];
    if (firstModel === undefined) throw new Error("no model id was written for bifrost");
    expect(firstModel.id).toBe("chosen-model");
    rmSync(dir, { recursive: true, force: true });
  });

  it("saves a model id without deleting the provider's other models", () => {
    // The write used to replace the whole `models` array, so saving an id
    // through the form pruned a catalog it does not own. The saved id leads --
    // that position is what a session opens -- and the rest keep their order.
    const dir = tempDir("siblings");
    const opts = options(dir);
    expect(applyConfigSet(opts, "apiKey", API_KEY)).toEqual({ ok: true, applies: "now" });
    const modelsPath = join(opts.agentDir, "models.json");
    const seeded = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      providers: Record<string, { baseUrl: string; models: Record<string, unknown>[] }>;
    };
    const provider = seeded.providers.bifrost;
    if (provider === undefined) throw new Error("bifrost provider missing after the key write");
    provider.models = [
      { id: "first-model", name: "first", contextWindow: 4096 },
      { id: "second-model", name: "second", contextWindow: 8192 },
    ];
    writeFileSync(modelsPath, JSON.stringify(seeded), "utf8");

    expect(applyConfigSet(opts, "modelId", "second-model")).toEqual({ ok: true, applies: "now" });
    const after = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      providers: Record<string, { models: { id: string; contextWindow?: number }[] }>;
    };
    const entry = after.providers.bifrost;
    if (entry === undefined) throw new Error("bifrost provider missing from models.json");
    expect(entry.models.map((model) => model.id)).toEqual(["second-model", "first-model"]);
    // The chosen entry was hand-tuned; promoting it must not regenerate it and
    // silently reset the limits the user set.
    expect(entry.models[0]?.contextWindow).toBe(8192);
    rmSync(dir, { recursive: true, force: true });
  });

  it("generates an entry for an id the catalog does not have yet, keeping the rest", () => {
    const dir = tempDir("new-id");
    const opts = options(dir);
    expect(applyConfigSet(opts, "apiKey", API_KEY)).toEqual({ ok: true, applies: "now" });
    const modelsPath = join(opts.agentDir, "models.json");
    const seeded = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      providers: Record<string, { models: Record<string, unknown>[] }>;
    };
    const provider = seeded.providers.bifrost;
    if (provider === undefined) throw new Error("bifrost provider missing after the key write");
    provider.models = [{ id: "kept-model", name: "kept" }];
    writeFileSync(modelsPath, JSON.stringify(seeded), "utf8");

    expect(applyConfigSet(opts, "modelId", "brand-new")).toEqual({ ok: true, applies: "now" });
    const after = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      providers: Record<string, { models: { id: string }[] }>;
    };
    expect(after.providers.bifrost?.models.map((model) => model.id)).toEqual([
      "brand-new",
      "kept-model",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
});
