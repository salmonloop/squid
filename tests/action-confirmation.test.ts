import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import {
  SerialConfirmationPolicy,
  toConfirmationPrompt,
  type ConfirmationAnswer,
  type ConfirmationPrompt,
  type ConfirmationSurface,
} from "../src/action-confirmation.js";
import {
  TerminalConfirmationSurface,
  createTerminalActionConfirmation,
  type TerminalConfirmationSurfaceOptions,
} from "../src/confirmation-surface-terminal.js";
import type { CapabilityActionPlan } from "../src/action-plan.js";
import {
  describeConfirmationSurfaceConformance,
  type SurfaceHarness,
} from "./confirmation-surface-conformance.js";

const plan: CapabilityActionPlan = {
  kind: "run_tests",
  tool: "run_command",
  arguments: { command: "cd /workspace && bun test -- tests/foo.test.ts" },
  summary: "cd /workspace && bun test -- tests/foo.test.ts",
  confirmation: "required",
};

const request = (expiresAt: string) => ({ candidateId: "req:candidate:0", plan, expiresAt });
const FAR_FUTURE = "2030-01-01T00:01:00.000Z";

/**
 * Drives the terminal surface through the shared matrix.
 *
 * The prompt function is injected rather than a fake TTY: what needs verifying is
 * the surface's own behavior — allowlist parsing, availability, the message it
 * builds — not Node's readline.
 */
describeConfirmationSurfaceConformance("TerminalConfirmationSurface", async () => {
  let mode: "answer" | "hang" = "answer";
  let answer: "y" | "n" = "y";
  let available = true;

  // A getter rather than a fixed value, and it works only because
  // `available()` reads its options per call. That is the property the
  // contract requires — a window can close between two suggestions — so a
  // surface that cached this at construction would fail here.
  const options: TerminalConfirmationSurfaceOptions = {
    get interactive(): boolean {
      return available;
    },
    prompt: async () => {
      if (mode === "hang") return new Promise<string>(() => undefined);
      return answer;
    },
  };
  const surface = new TerminalConfirmationSurface(options);

  const harness: SurfaceHarness = {
    surface,
    answer: (value) => {
      mode = "answer";
      answer = value;
    },
    hang: () => {
      mode = "hang";
    },
    makeUnavailable: () => {
      available = false;
    },
    dispose: async () => undefined,
  };
  return harness;
});

describe("TerminalConfirmationSurface", () => {
  it("shows the exact planned command it would run", async () => {
    let shown = "";
    const surface = new TerminalConfirmationSurface({
      interactive: true,
      prompt: async (message) => {
        shown = message;
        return "yes";
      },
    });

    const decision = await surface.ask(
      toConfirmationPrompt(request(FAR_FUTURE)),
      new AbortController().signal,
    );

    expect(decision).toBe("approved");
    expect(shown).toContain(plan.summary);
  });

  it("approves only an explicit yes", async () => {
    for (const [input, expected] of [
      ["y", "approved"],
      ["yes", "approved"],
      ["YES", "approved"],
      ["  y  ", "approved"],
      ["", "declined"],
      ["n", "declined"],
      ["maybe", "declined"],
      // An allowlist, so a partial match is still a decline: a fat-fingered
      // keypress must not be able to execute a command.
      ["ye", "declined"],
      ["yep", "declined"],
    ] as const) {
      const surface = new TerminalConfirmationSurface({
        interactive: true,
        prompt: async () => input,
      });
      expect(await surface.ask(
        toConfirmationPrompt(request(FAR_FUTURE)),
        new AbortController().signal,
      )).toBe(expected as ConfirmationAnswer);
    }
  });

  it("reports itself unavailable without a TTY", () => {
    const surface = new TerminalConfirmationSurface({
      input: new PassThrough(),
      output: new PassThrough(),
    });
    // A pipe that never closes would otherwise hold a claim until the deadline.
    expect(surface.available()).toBe(false);
  });
});

/**
 * Engine behavior that is not about any one surface.
 *
 * These belong here rather than in the conformance suite because they are
 * properties of `SerialConfirmationPolicy` itself: a surface cannot change them,
 * and running them once per surface would only restate the same guarantee.
 */
describe("SerialConfirmationPolicy", () => {
  function stubSurface(
    ask: (prompt: ConfirmationPrompt, signal: AbortSignal) => Promise<ConfirmationAnswer>,
    options: { readonly available?: boolean; readonly onClose?: () => void } = {},
  ): ConfirmationSurface {
    return {
      id: "stub",
      available: () => options.available ?? true,
      ask,
      ...(options.onClose === undefined ? {} : { close: async () => options.onClose?.() }),
    };
  }

  it("rejects a non-positive timeout at construction", () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => new SerialConfirmationPolicy({
        surface: stubSurface(async () => "approved"),
        timeoutMs,
      })).toThrow(TypeError);
    }
  });

  it("treats a throwing surface as a refusal, never as consent", async () => {
    // A crashed prompt is the case that matters most: if a thrown error read as
    // approval, a broken UI would authorize commands.
    const policy = new SerialConfirmationPolicy({
      surface: stubSurface(async () => {
        throw new Error("surface closed unexpectedly");
      }),
    });
    expect(await policy.confirm(request(FAR_FUTURE)))
      .toEqual({ outcome: "rejected", reason: "input_closed" });
    await policy.close();
  });

  it("propagates a surface defect rather than silently refusing", async () => {
    // Distinct from the case above. "The human went away" is expected and
    // refuses cleanly; a programming error must not be laundered into a routine
    // refusal, or a broken surface would look like a user who kept saying no.
    const policy = new SerialConfirmationPolicy({
      surface: stubSurface(async () => {
        throw new TypeError("undefined is not a function");
      }),
    });
    await expect(policy.confirm(request(FAR_FUTURE))).rejects.toThrow(TypeError);
    await policy.close();
  });

  it("treats an unparseable expiry as expired", async () => {
    let asked = false;
    const policy = new SerialConfirmationPolicy({
      surface: stubSurface(async () => {
        asked = true;
        return "approved";
      }),
    });
    expect(await policy.confirm(request("not-a-timestamp")))
      .toEqual({ outcome: "expired", reason: "candidate_expired" });
    expect(asked).toBe(false);
    await policy.close();
  });

  it("closes the surface when the policy closes", async () => {
    let closed = false;
    const policy = new SerialConfirmationPolicy({
      surface: stubSurface(async () => "declined", { onClose: () => { closed = true; } }),
    });
    await policy.close();
    expect(closed).toBe(true);
  });

  it("exposes the surface id so a banner can name the surface in use", () => {
    const policy = new SerialConfirmationPolicy({ surface: stubSurface(async () => "declined") });
    expect(policy.surfaceId).toBe("stub");
  });

  it("hands the surface a prompt with no plan arguments in it", async () => {
    let seen: ConfirmationPrompt | undefined;
    const policy = new SerialConfirmationPolicy({
      surface: stubSurface(async (prompt) => {
        seen = prompt;
        return "declined";
      }),
    });
    await policy.confirm(request(FAR_FUTURE));
    // Type-level, not conventional: `ConfirmationPrompt` has no `arguments`
    // member, so a surface cannot render the selection even by mistake.
    expect(seen).toEqual({
      candidateId: "req:candidate:0",
      kind: "run_tests",
      summary: plan.summary,
      expiresAt: FAR_FUTURE,
    });
    await policy.close();
  });

  it("keeps serving later candidates after one surface failure", async () => {
    // One bad prompt must not wedge the queue: the dispatch loop stays alive
    // across a transient surface fault.
    let calls = 0;
    const policy = new SerialConfirmationPolicy({
      surface: stubSurface(async () => {
        calls += 1;
        if (calls === 1) throw new Error("surface closed");
        return "approved";
      }),
    });
    expect((await policy.confirm(request(FAR_FUTURE))).outcome).toBe("rejected");
    expect(await policy.confirm(request(FAR_FUTURE)))
      .toEqual({ outcome: "accepted", reason: "user_accepted" });
    await policy.close();
  });
});

describe("createTerminalActionConfirmation", () => {
  it("composes the terminal surface with the shared engine", async () => {
    const policy = createTerminalActionConfirmation({
      interactive: true,
      prompt: async () => "y",
    });
    expect(policy.surfaceId).toBe("terminal");
    expect(await policy.confirm(request(FAR_FUTURE)))
      .toEqual({ outcome: "accepted", reason: "user_accepted" });
    await policy.close();
  });

  it("passes the timeout through to the engine", async () => {
    const policy = createTerminalActionConfirmation({
      interactive: true,
      timeoutMs: 5,
      prompt: () => new Promise(() => undefined),
    });
    expect(await policy.confirm(request(new Date(Date.now() + 10_000).toISOString())))
      .toEqual({ outcome: "rejected", reason: "timed_out" });
    await policy.close();
  });
});
