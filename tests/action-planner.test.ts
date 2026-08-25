import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPlanFailure, planAction } from "../src/action-planner.js";
import { bunProject } from "./fixtures/bun-project.js";

const identity = { candidateId: "req-1:candidate:0", attemptId: "req-1" } as const;

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "squid-plan-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "x.test.ts"), "// test\n", "utf8");
  return root;
}

describe("planAction", () => {
  it("refuses a proposal that names no registered capability", async () => {
    // A null toolId is a fact about the candidate — nothing to execute. The
    // kind is carried along for scoring but cannot route by itself.
    for (const kind of ["draft_completion", "none"] as const) {
      const result = await planAction({ ...identity, kind, toolId: null, parameters: {} });
      expect(isPlanFailure(result) && result.reasonCode).toBe("tool_unknown");
    }
  });

  it("refuses a named tool this registry does not hold rather than substituting one", async () => {
    // Falling back to another descriptor of the same category would execute a
    // capability nobody proposed.
    const result = await planAction({
      ...identity,
      kind: "inspect_error",
      toolId: "no_such_tool",
      parameters: {},
    });
    expect(isPlanFailure(result) && result.reasonCode).toBe("tool_unknown");
  });

  it("refuses a search plan without usable selection text", async () => {
    for (const parameters of [{}, { selection: "   " }, { selection: 7 }]) {
      const result = await planAction({ ...identity, toolId: "search_selection", parameters });
      expect(isPlanFailure(result) && result.reasonCode).toBe("parameters_invalid");
    }
  });

  it("keeps the raw selection out of the search plan summary", async () => {
    const secret = "ultra secret business plan";
    const result = await planAction({
      ...identity,
      toolId: "search_selection",
      parameters: { selection: secret },
    });
    if (isPlanFailure(result)) throw new Error(result.reasonCode);
    expect(result.plan.summary).not.toContain(secret);
    expect(result.plan.summary).toContain(String(secret.length));
    // The query still carries the real text: it is the operation, and it lives
    // only in the in-process plan.
    expect(result.plan.arguments.query).toBe(secret);
  });

  it("canonicalizes the working directory and target through realpath", async () => {
    const root = await workspace();
    const linked = `${root}-link`;
    await symlink(root, linked);

    const result = await planAction(
      { ...identity, toolId: "run_tests", parameters: { path: "src/../src/x.test.ts" } },
      { workingDirectory: linked, project: bunProject },
    );
    if (isPlanFailure(result)) throw new Error(result.reasonCode);

    // The symlink is gone from the plan: what runs is the resolved path.
    expect(result.plan.canonicalWorkingDirectory).not.toBe(linked);
    expect(result.plan.canonicalTarget?.endsWith("src/x.test.ts")).toBe(true);
    expect(result.plan.arguments.command).toContain("bun test");
    // Bypassed at registration (issue #11): the plan carries what the descriptor
    // declares, and the descriptor currently asks for nothing.
    expect(result.plan.confirmation).toBe("none");
  });

  it("rejects paths that escape the working directory lexically or via symlink", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "squid-outside-"));
    await writeFile(join(outside, "evil.ts"), "// evil\n", "utf8");
    await symlink(join(outside, "evil.ts"), join(root, "src", "escape.ts"));

    const lexical = await planAction(
      { ...identity, toolId: "run_tests", parameters: { path: "../etc/passwd" } },
      { workingDirectory: root, project: bunProject },
    );
    expect(isPlanFailure(lexical) && lexical.reasonCode).toBe("path_escapes_workdir");

    const viaSymlink = await planAction(
      { ...identity, toolId: "run_tests", parameters: { path: "src/escape.ts" } },
      { workingDirectory: root, project: bunProject },
    );
    expect(isPlanFailure(viaSymlink) && viaSymlink.reasonCode).toBe("path_escapes_workdir");
  });

  it("refuses absolute paths, control characters, and a missing workdir", async () => {
    const root = await workspace();
    const absolute = await planAction(
      { ...identity, toolId: "run_tests", parameters: { path: "/etc/passwd" } },
      { workingDirectory: root, project: bunProject },
    );
    expect(isPlanFailure(absolute) && absolute.reasonCode).toBe("path_absolute");

    const control = await planAction(
      { ...identity, toolId: "run_tests", parameters: { path: "src/x\u0000.ts" } },
      { workingDirectory: root, project: bunProject },
    );
    expect(isPlanFailure(control) && control.reasonCode).toBe("path_control_characters");

    const noWorkdir = await planAction({
      ...identity,
      toolId: "run_tests",
      parameters: { path: "src/x.test.ts" },
    });
    expect(isPlanFailure(noWorkdir) && noWorkdir.reasonCode).toBe("workdir_missing");

    const relativeWorkdir = await planAction(
      { ...identity, toolId: "run_tests", parameters: { path: "src/x.test.ts" } },
      { workingDirectory: "relative/dir" },
    );
    expect(isPlanFailure(relativeWorkdir) && relativeWorkdir.reasonCode).toBe("workdir_not_absolute");
  });

  it("plans a target that does not exist yet under the canonical root", async () => {
    const root = await workspace();
    const result = await planAction(
      { ...identity, toolId: "run_tests", parameters: { path: "src/not-created-yet.test.ts" } },
      { workingDirectory: root, project: bunProject },
    );
    if (isPlanFailure(result)) throw new Error(result.reasonCode);
    expect(result.plan.canonicalTarget?.endsWith("src/not-created-yet.test.ts")).toBe(true);
  });

  it("produces a stable digest for identical plans and a different one otherwise", async () => {
    const root = await workspace();
    const build = (path: string) => planAction(
      { ...identity, toolId: "run_tests", parameters: { path } },
      { workingDirectory: root, project: bunProject },
    );
    const first = await build("src/x.test.ts");
    const second = await build("src/x.test.ts");
    const other = await build("src/not-created-yet.test.ts");
    if (isPlanFailure(first) || isPlanFailure(second) || isPlanFailure(other)) {
      throw new Error("planning failed");
    }
    expect(first.planDigest).toBe(second.planDigest);
    expect(first.planDigest).not.toBe(other.planDigest);
    expect(first.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.candidateParametersDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("freezes the plan so no later stage can mutate what the user approved", async () => {
    const result = await planAction({
      ...identity,
      toolId: "search_selection",
      parameters: { selection: "hello" },
    });
    if (isPlanFailure(result)) throw new Error(result.reasonCode);
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(Object.isFrozen(result.plan.arguments)).toBe(true);
  });

  it("carries the candidate and attempt identity into the plan", async () => {
    const result = await planAction({
      ...identity,
      toolId: "search_selection",
      parameters: { selection: "hello" },
    });
    if (isPlanFailure(result)) throw new Error(result.reasonCode);
    expect(result.plan.candidateId).toBe(identity.candidateId);
    expect(result.plan.attemptId).toBe(identity.attemptId);
  });
});

/**
 * Regression: a target under a symlinked directory must be refused even when the
 * file itself does not exist yet.
 *
 * The dangerous case is specifically the *missing* target. An existing one is
 * caught by `realpath` directly; a missing one used to fall back to a lexical
 * join, which never traverses the symlink and therefore looked contained. Since
 * `bun test -- <path>` does follow the link at execution time, that fallback
 * authorized running code outside the root.
 */
describe("planAction symlinked-directory containment", () => {
  async function tree(): Promise<{ root: string; outside: string }> {
    const base = await mkdtemp(join(tmpdir(), "squid-symlink-"));
    const root = join(base, "root");
    const outside = join(base, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(root, "link"), "dir");
    return { root, outside };
  }

  it("refuses a not-yet-existing target under a symlinked directory", async () => {
    const { root } = await tree();

    const planned = await planAction(
      {
        candidateId: "req:candidate:0",
        attemptId: "req",
        toolId: "run_tests",
        parameters: { path: "link/evil.test.ts" },
      },
      { workingDirectory: root, project: bunProject },
    );

    expect(isPlanFailure(planned)).toBe(true);
    if (isPlanFailure(planned)) expect(planned.reasonCode).toBe("path_escapes_workdir");
  });

  it("refuses an existing target under a symlinked directory", async () => {
    const { root, outside } = await tree();
    await writeFile(join(outside, "evil.test.ts"), "", "utf8");

    const planned = await planAction(
      {
        candidateId: "req:candidate:0",
        attemptId: "req",
        toolId: "run_tests",
        parameters: { path: "link/evil.test.ts" },
      },
      { workingDirectory: root, project: bunProject },
    );

    expect(isPlanFailure(planned)).toBe(true);
    if (isPlanFailure(planned)) expect(planned.reasonCode).toBe("path_escapes_workdir");
  });

  it("still plans a not-yet-existing file inside the root", async () => {
    const { root } = await tree();
    await mkdir(join(root, "tests"), { recursive: true });

    const planned = await planAction(
      {
        candidateId: "req:candidate:0",
        attemptId: "req",
        toolId: "run_tests",
        parameters: { path: "tests/not-created-yet.test.ts" },
      },
      { workingDirectory: root, project: bunProject },
    );

    // The whole point of the ancestor walk: a test file the run will create is
    // legitimate, so containment must be decided on its resolved parent.
    expect(isPlanFailure(planned)).toBe(false);
  });
});
