import { describe, expect, it } from "bun:test";
import {
  SerialConfirmationPolicy,
  type ConfirmationSurface,
} from "../src/action-confirmation.js";
import type { CapabilityActionPlan } from "../src/action-plan.js";

/**
 * The fail-closed matrix, run against every surface.
 *
 * A second surface is the point of `ConfirmationSurface`, and the risk it
 * introduces is not a rendering bug — it is a second, subtly different reading of
 * "fail closed". So no surface gets its own copy of these assertions. The same
 * suite runs against each one, the way `event-store-conformance.ts` holds three
 * stores to one contract.
 *
 * A surface passes by being *driven*, never by being asked what it would do: each
 * case answers through the real `SerialConfirmationPolicy`, so what is verified is
 * the decision a dispatcher would actually receive.
 */

export interface SurfaceHarness {
  readonly surface: ConfirmationSurface;
  /** Makes the next `ask` resolve with this answer. */
  answer(value: "y" | "n"): void;
  /** Makes the next `ask` hang, so the engine's deadline is what settles it. */
  hang(): void;
  /** Makes the surface report itself unavailable. */
  makeUnavailable(): void;
  dispose(): Promise<void>;
}

const plan: CapabilityActionPlan = {
  kind: "run_tests",
  tool: "run_command",
  arguments: { command: "cd /workspace && bun test -- tests/foo.test.ts" },
  summary: "cd /workspace && bun test -- tests/foo.test.ts",
  confirmation: "required",
};

const request = (expiresAt: string) => ({ candidateId: "req:candidate:0", plan, expiresAt });
const FAR_FUTURE = "2030-01-01T00:01:00.000Z";

export function describeConfirmationSurfaceConformance(
  name: string,
  createHarness: () => Promise<SurfaceHarness>,
): void {
  describe(`${name} conformance`, () => {
    async function withHarness(
      body: (harness: SurfaceHarness, policy: SerialConfirmationPolicy) => Promise<void>,
      policyOptions: { readonly timeoutMs?: number; readonly now?: () => Date } = {},
    ): Promise<void> {
      const harness = await createHarness();
      const policy = new SerialConfirmationPolicy({ surface: harness.surface, ...policyOptions });
      try {
        await body(harness, policy);
      } finally {
        await policy.close();
        await harness.dispose();
      }
    }

    it("accepts an explicit approval", async () => {
      await withHarness(async (harness, policy) => {
        harness.answer("y");
        expect(await policy.confirm(request(FAR_FUTURE)))
          .toEqual({ outcome: "accepted", reason: "user_accepted" });
      });
    });

    it("treats anything other than approval as a refusal", async () => {
      await withHarness(async (harness, policy) => {
        harness.answer("n");
        expect(await policy.confirm(request(FAR_FUTURE)))
          .toEqual({ outcome: "rejected", reason: "user_rejected" });
      });
    });

    it("refuses when the surface has nobody to ask", async () => {
      await withHarness(async (harness, policy) => {
        harness.makeUnavailable();
        // Not a hang and not an implicit yes. An absent user is a refusal, and
        // the reason says which kind so the ledger records why.
        expect(await policy.confirm(request(FAR_FUTURE)))
          .toEqual({ outcome: "rejected", reason: "non_interactive" });
      });
    });

    it("never asks about an already-expired candidate", async () => {
      let asked = false;
      const harness = await createHarness();
      const watched: ConfirmationSurface = {
        id: harness.surface.id,
        available: () => harness.surface.available(),
        ask: (prompt, signal) => {
          asked = true;
          return harness.surface.ask(prompt, signal);
        },
      };
      const policy = new SerialConfirmationPolicy({
        surface: watched,
        now: () => new Date("2030-01-01T00:00:01.000Z"),
      });
      try {
        harness.answer("y");
        expect(await policy.confirm(request("2030-01-01T00:00:00.000Z")))
          .toEqual({ outcome: "expired", reason: "candidate_expired" });
        expect(asked).toBe(false);
      } finally {
        await policy.close();
        await harness.dispose();
      }
    });

    it("times out as a refusal even if the surface ignores cancellation", async () => {
      await withHarness(async (harness, policy) => {
        harness.hang();
        expect(await policy.confirm(request(new Date(Date.now() + 10_000).toISOString())))
          .toEqual({ outcome: "rejected", reason: "timed_out" });
      }, { timeoutMs: 5 });
    });

    it("reports expiry rather than timeout when the candidate deadline wins", async () => {
      const now = new Date("2030-01-01T00:00:00.000Z");
      await withHarness(async (harness, policy) => {
        harness.hang();
        // Which clock ran out is the difference between "the suggestion was too
        // slow" and "the user was", and a ledger that conflates them cannot tell
        // an operator which one to fix.
        expect(await policy.confirm(request("2030-01-01T00:00:00.005Z")))
          .toEqual({ outcome: "expired", reason: "candidate_expired" });
      }, { timeoutMs: 100, now: () => now });
    });

    it("serializes prompts so two candidates cannot compete for one surface", async () => {
      await withHarness(async (harness, policy) => {
        harness.hang();
        const first = policy.confirm(request(new Date(Date.now() + 10_000).toISOString()));
        const second = policy.confirm(request(new Date(Date.now() + 10_000).toISOString()));
        // Both settle, and neither is an acceptance: the second was queued behind
        // the first rather than opening its own concurrent prompt. Overlap here
        // would mean two dialogs racing for a single claim.
        const [a, b] = await Promise.all([first, second]);
        expect(a.outcome).not.toBe("accepted");
        expect(b.outcome).not.toBe("accepted");
      }, { timeoutMs: 5 });
    });

    it("refuses once closed, and closing settles a pending ask", async () => {
      const harness = await createHarness();
      const policy = new SerialConfirmationPolicy({ surface: harness.surface });
      try {
        harness.hang();
        const pending = policy.confirm(request(FAR_FUTURE));
        await Promise.resolve();

        // Shutdown must not depend on a surface honoring cancellation.
        await policy.close();
        expect(await pending).toEqual({ outcome: "rejected", reason: "input_closed" });

        harness.answer("y");
        expect(await policy.confirm(request(FAR_FUTURE)))
          .toEqual({ outcome: "rejected", reason: "input_closed" });
      } finally {
        await harness.dispose();
      }
    });

    it("shows the plan summary and never the plan arguments", async () => {
      const harness = await createHarness();
      const shown: string[] = [];
      const watched: ConfirmationSurface = {
        id: harness.surface.id,
        available: () => harness.surface.available(),
        ask: (prompt, signal) => {
          // The surface receives a `ConfirmationPrompt`, which has no
          // `arguments` field at all — so this records what a surface *can*
          // possibly render, not merely what this one chose to.
          shown.push(JSON.stringify(prompt));
          return harness.surface.ask(prompt, signal);
        },
      };
      const policy = new SerialConfirmationPolicy({ surface: watched });
      try {
        harness.answer("y");
        await policy.confirm(request(FAR_FUTURE));
        expect(shown[0]).toContain(plan.summary);
        expect(shown[0]).not.toContain("arguments");
      } finally {
        await policy.close();
        await harness.dispose();
      }
    });
  });
}
