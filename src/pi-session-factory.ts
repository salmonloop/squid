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

/** Resolves the provider/model id pair against env defaults, exactly as each caller did. */
export function resolvePiModel(options: PiModelOptions): {
  readonly provider: string;
  readonly modelId: string;
} {
  return {
    provider: options.provider ?? process.env.PI_MODEL_PROVIDER ?? "bifrost",
    modelId: options.modelId ?? process.env.PI_MODEL_ID ?? "deepseek-v4-flash",
  };
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
