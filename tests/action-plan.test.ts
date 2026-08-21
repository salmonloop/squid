import { describe, expect, it } from "bun:test";
import {
  isActionPlanFailure,
  planCapabilityAction,
} from "../src/action-plan.js";

describe("planCapabilityAction", () => {
  it("plans search_selection without confirmation", () => {
    const plan = planCapabilityAction("search_selection", { selection: "typebox" });
    expect(isActionPlanFailure(plan)).toBe(false);
    if (isActionPlanFailure(plan)) return;
    expect(plan).toMatchObject({
      tool: "search_web",
      arguments: { query: "typebox" },
      confirmation: "none",
    });
  });

  it("quotes a run_tests path once and marks the exact command as confirmation-required", () => {
    const plan = planCapabilityAction(
      "run_tests",
      { path: "tests/a b;$(touch nope).test.ts" },
      { workingDirectory: "/workspace/squid project" },
    );
    expect(isActionPlanFailure(plan)).toBe(false);
    if (isActionPlanFailure(plan)) return;
    expect(plan.confirmation).toBe("required");
    expect(plan.arguments.command).toBe("cd '/workspace/squid project' && bun test -- 'tests/a b;$(touch nope).test.ts'");
    expect(plan.summary).toBe(plan.arguments.command);
  });

  it("fails closed for incomplete or unmapped candidates", () => {
    expect(planCapabilityAction("run_tests", { path: "   " })).toHaveProperty("error");
    expect(planCapabilityAction("run_tests", { path: "tests/a.test.ts" })).toHaveProperty("error");
    expect(planCapabilityAction("draft_completion", {})).toHaveProperty("error");
  });

  it("refuses paths outside the working directory or unsafe to print", () => {
    const context = { workingDirectory: "/workspace" };
    for (const path of ["../outside.test.ts", "/tmp/outside.test.ts", "/workspace/inside.test.ts", "tests/a\nfile.test.ts", "tests/a\u001b[2J.test.ts"]) {
      expect(planCapabilityAction("run_tests", { path }, context)).toHaveProperty("error");
    }
  });

  it("refuses a working directory containing terminal control characters", () => {
    for (const workingDirectory of ["/workspace/line\nbreak", "/workspace/escape\u001b[2J"]) {
      expect(planCapabilityAction(
        "run_tests",
        { path: "tests/a.test.ts" },
        { workingDirectory },
      )).toHaveProperty("error");
    }
  });
});
