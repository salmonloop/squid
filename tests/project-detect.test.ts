import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProject } from "../src/project-detect.js";

/**
 * Detection runs against real temp directories rather than a stubbed filesystem.
 *
 * The thing being tested is a claim about marker files, and a stub would let a wrong claim
 * about which marker wins pass: the ordering between `bun.lock` and `Makefile` only means
 * something when both really exist on disk. The injectable seams stay for the two cases a
 * temp directory cannot produce on demand — an unreadable manifest and a malformed one.
 */
async function project(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "squid-detect-"));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(root, name), contents, "utf8");
  }
  return root;
}

const packageJson = (scripts: Readonly<Record<string, string>>): string =>
  JSON.stringify({ name: "fixture", scripts });

describe("detectProject", () => {
  it("reports no commands for a directory with no markers", async () => {
    const profile = await detectProject(await project({}));
    expect(profile.ecosystem).toBe("unknown");
    expect(profile.commands).toEqual({});
  });

  it("picks the JavaScript runner from the lockfile, not the manifest", async () => {
    const cases = [
      { files: { "bun.lock": "" }, ecosystem: "bun", argv: ["bun", "run", "lint"] },
      { files: { "bun.lockb": "" }, ecosystem: "bun", argv: ["bun", "run", "lint"] },
      { files: { "pnpm-lock.yaml": "" }, ecosystem: "pnpm", argv: ["pnpm", "run", "lint"] },
      { files: { "yarn.lock": "" }, ecosystem: "yarn", argv: ["yarn", "run", "lint"] },
      { files: {}, ecosystem: "npm", argv: ["npm", "run", "lint"] },
    ] as const;

    for (const testCase of cases) {
      const root = await project({
        "package.json": packageJson({ lint: "eslint ." }),
        ...testCase.files,
      });
      const profile = await detectProject(root);
      expect(profile.ecosystem).toBe(testCase.ecosystem);
      expect(profile.commands.lint).toEqual(testCase.argv);
    }
  });

  it("prefers the most specific surviving lockfile after a migration", async () => {
    // A repo can carry several at once. Bun is the narrowest signal and npm writes a
    // lockfile by default even in projects driven by something else, so the order is not
    // arbitrary and a regression here would silently run the wrong package manager.
    const root = await project({
      "package.json": packageJson({ test: "vitest" }),
      "bun.lock": "",
      "pnpm-lock.yaml": "",
      "yarn.lock": "",
      "package-lock.json": "{}",
    });
    expect((await detectProject(root)).ecosystem).toBe("bun");
  });

  it("registers only the scripts the manifest actually declares", async () => {
    const root = await project({
      "package.json": packageJson({ test: "vitest", build: "tsc" }),
      "pnpm-lock.yaml": "",
    });
    const { commands } = await detectProject(root);
    expect(commands.test).toEqual(["pnpm", "run", "test"]);
    expect(commands.build).toEqual(["pnpm", "run", "build"]);
    // The point of the whole module: no lint script means no lint command, rather than a
    // guessed `eslint .` that exits 127 with Squid's name on it.
    expect(commands.lint).toBeUndefined();
    expect(commands.typecheck).toBeUndefined();
  });

  it("gives Bun a test command even with no test script, and other runners none", async () => {
    const bun = await detectProject(await project({
      "package.json": packageJson({}),
      "bun.lock": "",
    }));
    // `bun test` runs Bun's own runner with no script declared, so the capability is real.
    expect(bun.commands.test).toEqual(["bun", "test"]);

    const npm = await detectProject(await project({ "package.json": packageJson({}) }));
    expect(npm.commands.test).toBeUndefined();
  });

  it("ignores manifest entries whose value is not a command", async () => {
    const root = await project({
      "package.json": JSON.stringify({ scripts: { test: "", lint: null, build: 7 } }),
    });
    expect((await detectProject(root)).commands).toEqual({});
  });

  it("degrades a malformed manifest to no commands rather than crashing", async () => {
    const root = await project({ "package.json": "{ not json" });
    const profile = await detectProject(root);
    // Still recognized as a JavaScript project — the marker is present — but nothing is
    // claimed about what it can run. A startup crash over a file the user may not control
    // would be the worse failure.
    expect(profile.ecosystem).toBe("npm");
    expect(profile.commands).toEqual({});
  });

  it("drops script-derived commands when the manifest cannot be read", async () => {
    const root = await project({ "package.json": packageJson({ lint: "eslint ." }) });
    const profile = await detectProject(root, {
      // Every marker reports present, so this is a Bun project as far as detection can
      // tell, but no manifest content is available to say what it declares.
      exists: async () => true,
      readTextFile: async () => {
        throw new Error("EACCES");
      },
    });
    // The declared lint script is gone: an unreadable manifest declares nothing.
    expect(profile.commands.lint).toBeUndefined();
    expect(profile.commands.typecheck).toBeUndefined();
    // `test` survives because it is the runner's own subcommand rather than a script —
    // `bun test` runs with no manifest at all, so the manifest being unreadable does not
    // make it unavailable.
    expect(profile.commands.test).toEqual(["bun", "test"]);
  });

  it("reports Python tools by their own configuration, not by a script list", async () => {
    const bare = await detectProject(await project({ "pyproject.toml": "[project]\nname='x'\n" }));
    expect(bare.ecosystem).toBe("python");
    expect(bare.commands.test).toEqual(["pytest"]);
    // No ruff or mypy configuration means no such command, because neither is guaranteed
    // installed.
    expect(bare.commands.lint).toBeUndefined();
    expect(bare.commands.typecheck).toBeUndefined();

    const configured = await detectProject(await project({
      "pyproject.toml": "[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n",
    }));
    expect(configured.commands.lint).toEqual(["ruff", "check", "."]);
    expect(configured.commands.typecheck).toEqual(["mypy", "."]);
  });

  it("recognizes a Python project from pytest.ini or setup.cfg alone", async () => {
    for (const marker of ["pytest.ini", "setup.cfg"]) {
      const profile = await detectProject(await project({ [marker]: "[pytest]\n" }));
      expect(profile.ecosystem).toBe("python");
      expect(profile.commands.test).toEqual(["pytest"]);
    }
  });

  it("uses the Go toolchain's own checks", async () => {
    const { ecosystem, commands } = await detectProject(
      await project({ "go.mod": "module example.com/x\n" }),
    );
    expect(ecosystem).toBe("go");
    expect(commands.test).toEqual(["go", "test", "./..."]);
    expect(commands.lint).toEqual(["go", "vet", "./..."]);
    expect(commands.build).toEqual(["go", "build", "./..."]);
    // `go build` already type-checks; reporting it twice would propose the same work under
    // two names.
    expect(commands.typecheck).toBeUndefined();
  });

  it("uses the Rust toolchain's own checks", async () => {
    const { ecosystem, commands } = await detectProject(
      await project({ "Cargo.toml": "[package]\nname = \"x\"\n" }),
    );
    expect(ecosystem).toBe("rust");
    expect(commands.test).toEqual(["cargo", "test"]);
    expect(commands.typecheck).toEqual(["cargo", "check"]);
    expect(commands.lint).toEqual(["cargo", "clippy"]);
    expect(commands.build).toEqual(["cargo", "build"]);
  });

  it("reports only the Makefile targets that are declared", async () => {
    const root = await project({
      "Makefile": [
        ".PHONY: test lint",
        "test:",
        "\tpytest",
        "lint: fmt",
        "\truff check .",
        "deploy:",
        "\tkubectl apply -f .",
      ].join("\n"),
    });
    const { ecosystem, commands } = await detectProject(root);
    expect(ecosystem).toBe("make");
    expect(commands.test).toEqual(["make", "test"]);
    expect(commands.lint).toEqual(["make", "lint"]);
    // A `make typecheck` against a Makefile with no such target fails with "No rule to make
    // target", which is the broken suggestion this module exists to avoid.
    expect(commands.typecheck).toBeUndefined();
    expect(commands.build).toBeUndefined();
  });

  it("does not mistake variable assignments or pattern rules for targets", async () => {
    const root = await project({
      "Makefile": ["test = pytest", "build := tsc", "%.o: %.c", "\tcc -c $<"].join("\n"),
    });
    expect((await detectProject(root)).commands).toEqual({});
  });

  it("treats a Makefile beside a real manifest as a wrapper, not the ecosystem", async () => {
    // A repository with both is a Bun project with a convenience Makefile. Reporting
    // `make test` there would run what the developer treats as a wrapper.
    const root = await project({
      "package.json": packageJson({ test: "bun test" }),
      "bun.lock": "",
      "Makefile": "test:\n\tbun test\n",
    });
    const profile = await detectProject(root);
    expect(profile.ecosystem).toBe("bun");
    expect(profile.commands.test).toEqual(["bun", "run", "test"]);
  });

  it("never returns a command as a shell string", async () => {
    const roots = await Promise.all([
      project({ "package.json": packageJson({ test: "vitest --run" }), "bun.lock": "" }),
      project({ "go.mod": "module x\n" }),
      project({ "Cargo.toml": "[package]\n" }),
      project({ "Makefile": "test:\n\tpytest\n" }),
      project({ "pyproject.toml": "[tool.ruff]\n" }),
    ]);
    for (const root of roots) {
      const { commands } = await detectProject(root);
      for (const argv of Object.values(commands)) {
        expect(Array.isArray(argv)).toBe(true);
        // Every element must be one argv token. A shell metacharacter here would have to be
        // re-split by whoever runs it, which is where quoting bugs and injection live.
        for (const element of argv ?? []) {
          expect(element).not.toMatch(/[;&|><$`\n]/u);
        }
      }
    }
  });
});
