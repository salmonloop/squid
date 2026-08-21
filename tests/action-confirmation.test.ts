import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { TerminalActionConfirmation } from "../src/action-confirmation.js";
import type { CapabilityActionPlan } from "../src/action-plan.js";

const plan: CapabilityActionPlan = {
  kind: "run_tests",
  tool: "run_command",
  arguments: { command: "cd /workspace && bun test -- tests/foo.test.ts" },
  summary: "cd /workspace && bun test -- tests/foo.test.ts",
  confirmation: "required",
};

const request = (expiresAt: string) => ({ candidateId: "req:candidate:0", plan, expiresAt });

describe("TerminalActionConfirmation", () => {
  it("accepts only an explicit yes and shows the exact planned command", async () => {
    let message = "";
    const confirmation = new TerminalActionConfirmation({
      interactive: true,
      prompt: async (value) => {
        message = value;
        return "yes";
      },
    });

    const decision = await confirmation.confirm(request("2030-01-01T00:01:00.000Z"));

    expect(decision).toEqual({ outcome: "accepted", reason: "user_accepted" });
    expect(message).toContain(plan.summary);
  });

  it("treats empty and arbitrary input as rejection", async () => {
    for (const answer of ["", "n", "maybe"]) {
      const confirmation = new TerminalActionConfirmation({
        interactive: true,
        prompt: async () => answer,
      });
      expect(await confirmation.confirm(request("2030-01-01T00:01:00.000Z")))
        .toEqual({ outcome: "rejected", reason: "user_rejected" });
    }
  });

  it("fails closed without an interactive terminal", async () => {
    const confirmation = new TerminalActionConfirmation({
      input: new PassThrough(),
      output: new PassThrough(),
    });
    expect(await confirmation.confirm(request("2030-01-01T00:01:00.000Z")))
      .toEqual({ outcome: "rejected", reason: "non_interactive" });
  });

  it("never prompts for an already-expired candidate", async () => {
    let prompted = false;
    const confirmation = new TerminalActionConfirmation({
      interactive: true,
      now: () => new Date("2030-01-01T00:00:01.000Z"),
      prompt: async () => {
        prompted = true;
        return "yes";
      },
    });
    expect(await confirmation.confirm(request("2030-01-01T00:00:00.000Z")))
      .toEqual({ outcome: "expired", reason: "candidate_expired" });
    expect(prompted).toBe(false);
  });

  it("times out as a rejection", async () => {
    const confirmation = new TerminalActionConfirmation({
      interactive: true,
      timeoutMs: 5,
      // A third-party prompt adapter may ignore AbortSignal. The policy still
      // owns the deadline and must settle without waiting for that adapter.
      prompt: () => new Promise(() => undefined),
    });
    expect(await confirmation.confirm(request(new Date(Date.now() + 10_000).toISOString())))
      .toEqual({ outcome: "rejected", reason: "timed_out" });
  });

  it("reports expiry when the candidate deadline wins even if the clock is injected", async () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const confirmation = new TerminalActionConfirmation({
      interactive: true,
      timeoutMs: 100,
      now: () => now,
      prompt: () => new Promise(() => undefined),
    });
    expect(await confirmation.confirm(request("2030-01-01T00:00:00.005Z")))
      .toEqual({ outcome: "expired", reason: "candidate_expired" });
  });

  it("serializes prompts so two commands cannot compete for stdin", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const confirmation = new TerminalActionConfirmation({
      interactive: true,
      prompt: async () => {
        calls += 1;
        order.push(`start-${calls}`);
        if (calls === 1) await firstDone;
        order.push(`end-${calls}`);
        return "n";
      },
    });

    const first = confirmation.confirm(request("2030-01-01T00:01:00.000Z"));
    const second = confirmation.confirm(request("2030-01-01T00:01:00.000Z"));
    await Promise.resolve();
    expect(order).toEqual(["start-1"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("close aborts the active prompt and waits for it to settle", async () => {
    const confirmation = new TerminalActionConfirmation({
      interactive: true,
      // Shutdown must not depend on a prompt adapter honoring cancellation.
      prompt: () => new Promise(() => undefined),
    });
    const pending = confirmation.confirm(request("2030-01-01T00:01:00.000Z"));
    await Promise.resolve();

    await confirmation.close();

    expect(await pending).toEqual({ outcome: "rejected", reason: "input_closed" });
  });
});
