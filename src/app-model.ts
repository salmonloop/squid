import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

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
 */
function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.squid-first-run.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

export function writeModelConfiguration(
  agentDir: string,
  provider: string,
  answers: FirstRunAnswers,
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
  providers[provider] = {
    baseUrl: answers.baseUrl,
    api: "openai-completions",
    models: [
      {
        id: answers.modelId,
        name: answers.modelId,
        reasoning: true,
        input: ["text"],
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
        // Usage accounting shows zero cost until the user edits the entry;
        // guessing a price would be worse than showing none.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
  models.providers = providers;
  writeJsonAtomic(modelsPath, models);

  const authPath = join(agentDir, "auth.json");
  const auth: Record<string, unknown> = existsSync(authPath)
    ? (JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>)
    : {};
  auth[provider] = { type: "api_key", key: answers.apiKey };
  writeJsonAtomic(authPath, auth);
}
