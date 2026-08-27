import { describe, expect, it } from "bun:test";
import { catalogPromptLines, type ToolSummary } from "../src/tool-catalog.js";

/**
 * The catalog is prompt surface, and this file pins its contract.
 *
 * It used to assert two other things: that `summarizeTools` stripped the `render`
 * and `guard` closures off a descriptor before it could reach a model, and that a
 * coordinator forwarded the catalog onto every outgoing request. Both are gone —
 * there are no descriptors carrying behavior and no coordinator forwarding
 * anything, because Pi's own tools are the execution surface and the agent reads
 * this catalog directly through its sense injection.
 *
 * What is left is worth pinning precisely because it is the whole boundary: a
 * schema is sent verbatim rather than paraphrased, and an absent catalog is
 * *stated* rather than invented.
 */

const runTests: ToolSummary = {
  id: "run_tests",
  title: "Run the project's test suite",
  category: "run_tests",
  parameters: {
    type: "object",
    properties: { commandClass: { const: "test" } },
    required: ["commandClass"],
    additionalProperties: false,
  },
  risk: "mutates_workspace",
};

const searchSelection: ToolSummary = {
  id: "search_selection",
  title: "Search the web for the current selection",
  category: "search_selection",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  risk: "external",
};

describe("catalogPromptLines", () => {
  it("renders one line per tool, in the order given", () => {
    const lines = catalogPromptLines([runTests, searchSelection]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('id="run_tests"');
    expect(lines[1]).toContain('id="search_selection"');
  });

  it("names the id, category, risk, and title on each line", () => {
    const [line] = catalogPromptLines([runTests]);
    expect(line).toContain('id="run_tests"');
    expect(line).toContain('category="run_tests"');
    expect(line).toContain("risk=mutates_workspace");
    expect(line).toContain("Run the project's test suite");
  });

  it("serializes the schema verbatim so the prompt cannot drift from the real shape", () => {
    const [line] = catalogPromptLines([runTests]);
    // The exact JSON, not a paraphrase: a hand-written description would
    // eventually disagree with the schema about field names, and the model would
    // be proposing against the description.
    expect(line).toContain(JSON.stringify(runTests.parameters));
  });

  it("states the absence of a catalog rather than inventing one", () => {
    const lines = catalogPromptLines(undefined);
    expect(lines).toHaveLength(1);
    // No tool ids appear — the honest rendering of "nothing arrived" points the
    // agent at its built-ins instead of at a name it would have to guess.
    expect(lines[0]).toContain("built-in tools");
    expect(lines[0]).not.toContain("id=");
  });

  it("states an empty catalog distinctly from an absent one", () => {
    const empty = catalogPromptLines([]);
    expect(empty).toHaveLength(1);
    expect(empty[0]).toContain("empty");
    expect(empty[0]).not.toEqual(catalogPromptLines(undefined)[0]);
  });
});
