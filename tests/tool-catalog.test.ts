import { describe, expect, it } from "bun:test";
import { emptyWorldState } from "../src/protocol.js";
import { PredictionCoordinator } from "../src/prediction-coordinator.js";
import { FakePredictionProvider, candidate } from "../src/fake-prediction-provider.js";
import type { ToolSummary } from "../src/tool-catalog.js";
import { summarizeTools, type ToolRegistry } from "../src/tool-catalog.js";
import { buildToolRegistry } from "../src/tool-descriptors.js";
import type { PredictionRequest } from "../src/prediction-provider.js";

/** A bun-style project: every check class declared. */
const bunProject = {
  ecosystem: "bun" as const,
  commands: {
    test: ["bun", "test"],
    lint: ["bun", "run", "lint"],
    typecheck: ["bun", "run", "typecheck"],
    build: ["bun", "run", "build"],
  },
};

describe("summarizeTools", () => {
  it("exposes id, title, category, schema, and risk — in registration order", () => {
    const summaries = summarizeTools(buildToolRegistry({ project: bunProject }));
    expect(summaries.map((summary) => summary.id)).toEqual([
      "run_tests",
      "run_check",
      "search_selection",
    ]);
    expect(summaries[0].category).toBe("run_tests");
    expect(summaries[1].category).toBe("inspect_error");
    expect(summaries[2].risk).toBe("external");
  });

  it("carries the real argument schema so prompt and validator cannot drift", () => {
    const summaries = summarizeTools(buildToolRegistry({ project: bunProject }));
    const runCheck = summaries.find((summary) => summary.id === "run_check");
    expect(runCheck === undefined ? [] : runCheck.parameters).toEqual({
      type: "object",
      properties: {
        commandClass: {
          anyOf: [
            { type: "string", const: "test" },
            { type: "string", const: "lint" },
            { type: "string", const: "typecheck" },
            { type: "string", const: "build" },
          ],
        },
      },
      required: ["commandClass"],
      additionalProperties: false,
    });
  });

  it("never leaks behavior: no render or guard reaches the summary", () => {
    const summaries = summarizeTools(buildToolRegistry({ project: bunProject }));
    for (const summary of summaries) {
      // The summary is a plain data record; walking its own enumerable keys is
      // enough because a function-valued field would have to be a key on it.
      for (const key of Object.keys(summary)) {
        expect(typeof (summary as unknown as Record<string, unknown>)[key]).not.toBe("function");
      }
      expect(JSON.stringify(summary)).not.toContain("render");
      expect(JSON.stringify(summary)).not.toContain("guard");
    }
  });

  it("omits the check-backed tool when the project declares nothing", () => {
    const summaries = summarizeTools(buildToolRegistry({
      project: { ecosystem: "unknown", commands: {} },
    }));
    expect(summaries.map((summary) => summary.id)).toEqual(["run_tests", "search_selection"]);
  });
});

describe("PredictionCoordinator tool forwarding", () => {
  const counter = (() => {
    let n = 0;
    return (): string => `req-${++n}`;
  })();

  /** A provider that records what it was handed instead of answering from a script. */
  function capturingProvider(
    requests: readonly PredictionRequest[],
    tools: readonly ToolSummary[] | undefined,
  ) {
    return new FakePredictionProvider({
      candidates: [candidate("none", 0)],
      delayMs: 0,
      name: "probe",
    }) as FakePredictionProvider & { predict(request: PredictionRequest, signal: AbortSignal): Promise<readonly PredictionCandidateLike[]> };
  }

  type PredictionCandidateLike = ReturnType<typeof candidate>;

  it("forwards the catalog onto every request when configured", async () => {
    const seen: (readonly ToolSummary[] | undefined)[] = [];
    const registry: ToolRegistry = buildToolRegistry({ project: bunProject });
    const coordinator = new PredictionCoordinator({
      provider: {
        name: "probe",
        predict: async (request) => {
          seen.push(request.tools);
          return [candidate("none", 0)];
        },
      },
      tools: summarizeTools(registry),
    });
    await coordinator.request(emptyWorldState());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.map((tool) => tool.id)).toEqual([
      "run_tests",
      "run_check",
      "search_selection",
    ]);
  });

  it("sends no tools field when none was configured", async () => {
    let sawKey: boolean | undefined;
    const coordinator = new PredictionCoordinator({
      provider: {
        name: "probe",
        predict: async (request) => {
          sawKey = "tools" in request;
          return [candidate("none", 0)];
        },
      },
    });
    await coordinator.request(emptyWorldState());
    // Absent means absent: a provider must be able to tell "no catalog" apart
    // from an empty one, and `"tools": undefined` in JSON would erase both.
    expect(sawKey).toBe(false);
  });

  it("keeps forwarding after a superseded request", async () => {
    const seen: number[] = [];
    // First call hangs on the signal (so supersede aborts it); the second
    // answers at once. Mirrors the supersede shape the coordinator tests use.
    let calls = 0;
    const coordinator = new PredictionCoordinator({
      provider: {
        name: "probe",
        predict: async (request, signal) => {
          if (request.tools !== undefined) seen.push(request.tools.length);
          calls += 1;
          if (calls === 1) {
            return new Promise<never>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          }
          return [candidate("none", 0)];
        },
      },
      tools: summarizeTools(buildToolRegistry()),
      random: counter,
    });
    const first = coordinator.request(emptyWorldState());
    await coordinator.request(emptyWorldState());
    expect((await first).status).toBe("stale");
    // No project profile, so the registry is the two unconditional tools.
    expect(seen).toEqual([2, 2]);
  });

  // Guard against the capturing helper above rotting into dead code.
  void capturingProvider;
});
