import { describe, expect, it } from "bun:test";
import {
  createResidentAgent,
  residentAgentSystemPrompt,
  senseExtension,
  type ResidentSession,
  type SenseBuffer,
} from "../src/resident-agent.js";
import { emptyWorldState, type WorldState } from "../src/protocol.js";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * What `pi.on("context", …)` hands back: either messages to inject, or nothing.
 * Spelled locally because these tests call the handler directly rather than
 * through a live Pi, and the handler's contract is the thing being asserted.
 */
type ContextHandler = () => { messages?: unknown[] } | undefined;

/**
 * The factory out of an `InlineExtension`.
 *
 * The type is a union — a bare factory function, or an object carrying one under
 * `name`/`hidden` — so reaching for `.factory` unconditionally does not typecheck
 * even when the value in hand is the object form. Narrowing here keeps that
 * detail out of every test body.
 */
function extensionFactory(extension: InlineExtension): (pi: ExtensionAPI) => void {
  return typeof extension === "function" ? extension : extension.factory;
}

/**
 * A fake session that records calls and returns canned assistant text.
 * Mirrors the whole repo's posture: no test spins a real ModelRuntime.
 */
function fakeSession(opts: {
  readonly assistantText?: string;
  readonly promptError?: Error;
}): ResidentSession & {
  readonly calls: {
    prompt: string[];
    observe: { customType: string; content: string }[];
    waitForIdle: number;
    abort: number;
    dispose: number;
  };
} {
  const calls = {
    prompt: [] as string[],
    observe: [] as { customType: string; content: string }[],
    waitForIdle: 0,
    abort: 0,
    dispose: 0,
  };
  let disposed = false;
  return {
    calls,
    async prompt(text: string): Promise<void> {
      if (disposed) throw new Error("session disposed");
      calls.prompt.push(text);
      if (opts.promptError !== undefined) throw opts.promptError;
    },
    async observe(customType: string, content: string): Promise<void> {
      if (disposed) throw new Error("session disposed");
      calls.observe.push({ customType, content });
    },
    async waitForIdle(): Promise<void> {
      calls.waitForIdle += 1;
    },
    async abort(): Promise<void> {
      calls.abort += 1;
    },
    getLastAssistantText(): string | undefined {
      return opts.assistantText;
    },
    dispose(): void {
      disposed = true;
      calls.dispose += 1;
    },
  };
}

describe("residentAgentSystemPrompt", () => {
  it("states the agent is resident and acts with minimal change", () => {
    const prompt = residentAgentSystemPrompt();
    expect(prompt).toContain("resident agent");
    expect(prompt).toContain("stay alive");
    expect(prompt).toContain("smallest change");
  });
});

describe("createResidentAgent", () => {
  it("prompts the session and surfaces the assistant reply", async () => {
    const session = fakeSession({ assistantText: "ok" });
    const agent = await createResidentAgent({
      systemPrompt: "p",
      cwd: ".",
      createSession: async () => session,
    });

    await agent.prompt("reply ok");
    expect(session.calls.prompt).toEqual(["reply ok"]);
    expect(agent.getLastAssistantText()).toBe("ok");

    agent.dispose();
    expect(session.calls.dispose).toBe(1);
  });

  it("preserves history: the second prompt reaches the same session", async () => {
    const session = fakeSession({ assistantText: "second" });
    const agent = await createResidentAgent({
      systemPrompt: "p",
      cwd: ".",
      createSession: async () => session,
    });

    await agent.prompt("first");
    await agent.prompt("second");
    expect(session.calls.prompt).toEqual(["first", "second"]);
  });

  it("waitForIdle and abort delegate to the session", async () => {
    const session = fakeSession({});
    const agent = await createResidentAgent({
      systemPrompt: "p",
      cwd: ".",
      createSession: async () => session,
    });

    await agent.waitForIdle();
    await agent.abort();
    expect(session.calls.waitForIdle).toBe(1);
    expect(session.calls.abort).toBe(1);
  });

  it("throws after dispose on any further call", async () => {
    const session = fakeSession({});
    const agent = await createResidentAgent({
      systemPrompt: "p",
      cwd: ".",
      createSession: async () => session,
    });

    agent.dispose();
    // dispose is idempotent: the session is disposed once, the second call is a no-op.
    expect(session.calls.dispose).toBe(1);
    agent.dispose();
    expect(session.calls.dispose).toBe(1);
    // …but every other method refuses after disposal.
    await expect(agent.prompt("late")).rejects.toThrow();
    await expect(agent.waitForIdle()).rejects.toThrow();
    expect(() => agent.getLastAssistantText()).toThrow();
  });
});

describe("createResidentAgent history", () => {
  it("leaves the history choice to the factory when the caller states none", async () => {
    const specs: { readonly history?: string }[] = [];
    await createResidentAgent({
      systemPrompt: "p",
      cwd: ".",
      createSession: async (spec) => {
        specs.push(spec);
        return fakeSession({});
      },
    });

    // Absent, not "memory": the default factory turns absence into `continue`,
    // and a value passed here would override that. The agent's session history is
    // the audit trail, so an in-memory default would mean a durable run kept no
    // record of what the agent did.
    expect(specs).toHaveLength(1);
    expect(specs[0]!.history).toBeUndefined();
  });

  it("forwards an explicit history choice, which is how tests stay in memory", async () => {
    const specs: { readonly history?: string }[] = [];
    await createResidentAgent({
      systemPrompt: "p",
      cwd: ".",
      history: "memory",
      createSession: async (spec) => {
        specs.push(spec);
        return fakeSession({});
      },
    });

    expect(specs[0]!.history).toBe("memory");
  });
});

describe("createResidentAgent observe", () => {
  it("appends an observation without triggering a turn", async () => {
    const session = fakeSession({});
    const agent = await createResidentAgent({
      systemPrompt: "p",
      cwd: ".",
      createSession: async () => session,
    });

    const state: WorldState = {
      ...emptyWorldState(),
      lastEventKind: "window_changed",
      updatedAt: "2026-08-26T00:00:00Z",
    };
    await agent.observe(state);

    // Exactly one observe call — no prompt, no turn.
    expect(session.calls.prompt).toHaveLength(0);
    expect(session.calls.observe).toHaveLength(1);
    const breadcrumb = session.calls.observe[0]!;
    expect(breadcrumb.customType).toBe("observation");
    // The breadcrumb records the event kind and the time.
    expect(breadcrumb.content).toContain("window_changed");
    expect(breadcrumb.content).toContain("2026-08-26T00:00:00Z");
  });

  it("refuses after dispose", async () => {
    const session = fakeSession({});
    const agent = await createResidentAgent({
      systemPrompt: "p",
      cwd: ".",
      createSession: async () => session,
    });

    agent.dispose();
    await expect(agent.observe(emptyWorldState())).rejects.toThrow();
  });
});

describe("senseExtension", () => {
  it("injects nothing when no state has been observed yet", () => {
    const buffer: SenseBuffer = { state: null, tools: [] };
    const ext = senseExtension(buffer);
    // The factory is the inline-extension body; invoke it with a fake pi that
    // records the context handler so we can call it back directly.
    let contextHandler: ContextHandler | undefined;
    const fakePi = {
      on(event: string, handler: ContextHandler): void {
        if (event === "context") contextHandler = handler;
      },
    };
    extensionFactory(ext)(fakePi as never);
    expect(contextHandler).toBeDefined();
    expect(contextHandler!()).toBeUndefined();
  });

  it("injects a custom sense message once state is present", () => {
    const buffer: SenseBuffer = {
      state: {
        ...emptyWorldState(),
        lastEventKind: "focus_changed",
        updatedAt: "2026-08-26T00:00:00Z",
      },
      tools: [],
    };
    const ext = senseExtension(buffer);
    let contextHandler: ContextHandler | undefined;
    const fakePi = {
      on(event: string, handler: ContextHandler): void {
        if (event === "context") contextHandler = handler;
      },
    };
    extensionFactory(ext)(fakePi as never);

    const result = contextHandler!();
    expect(result).toBeDefined();
    expect(result!.messages).toHaveLength(1);
    const msg = result!.messages![0] as {
      role: string;
      customType: string;
      content: string;
      display: boolean;
    };
    expect(msg.role).toBe("custom");
    expect(msg.customType).toBe("sense");
    expect(msg.display).toBe(false);
    expect(msg.content).toContain("# Current world state");
    expect(msg.content).toContain("focus_changed");
  });
});
