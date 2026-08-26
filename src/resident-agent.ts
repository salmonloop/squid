import type { AgentSession, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  createPiSession,
  resolveModel,
  resolvePiModel,
  startPiModelRuntime,
  type ModelRuntime,
  type PiSessionHandle,
} from "./pi-session-factory.js";
import { sensePromptLines } from "./agent-senses.js";
import type { ToolSummary } from "./tool-catalog.js";
import type { WorldState } from "./protocol.js";

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
  /**
   * Append an observation to the session history without triggering a turn.
   * The agent sees it as context on its next prompt — this is how senses feed
   * memory: a running log of what happened, not an interruption.
   */
  observe(customType: string, content: string): Promise<void>;
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
    observe: (customType, content) =>
      handle.session.sendCustomMessage(
        { customType, content, display: false },
        { triggerTurn: false },
      ),
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
  /** The tool catalog the agent sees in every context injection. */
  readonly tools?: readonly ToolSummary[];
  /** Injected in tests; defaults to the real Pi-backed factory. */
  readonly createSession?: ResidentSessionFactory;
}

/**
 * The mutable sense buffer a resident agent holds between observations.
 * `observe` updates it; the `on("context")` hook reads it before every LLM call
 * to inject the current world-state snapshot. Separated so the hook closure can
 * be constructed once (at session creation) yet always see fresh state.
 */
export interface SenseBuffer {
  state: WorldState | null;
  tools: readonly ToolSummary[];
}

/**
 * Builds the inline extension that injects the current sense snapshot before
 * every LLM call. The agent reads "what the world looks like right now" each
 * time it thinks — not a stale snapshot from the last prompt.
 *
 * The injected message is a `custom` message (not a user message): it is system-
 * supplied context, not something the user said. `convertToLlm` renders custom
 * messages as user-role content for the LLM, so the model sees them.
 */
export function senseExtension(buffer: SenseBuffer): InlineExtension {
  return {
    name: "squid-senses",
    hidden: true,
    factory: (pi) => {
      pi.on("context", () => {
        if (buffer.state === null) return;
        const lines = sensePromptLines(buffer.state, buffer.tools);
        return {
          messages: [
            {
              role: "custom",
              customType: "sense",
              content: lines.join("\n"),
              display: false,
              timestamp: 0,
            },
          ],
        };
      });
    },
  };
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
  /**
   * Feed the agent a new world-state snapshot. Updates the live sense buffer
   * (so the next LLM call sees it) and appends a one-line observation to the
   * session history (so the agent remembers the event happened). Does not
   * trigger a turn — the agent acts on its next prompt.
   */
  observe(state: WorldState): Promise<void>;
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
  // The sense buffer lives outside the session so the on("context") hook —
  // constructed once at session creation — always reads fresh state. observe()
  // writes here; the hook reads here.
  const senseBuffer: SenseBuffer = {
    state: null,
    tools: options.tools ?? [],
  };

  const extensions: InlineExtension[] = [
    senseExtension(senseBuffer),
    ...(options.extensionFactories ?? []),
  ];

  const factory = options.createSession ?? createDefaultResidentSession;
  const session = await factory({
    systemPrompt: options.systemPrompt,
    cwd: options.cwd,
    extensionFactories: extensions,
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
    async observe(state: WorldState): Promise<void> {
      guardLive();
      senseBuffer.state = state;
      // A one-line observation appended to history: the event kind and the
      // time. The full state is in the context injection; the history line is
      // the breadcrumb the agent can refer back to after the snapshot moves on.
      const summary = state.lastEventKind ?? "state_update";
      await session.observe("observation", `${summary} @ ${state.updatedAt ?? "(unknown)"}`);
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
