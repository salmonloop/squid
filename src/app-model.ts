import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { writeJsonAtomic } from "./json-atomic.js";

/**
 * Whether the resident agent's model is usable, and first-run setup when it is
 * not.
 *
 * Pi stores two halves of a model configuration, and the agent needs both:
 * `models.json` defines the provider (an OpenAI-compatible endpoint and its
 * model catalog) and `auth.json` holds the credential. A fresh machine has
 * neither, and the failure the agent itself reports — "No resident-agent model
 * is configured" — arrives only after the store and sinks are already being
 * built. Detecting it here, before anything starts, turns that late error into
 * a question the user can actually answer.
 *
 * Writes go through Pi's own file shapes and nothing else: no parallel store,
 * no Squid-side settings file. `readStoredCredential` is Pi's public read API;
 * the writes use the same JSON schemas Pi's own `AuthStorage` and models
 * loading read back. The first-run path runs before any session exists, so the
 * single-process read-modify-write needs no locking — that machinery belongs
 * to the store Pi uses once sessions are live.
 */

/** Conservative defaults for a model whose real limits are unknown. */
const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 32768;

/** The companion gateway this pre-release is configured against. */
export const DEFAULT_BASE_URL = "https://shanghsin-bifrost.hf.space/v1";

export type ModelConfigurationStatus =
  | { readonly kind: "ready" }
  | { readonly kind: "missing-provider" }
  | { readonly kind: "missing-credential" }
  | { readonly kind: "malformed-models" };

type ProviderCatalog =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" }
  | { readonly kind: "present"; readonly providers: Record<string, unknown> };

/**
 * Reads the user's provider catalog. `malformed` is distinct from `absent` on
 * purpose: a file the user wrote by hand that fails to parse is not ours to
 * repair — running first-run against it would overwrite their entries with a
 * generated file, so the caller reports and stops instead.
 */
function readProviders(agentDir: string): ProviderCatalog {
  const modelsPath = join(agentDir, "models.json");
  if (!existsSync(modelsPath)) return { kind: "absent" };
  try {
    const parsed: unknown = JSON.parse(readFileSync(modelsPath, "utf8"));
    const providers = (parsed as { providers?: unknown }).providers;
    return typeof providers === "object" && providers !== null
      ? { kind: "present", providers: providers as Record<string, unknown> }
      : { kind: "malformed" };
  } catch {
    return { kind: "malformed" };
  }
}

export function modelConfigurationStatus(
  agentDir: string,
  provider: string,
): ModelConfigurationStatus {
  const catalog = readProviders(agentDir);
  if (catalog.kind === "malformed") {
    return { kind: "malformed-models" };
  }
  if (catalog.kind === "absent" || !(provider in catalog.providers)) {
    return { kind: "missing-provider" };
  }
  const credential = readStoredCredential(provider, join(agentDir, "auth.json"));
  if (credential === undefined) {
    return { kind: "missing-credential" };
  }
  return { kind: "ready" };
}

export interface ModelEntryValues {
  readonly baseUrl: string | undefined;
  readonly modelId: string | undefined;
}

/**
 * Reads one provider's current entry for *display*: what a settings form would
 * start from. Values are undefined when the entry does not name them, and the
 * whole result is undefined when there is no readable entry — a malformed file
 * reads as unconfigured here, because the dump's job is to show the form, not
 * to adjudicate the file; the next startup's status check is what refuses a
 * malformed one loudly.
 */
export function readModelEntry(agentDir: string, provider: string): ModelEntryValues | undefined {
  const catalog = readProviders(agentDir);
  if (catalog.kind !== "present") return undefined;
  const record = catalog.providers[provider];
  if (typeof record !== "object" || record === null) return undefined;
  const entry = record as { baseUrl?: unknown; models?: unknown };
  const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl : undefined;
  const first = Array.isArray(entry.models) ? entry.models[0] : undefined;
  const modelId = typeof first === "object" && first !== null && typeof (first as { id?: unknown }).id === "string"
    ? (first as { id: string }).id
    : undefined;
  if (baseUrl === undefined && modelId === undefined) return undefined;
  return { baseUrl, modelId };
}

/**
 * Whether a credential for the provider can be *read*, never exposing its
 * value: the key's content stays inside Pi's auth file and this module. Callers
 * that need the value to restate it (an endpoint rewrite that also rewrote
 * auth.json) are the reason `writeModelEndpoint` exists instead — an endpoint
 * edit must not need the key at all.
 *
 * Readable, not stored, and the name says so on purpose. Pi's
 * `readStoredCredential` catches every error and answers the same `undefined`
 * for a missing file, a file this process may not open, and a truncated or
 * hand-broken one — so a `false` here cannot tell "none was ever set" from "one
 * is set and unreachable". That is still the right answer for every caller: the
 * status check above reads through the same call, and Pi's own store keeps its
 * last snapshot when a reload throws, so a credential this cannot read is one no
 * session can use either. What it is not is a claim about what the *user* has
 * done, and the settings form once made it exactly that ("Not set yet") in the
 * one field where acting on the mistake overwrites something nobody can get
 * back. Do not restore a name, or a comment, that says this reports existence.
 */
export function hasReadableCredential(agentDir: string, provider: string): boolean {
  return readStoredCredential(provider, join(agentDir, "auth.json")) !== undefined;
}

export interface FirstRunAnswers {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey: string;
}

/**
 * The console prompts first-run talks through. Injected so tests drive the
 * conversation without a stdin.
 */
export interface FirstRunIO {
  /** Reads one line; an empty answer means "accept the default". */
  readonly prompt: (message: string, defaultValue: string) => Promise<string>;
  /** Reads one line without echo for the key. */
  readonly secret: (message: string) => Promise<string>;
  readonly say: (line: string) => void;
}

export async function askFirstRunAnswers(
  io: FirstRunIO,
  defaults: { readonly modelId: string },
): Promise<FirstRunAnswers> {
  io.say("The resident agent needs a model before this session can start.");
  io.say("Any OpenAI-compatible endpoint works; Pi stores it in its own config.");
  // Empty means "the default, please": a plain `io.question` reports a bare
  // enter as "", so the conversation owns the defaulting, not each transport.
  const baseUrl = (await io.prompt("API base URL", DEFAULT_BASE_URL)).trim();
  const modelId = (await io.prompt("Model id", defaults.modelId)).trim();
  const apiKey = (await io.secret("API key")).trim();
  return {
    baseUrl: baseUrl.length === 0 ? DEFAULT_BASE_URL : baseUrl,
    modelId: modelId.length === 0 ? defaults.modelId : modelId,
    apiKey,
  };
}

/**
 * Atomic-enough write: temp file plus rename, so a crash mid-write leaves the
 * previous file intact rather than a truncated one. Both files may hold other
 * providers' entries — the read-modify-write preserves them, because clobbering
 * a user's other logins to add ours is not a default anyone consented to.
 *
 * The mechanics live in `json-atomic.ts`, shared with the Squid config file;
 * only the comment survives here because the read-modify-write contract above
 * it is what a reader of this file needs to know.
 */

/** The catalog entry a Squid-side write generates for one model id. */
function generatedModelEntry(modelId: string): Record<string, unknown> {
  return {
    id: modelId,
    name: modelId,
    reasoning: true,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    // Usage accounting shows zero cost until the user edits the entry;
    // guessing a price would be worse than showing none.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/** The `id` of a catalog entry, when it has a readable one. */
function entryModelId(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const id = (entry as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

/**
 * The endpoint half of the configuration, shared by the first-run write and
 * `writeModelEndpoint`: one provider's models.json entry, rewritten while every
 * other provider the user has configured is preserved. Clobbering a user's
 * other logins to add ours is not a default anyone consented to.
 *
 * The same argument applies one level down, and it did not used to: this wrote
 * a single-element `models` array, so saving a model id through the settings
 * form deleted every other model the user had listed under that provider. A
 * catalog is not ours to prune either. The saved id leads the array — that
 * position is what `readModelEntry` reports and therefore what a session opens
 * — and the rest follow in their existing order, with any stale copy of the
 * saved id removed so the same model cannot appear twice.
 */
function writeProviderEntry(
  agentDir: string,
  provider: string,
  baseUrl: string,
  modelId: string,
): void {
  mkdirSync(agentDir, { recursive: true });
  const modelsPath = join(agentDir, "models.json");
  const models: Record<string, unknown> = existsSync(modelsPath)
    ? (JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, unknown>)
    : {};
  const providers = (
    typeof models.providers === "object" && models.providers !== null
      ? models.providers
      : {}
  ) as Record<string, unknown>;
  const existing = providers[provider];
  const priorModels =
    typeof existing === "object" && existing !== null && Array.isArray((existing as { models?: unknown }).models)
      ? ((existing as { models: unknown[] }).models)
      : [];
  // A hand-written entry for this id keeps whatever the user tuned on it
  // (context window, real costs); only its position changes. Absent that, the
  // generated shape is the fallback.
  const saved = priorModels.find((entry) => entryModelId(entry) === modelId) ?? generatedModelEntry(modelId);
  const siblings = priorModels.filter((entry) => entryModelId(entry) !== modelId);
  providers[provider] = {
    baseUrl,
    api: "openai-completions",
    models: [saved, ...siblings],
  };
  models.providers = providers;
  writeJsonAtomic(modelsPath, models);
}

/**
 * The credential half alone: one provider's `auth.json` entry, rewritten while
 * every other provider the user has configured is preserved. An empty key
 * removes the entry — the one write that can undo a credential, so it is the
 * settings row for a keyless deployment, never a silent side effect.
 */
export function writeProviderCredential(agentDir: string, provider: string, key: string): void {
  mkdirSync(agentDir, { recursive: true });
  const authPath = join(agentDir, "auth.json");
  const auth: Record<string, unknown> = existsSync(authPath)
    ? (JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>)
    : {};
  if (key.length === 0) delete auth[provider];
  else auth[provider] = { type: "api_key", key };
  writeJsonAtomic(authPath, auth);
}

export function writeModelConfiguration(
  agentDir: string,
  provider: string,
  answers: FirstRunAnswers,
): void {
  writeProviderEntry(agentDir, provider, answers.baseUrl, answers.modelId);
  writeProviderCredential(agentDir, provider, answers.apiKey);
}

/**
 * Rewrites the endpoint half (models.json) and leaves the credential half
 * (auth.json) exactly as it stands. A user moving where the model is reached
 * must not have to re-enter their key — and since this module deliberately
 * cannot read the key's value back out, a flow that required restating it could
 * not even be built correctly. Settings-panel edits of base URL and model id
 * go through here for exactly that reason.
 */
export function writeModelEndpoint(
  agentDir: string,
  provider: string,
  endpoint: { readonly baseUrl: string; readonly modelId: string },
): void {
  writeProviderEntry(agentDir, provider, endpoint.baseUrl, endpoint.modelId);
}
