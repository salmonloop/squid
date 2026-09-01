import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { readModelEntry } from "./app-model.js";

export type { ModelRuntime, InlineExtension };

/**
 * The shared spine of every Squid-Pi session.
 *
 * It was written when three callers — prediction, belief, and execution — each
 * built the same chain by hand and threw the session away afterwards. Those
 * callers are gone; the resident agent is the one that remains, and it keeps its
 * session for the life of the run. The spine is unchanged because the setup was
 * never what differed: resolve the model, load resources with a system prompt,
 * create a session at `thinkingLevel: "low"`, bind disposal to an abort signal.
 *
 * What this module does not own: the `ModelRuntime` instance. That is started
 * once by whoever holds the session and awaited across every call on it, so it
 * stays the caller's field. This module owns session construction only.
 */

export interface PiModelOptions {
  readonly provider?: string;
  readonly modelId?: string;
}

/**
 * Resolves the provider/model id pair against env defaults, exactly as each
 * caller did.
 *
 * The `modelId` here is a **default**, not the answer to "which model is
 * configured". It is what a write falls back to when nothing is stored yet and
 * what first-run offers as a suggestion. Which model a live session opens is
 * whatever the settings form last wrote into Pi's `models.json` — read that
 * with `resolveConfiguredModel`, not this.
 */
export function resolvePiModel(options: PiModelOptions): {
  readonly provider: string;
  readonly modelId: string;
} {
  return {
    provider: options.provider ?? process.env.PI_MODEL_PROVIDER ?? "bifrost",
    modelId: options.modelId ?? process.env.PI_MODEL_ID ?? "deepseek-v4-flash",
  };
}

/**
 * The model a session should actually open: the id stored in Pi's `models.json`
 * for this provider, falling back to the default only when nothing is stored.
 *
 * This exists because the two were conflated, and the settings form is what
 * exposed it. Saving `modelId` rewrites the provider's `models.json` entry —
 * that file is Pi's store and the only place a model id belongs, so the write
 * was right. But a session resolved its model from `resolvePiModel`, i.e. from
 * the env default, and looked up an id the form had just replaced. The result
 * was a field that reported a successful save and then stopped the agent from
 * starting: `resolveModel` returned null for an id no longer in the catalog.
 *
 * Reading the stored entry is not a second source of truth; it is the first
 * one. A Squid-side copy of the model id would be the parallel store
 * `app-model.ts` exists to prevent.
 */
export function resolveConfiguredModel(
  agentDir: string,
  options: PiModelOptions = {},
): { readonly provider: string; readonly modelId: string } {
  const { provider, modelId: fallback } = resolvePiModel(options);
  // An explicit id is a caller that already knows which model it means -- a
  // test, an eval run -- and a file does not get to second-guess it. Only the
  // *default* defers to the store.
  if (options.modelId !== undefined) return { provider, modelId: options.modelId };
  const stored = readModelEntry(agentDir, provider);
  return { provider, modelId: stored?.modelId ?? fallback };
}

/** Starts the long-lived model runtime. One per provider instance. */
export function startPiModelRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({ allowModelNetwork: false });
}

/** The model a resolved runtime exposes, or null when it is not configured. */
export type ResolvedModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export function resolveModel(
  modelRuntime: ModelRuntime,
  provider: string,
  modelId: string,
): ResolvedModel | null {
  return modelRuntime.getModel(provider, modelId) ?? null;
}

export interface PiSessionSpec {
  readonly model: ResolvedModel;
  readonly modelRuntime: ModelRuntime;
  readonly cwd: string;
  readonly systemPrompt: string;
  /**
   * Prediction and belief close the ecosystem; execution leaves it open. Default
   * (omitted) is open — matching the executor, where skills/extensions/context
   * are how Pi widens what an action can do.
   */
  readonly noExtensions?: boolean;
  readonly noSkills?: boolean;
  readonly noContextFiles?: boolean;
  /** Custom tool allowlist + definitions, for the single-tool prediction/belief prompts. */
  readonly tools?: readonly string[];
  /**
   * Passed to Pi as `noTools`: `"all"` starts the session with no tools enabled
   * at all. The corpus eval wants that shape — a reading exercise where a tool
   * call is a wrong answer, and the model has demonstrated it will not obey
   * prose telling it so — while every other caller keeps its tools.
   */
  readonly noTools?: "all" | "builtin";
  readonly customTools?: readonly ToolDefinition[];
  /**
   * Inline extensions wired into the resource loader — the mount point for sense
   * injection on a long-lived resident agent. Transient callers omit it.
   */
  readonly extensionFactories?: readonly InlineExtension[];
  /**
   * Where the conversation is kept.
   *
   * `memory` (the default) keeps it in the process, which is what a test wants
   * and all the transient callers ever needed. `persist` writes it to Pi's
   * session directory for `cwd`, and `continue` reopens the most recent one
   * there — and that persistence is not a convenience: it is the audit trail.
   * The agent's tool calls live in its session history rather than in a ledger
   * Squid maintains beside it, so a durable run needs a durable session or the
   * record of what the agent did dies with the process.
   */
  readonly history?: "memory" | "persist" | "continue";
  /** When supplied, abort disposes the session; when omitted, the caller owns disposal. */
  readonly signal?: AbortSignal;
}

export interface PiSessionHandle {
  readonly session: AgentSession;
  /**
   * Abort the session (fire-and-forget, errors swallowed) and dispose it. Removes
   * the abort listener when one was wired. Idempotent — safe to call from the
   * abort listener, a pre-check, and a finally block.
   */
  dispose(): void;
}

/**
 * Builds one configured Pi session and returns it with a disposal handle.
 *
 * The caller drives the prompt and post-prompt logic; this module's job ends at
 * a session that is ready to prompt and guaranteed to be disposable. A pre-abort
 * check (throwing a caller-specific cancelled error) stays in the caller, because
 * the error type is the one thing that genuinely differs and is not this
 * module's to choose.
 */
export async function createPiSession(spec: PiSessionSpec): Promise<PiSessionHandle> {
  const loader = new DefaultResourceLoader({
    cwd: spec.cwd,
    agentDir: getAgentDir(),
    noPromptTemplates: true,
    noThemes: true,
    ...(spec.noExtensions === true ? { noExtensions: true } : {}),
    ...(spec.noSkills === true ? { noSkills: true } : {}),
    ...(spec.noContextFiles === true ? { noContextFiles: true } : {}),
    systemPrompt: spec.systemPrompt,
    appendSystemPrompt: [],
    ...(spec.extensionFactories !== undefined
      ? { extensionFactories: [...spec.extensionFactories] }
      : {}),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    model: spec.model,
    modelRuntime: spec.modelRuntime,
    resourceLoader: loader,
    thinkingLevel: "low",
    ...(spec.tools !== undefined ? { tools: [...spec.tools] } : {}),
    ...(spec.noTools !== undefined ? { noTools: spec.noTools } : {}),
    ...(spec.customTools !== undefined ? { customTools: [...spec.customTools] } : {}),
    sessionManager: resolveSessionManager(spec),
  });

  let disposed = false;
  let dispose = (): void => {
    if (disposed) return;
    disposed = true;
    session.abort().catch(() => undefined);
    session.dispose();
  };

  // An external abort aborts+disposes the session in one step. The caller's
  // pre-check handles the "already aborted" case with its own error; this
  // listener handles "aborts later, while the prompt is in flight".
  if (spec.signal !== undefined) {
    const signal = spec.signal;
    const onAbort = (): void => dispose();
    signal.addEventListener("abort", onAbort, { once: true });
    const disposeWithoutListener = dispose;
    dispose = (): void => {
      signal.removeEventListener("abort", onAbort);
      disposeWithoutListener();
    };
  }

  return { session, dispose };
}

/**
 * Picks the session store for one spec.
 *
 * `continue` reopens the most recent session under `cwd`, which is what a restart
 * of a long-running watch wants: the agent picks up the history it already has
 * rather than waking up amnesiac. `persist` always starts a fresh durable one.
 * Both write under Pi's own session directory — Squid does not choose the path,
 * because a second opinion about where sessions live is how two processes end up
 * disagreeing about which file is the record.
 */
function resolveSessionManager(spec: PiSessionSpec): SessionManager {
  switch (spec.history ?? "memory") {
    case "persist":
      return SessionManager.create(spec.cwd);
    case "continue":
      return SessionManager.continueRecent(spec.cwd);
    default:
      return SessionManager.inMemory(spec.cwd);
  }
}
