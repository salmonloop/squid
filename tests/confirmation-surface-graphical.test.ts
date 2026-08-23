import { describe, expect, it } from "bun:test";
import { SerialConfirmationPolicy } from "../src/action-confirmation.js";
import {
  GraphicalConfirmationSurface,
  createGraphicalActionConfirmation,
  type GraphicalTransport,
} from "../src/confirmation-surface-graphical.js";
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
 * Drives the graphical surface through the shared matrix.
 *
 * The transport is injected rather than a spawned binary: what needs verifying
 * is the surface's own behavior — availability delegation, the port→wire
 * mapping, the surface-closed error semantics — not the Slint renderer.
 */
describeConfirmationSurfaceConformance("GraphicalConfirmationSurface", async () => {
  let mode: "answer" | "hang" = "answer";
  let answer: "approved" | "declined" = "approved";
  let available = true;

  // A getter would not work here because the transport is an object the surface
  // holds a reference to; `available()` reads the closure variable per call,
  // which is the property the contract requires — a window can close between
  // two suggestions, and a surface that cached this at construction would fail.
  const transport: GraphicalTransport = {
    available: () => available,
    ask: async () => {
      if (mode === "hang") return new Promise<"approved" | "declined">(() => undefined);
      return answer;
    },
  };
  const surface = new GraphicalConfirmationSurface({ transport });

  const harness: SurfaceHarness = {
    surface,
    answer: (value) => {
      mode = "answer";
      // The UI has buttons, not a keyboard: "y" is the approve button, "n" the
      // decline button. There is no freeform normalization to test, only the
      // mapping the harness performs.
      answer = value === "y" ? "approved" : "declined";
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

describe("GraphicalConfirmationSurface", () => {
  it("passes the prompt summary to the transport and never the arguments", async () => {
    let seen: { readonly summary: string; readonly [key: string]: unknown } | undefined;
    const transport: GraphicalTransport = {
      available: () => true,
      ask: async (payload) => {
        seen = payload;
        return "approved";
      },
    };
    const surface = new GraphicalConfirmationSurface({ transport });

    await surface.ask(
      {
        candidateId: "req:candidate:0",
        kind: "run_tests",
        summary: plan.summary,
        expiresAt: FAR_FUTURE,
      },
      new AbortController().signal,
    );

    // The transport receives a `GraphicalPromptPayload`, which has no
    // `arguments` field — so a UI that rendered whatever it received could not
    // leak the selection even by accident.
    expect(seen?.summary).toBe(plan.summary);
    expect(seen).not.toHaveProperty("arguments");
  });

  it("delegates availability to the transport per call", () => {
    let reachable = true;
    const transport: GraphicalTransport = {
      available: () => reachable,
      ask: async () => "approved",
    };
    const surface = new GraphicalConfirmationSurface({ transport });

    expect(surface.available()).toBe(true);
    reachable = false;
    // A window that closed between two suggestions must read as unavailable on
    // the very next check, not on the next construction.
    expect(surface.available()).toBe(false);
  });

  it("maps a vanished transport to input_closed, never to consent", async () => {
    // A transport whose UI process died rejects with "surface closed". The
    // engine must read that as a refusal — a crashed window is not approval —
    // and the reason must be `input_closed`, the same reason the terminal
    // surface produces when its readline closes.
    const transport: GraphicalTransport = {
      available: () => true,
      ask: async () => {
        throw new Error("graphical UI surface closed: process exited");
      },
    };
    const policy = new SerialConfirmationPolicy({ surface: new GraphicalConfirmationSurface({ transport }) });
    expect(await policy.confirm(request(FAR_FUTURE)))
      .toEqual({ outcome: "rejected", reason: "input_closed" });
    await policy.close();
  });

  it("closes the transport when the engine closes the surface", async () => {
    // The engine's close() calls surface.close?.(); without forwarding, the
    // spawned UI process would outlive the watcher. This is the one property
    // the conformance matrix cannot check — its harness dispose is a no-op —
    // so it lives here as a surface-specific test.
    let closed = false;
    const transport: GraphicalTransport = {
      available: () => !closed,
      ask: async () => "approved",
      close: async () => {
        closed = true;
      },
    };
    const policy = new SerialConfirmationPolicy({ surface: new GraphicalConfirmationSurface({ transport }) });
    await policy.close();
    expect(closed).toBe(true);
  });
});

describe("createGraphicalActionConfirmation", () => {
  it("composes the graphical surface with the shared engine", async () => {
    const transport: GraphicalTransport = {
      available: () => true,
      ask: async () => "approved",
    };
    const policy = createGraphicalActionConfirmation({ transport });
    expect(policy.surfaceId).toBe("graphical");
    expect(await policy.confirm(request(FAR_FUTURE)))
      .toEqual({ outcome: "accepted", reason: "user_accepted" });
    await policy.close();
  });

  it("passes the timeout through to the engine", async () => {
    const transport: GraphicalTransport = {
      available: () => true,
      ask: () => new Promise(() => undefined),
    };
    const policy = createGraphicalActionConfirmation({
      transport,
      timeoutMs: 5,
    });
    expect(await policy.confirm(request(new Date(Date.now() + 10_000).toISOString())))
      .toEqual({ outcome: "rejected", reason: "timed_out" });
    await policy.close();
  });
});
