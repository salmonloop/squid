import type { AgentSession, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  createPiSession,
  resolveModel,
  resolvePiModel,
  startPiModelRuntime,
  type ModelRuntime,
  type PiSessionHandle,
} from "./pi-session-factory.js";

/**
 * The resident agent: one long-lived Pi session that is the system's subject.
 *
 * Where the old architecture spun up a fresh Pi session for each prediction,
 * each belief query, and each execution — three one-shot puppets whose strings
 * Squid held — this is one agent that stays alive. It is prompted with what the
 * senses saw; it chooses which tool to call; guards intercept every call before
 * it lands; audit records every call after. The session's history *is* the
 * agent's memory.
 *
 * This module owns only the lifecycle shell — prompt, idle, abort, dispose —
 * and the session's creation. What the agent is allowed to see and do arrives
 * through inline extensions (sense injection, guards, audit), wired in
 * `createResidentAgent` and added in later phases. Phase 0 wires none of them:
 * a skeleton that can hold a conversation and nothing more.
 */

/** The slice of `AgentSession` a resident agent drives. Narrowed for testability. */
export interface ResidentSession {
  prompt(text: string): Promise<void>;
  waitForIdle(): Promise<void>;
  abort(): Promise<void>;
  getLastAssistantText(): string | undefined;
  dispose(): void;
}

/**
 * Creates the real Pi session for a resident agent. Exported as a seam so tests
 * can substitute a fake — the whole repo avoids live `ModelRuntime`, and this
 * agent is no exception. The real factory is the default; tests pass their own.
 */
export type ResidentSessionFactory = (spec: {
  readonly systemPrompt: string;
  readonly cwd: string;
  readonly extensionFactories?: readonly InlineExtension[];
}) => Promise<ResidentSession>;

/** The default factory: resolves the model and builds a persistent in-memory session. */
export const createDefaultResidentSession: ResidentSessionFactory = async (spec) => {
  const modelRuntime = await startPiModelRuntime();
  const { provider, modelId } = resolvePiModel({});
  const model = resolveModel(modelRuntime, provider, modelId);
  if (model === null) {
    throw new Error(`No resident-agent model is configured: ${provider}/${modelId}`);
  }
  const handle = await createPiSession({
    model,
    modelRuntime,
    cwd: spec.cwd,
    systemPrompt: spec.systemPrompt,
    ...(spec.extensionFactories !== undefined
      ? { extensionFactories: spec.extensionFactories }
      : {}),
  });
  return adaptHandle(handle);
};

/** Adapts a `PiSessionHandle` to the narrowed `ResidentSession` surface. */
function adaptHandle(handle: PiSessionHandle): ResidentSession {
  return {
    prompt: (text) => handle.session.prompt(text),
    waitForIdle: () => handle.session.waitForIdle(),
    abort: () => handle.session.abort(),
    getLastAssistantText: () => handle.session.getLastAssistantText(),
    dispose: () => handle.dispose(),
  };
}

export interface CreateResidentAgentOptions {
  /** The system prompt that defines the agent's identity and posture. */
  readonly systemPrompt: string;
  /** The working directory the agent acts in. */
  readonly cwd: string;
  /** Inline extensions (guards, senses, audit) wired at creation. Phase 0: empty. */
  readonly extensionFactories?: readonly InlineExtension[];
  /** Injected in tests; defaults to the real Pi-backed factory. */
  readonly createSession?: ResidentSessionFactory;
}

export interface ResidentAgent {
  /** Send a prompt; the agent's history is preserved across calls. */
  prompt(text: string): Promise<void>;
  /** Wait for the agent to finish the current turn. */
  waitForIdle(): Promise<void>;
  /** Abort the current operation and return to idle. */
  abort(): Promise<void>;
  /** The agent's last assistant reply, if any. */
  getLastAssistantText(): string | undefined;
  /** Tear down the session. After this, further calls throw. */
  dispose(): void;
}

/**
 * Builds a resident agent around one persistent session.
 *
 * The session is created eagerly so a configuration error (no model) surfaces
 * at construction, not on the first prompt — the same reason `ProcessCapabilityGateway`
 * starts its model runtime in the constructor.
 */
export async function createResidentAgent(
  options: CreateResidentAgentOptions,
): Promise<ResidentAgent> {
  const factory = options.createSession ?? createDefaultResidentSession;
  const session = await factory({
    systemPrompt: options.systemPrompt,
    cwd: options.cwd,
    ...(options.extensionFactories !== undefined
      ? { extensionFactories: options.extensionFactories }
      : {}),
  });

  let disposed = false;
  const guardLive = (): void => {
    if (disposed) throw new Error("ResidentAgent has been disposed.");
  };

  return {
    async prompt(text: string): Promise<void> {
      guardLive();
      await session.prompt(text);
    },
    async waitForIdle(): Promise<void> {
      guardLive();
      await session.waitForIdle();
    },
    async abort(): Promise<void> {
      guardLive();
      await session.abort();
    },
    getLastAssistantText(): string | undefined {
      guardLive();
      return session.getLastAssistantText();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      session.dispose();
    },
  };
}

/** The resident agent's system prompt, parameterized by what it is allowed to know. */
export function residentAgentSystemPrompt(): string {
  return [
    "You are Squid's resident agent.",
    "You stay alive across many turns; your conversation history is your memory.",
    "You are told what the system's sensors observed, and you choose which tools to call.",
    "Stay inside the working directory you were started in unless a task names elsewhere.",
    "Prefer the smallest change that completes the task; do not fix unrelated problems you notice.",
    "When you have acted, report concisely what you did; when there is nothing to do, say nothing and stop.",
  ].join("\n");
}
