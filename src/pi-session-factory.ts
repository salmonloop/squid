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
 * Three callers — `PiRuntime` (prediction), `PiBeliefProvider` (belief), and
 * `ProcessCapabilityGateway` (execution) — each built the same chain by hand:
 * resolve the model, load resources with a per-call system prompt, create an
 * in-memory session at `thinkingLevel: "low"`, and bind disposal to an abort
 * signal. The differences between them are small and named below; the
 * repetition was not small and was the thing worth removing.
 *
 * What this module does not own: the `ModelRuntime` instance. That is started
 * once per provider object (constructor) and awaited across every call on it,
 * so it stays the caller's field. This module owns the per-call session only.
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
   * Inline extensions wired into the resource loader — the mount point for guard,
   * sense, and audit hooks on a long-lived resident agent. One-shot callers omit it.
   */
  readonly extensionFactories?: readonly InlineExtension[];
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
    sessionManager: SessionManager.inMemory(),
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
