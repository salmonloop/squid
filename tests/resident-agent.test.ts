import { describe, expect, it } from "bun:test";
import {
  createResidentAgent,
  residentAgentSystemPrompt,
  type ResidentSession,
} from "../src/resident-agent.js";

/**
 * A fake session that records calls and returns canned assistant text.
 * Mirrors the whole repo's posture: no test spins a real ModelRuntime.
 */
function fakeSession(opts: {
  readonly assistantText?: string;
  readonly promptError?: Error;
}): ResidentSession & {
  readonly calls: { prompt: string[]; waitForIdle: number; abort: number; dispose: number };
} {
  const calls = { prompt: [] as string[], waitForIdle: 0, abort: 0, dispose: 0 };
  let disposed = false;
  return {
    calls,
    async prompt(text: string): Promise<void> {
      if (disposed) throw new Error("session disposed");
      calls.prompt.push(text);
      if (opts.promptError !== undefined) throw opts.promptError;
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
