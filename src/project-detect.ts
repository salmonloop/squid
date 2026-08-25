import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What a project's own tooling says its checks are.
 *
 * This exists because the capability surface used to be Bun. `REINSPECT_COMMANDS`
 * mapped every re-runnable check to `bun test` / `bun run lint` / `bun run typecheck`,
 * so on a Python, Go, or Rust project Squid proposed commands that would exit 127 —
 * and a suggestion that fails on arrival teaches a user to distrust every later one.
 *
 * Detection is deliberately conservative in one direction: a command is reported only
 * when the project *declares* it. A `package.json` with no `lint` script yields no lint
 * command, rather than a guessed `eslint .`. The cost of a missing capability is a
 * suggestion not made; the cost of an invented one is a broken command with Squid's name
 * on it.
 *
 * Every command is an argv array, never a shell string. Nothing downstream needs a shell,
 * and a string would have to be re-split by whoever runs it — which is where quoting bugs
 * and injection both live.
 */

/** The checks a project can run, as argv arrays. Absent means undeclared. */
export interface ProjectCommands {
  readonly test?: readonly string[];
  readonly lint?: readonly string[];
  readonly typecheck?: readonly string[];
  readonly build?: readonly string[];
}

export type ProjectEcosystem =
  | "bun"
  | "npm"
  | "pnpm"
  | "yarn"
  | "python"
  | "go"
  | "rust"
  | "make"
  | "unknown";

export interface ProjectProfile {
  readonly ecosystem: ProjectEcosystem;
  readonly commands: ProjectCommands;
}

export type ProjectCheck = keyof ProjectCommands;

export const projectChecks = ["test", "lint", "typecheck", "build"] as const satisfies
  readonly ProjectCheck[];

export interface DetectProjectOptions {
  /** Injected in tests. Rejects for a missing file, like `readFile`. */
  readonly readTextFile?: (path: string) => Promise<string>;
  /** Injected in tests. True when the path exists. */
  readonly exists?: (path: string) => Promise<boolean>;
}

/**
 * Reads a project root and reports which checks it can actually run.
 *
 * Ordered by specificity rather than by popularity: a repository with both `bun.lock` and
 * a `Makefile` is a Bun project with a convenience Makefile, and reporting `make test`
 * there would run something the developer treats as a wrapper. The JavaScript ecosystems
 * are distinguished by lockfile because the wrong package manager is a real failure — a
 * `pnpm test` in an npm project can resolve a different tree or refuse outright.
 *
 * Never throws. An unreadable or malformed manifest degrades to no commands, because the
 * alternative is a startup crash over a file the user may not control.
 */
export async function detectProject(
  root: string,
  options: DetectProjectOptions = {},
): Promise<ProjectProfile> {
  const readTextFile = options.readTextFile ?? ((path: string) => readFile(path, "utf8"));
  const exists = options.exists ?? (async (path: string) => {
    try {
      await readTextFile(path);
      return true;
    } catch {
      return false;
    }
  });
  const has = (name: string): Promise<boolean> => exists(join(root, name));

  // JavaScript first, and by lockfile: the manifest says which scripts exist, the
  // lockfile says which runner may execute them.
  if (await has("package.json")) {
    const scripts = await readPackageScripts(join(root, "package.json"), readTextFile);
    const runner = await detectJsRunner(has);
    return { ecosystem: runner.ecosystem, commands: jsCommands(runner, scripts) };
  }

  if (await has("pyproject.toml") || await has("pytest.ini") || await has("setup.cfg")) {
    // Python has no manifest field naming these, so the tools are reported by presence of
    // their own configuration rather than by a script list. A project with no ruff config
    // gets no lint command instead of a `ruff check` that may not be installed.
    const pyproject = await readTextIfPresent(join(root, "pyproject.toml"), readTextFile);
    const commands: ProjectCommands = {
      test: ["pytest"],
      ...(pyproject !== null && /^\s*\[tool\.ruff/mu.test(pyproject)
        ? { lint: ["ruff", "check", "."] }
        : {}),
      ...(pyproject !== null && /^\s*\[tool\.mypy/mu.test(pyproject)
        ? { typecheck: ["mypy", "."] }
        : {}),
    };
    return { ecosystem: "python", commands };
  }

  if (await has("go.mod")) {
    // `go vet` is the toolchain's own check and always present, so unlike the others it
    // needs no configuration to be safe to propose. There is no separate typecheck: `go
    // build` type-checks, and reporting it under two names would propose the same work
    // twice.
    return {
      ecosystem: "go",
      commands: {
        test: ["go", "test", "./..."],
        lint: ["go", "vet", "./..."],
        build: ["go", "build", "./..."],
      },
    };
  }

  if (await has("Cargo.toml")) {
    return {
      ecosystem: "rust",
      commands: {
        test: ["cargo", "test"],
        // `cargo check` is the fast type-only pass, which is exactly what a typecheck
        // means here; `clippy` is the lint. Both ship with the standard toolchain.
        typecheck: ["cargo", "check"],
        lint: ["cargo", "clippy"],
        build: ["cargo", "build"],
      },
    };
  }

  if (await has("Makefile") || await has("makefile")) {
    const source = await readTextIfPresent(join(root, "Makefile"), readTextFile)
      ?? await readTextIfPresent(join(root, "makefile"), readTextFile);
    // Only declared targets. A `make lint` against a Makefile with no lint target fails
    // with "No rule to make target", which is the same broken suggestion this module
    // exists to avoid.
    const targets = source === null ? new Set<string>() : parseMakeTargets(source);
    const commands: ProjectCommands = {};
    return {
      ecosystem: "make",
      commands: projectChecks.reduce<ProjectCommands>((accumulated, check) =>
        targets.has(check) ? { ...accumulated, [check]: ["make", check] } : accumulated,
        commands),
    };
  }

  return { ecosystem: "unknown", commands: {} };
}

/**
 * Which JavaScript runner may execute the manifest's scripts.
 *
 * Lockfile order matters: a repo can carry more than one after a migration, and the most
 * specific surviving lockfile is the one the developer is actually using. Bun first
 * because it is the narrowest signal, `package-lock.json` last because npm writes one by
 * default even in projects driven by something else.
 */
async function detectJsRunner(
  has: (name: string) => Promise<boolean>,
): Promise<{ readonly ecosystem: ProjectEcosystem; readonly argv: readonly string[] }> {
  if (await has("bun.lock") || await has("bun.lockb")) {
    return { ecosystem: "bun", argv: ["bun"] };
  }
  if (await has("pnpm-lock.yaml")) return { ecosystem: "pnpm", argv: ["pnpm"] };
  if (await has("yarn.lock")) return { ecosystem: "yarn", argv: ["yarn"] };
  return { ecosystem: "npm", argv: ["npm"] };
}

/**
 * Maps declared scripts onto argv arrays for the detected runner.
 *
 * `test` is special-cased because every runner has a first-class `test` subcommand, and
 * Bun's runs its own test runner even with no script declared. Everything else must be a
 * declared script, since `bun run lint` with no lint script is an error rather than a
 * default.
 */
function jsCommands(
  runner: { readonly ecosystem: ProjectEcosystem; readonly argv: readonly string[] },
  scripts: ReadonlySet<string>,
): ProjectCommands {
  const run = (script: string): readonly string[] =>
    // npm and yarn need `run`; bun and pnpm accept it too, so one spelling covers all
    // four rather than four spellings that could each be wrong.
    [...runner.argv, "run", script];

  return {
    ...(scripts.has("test") || runner.ecosystem === "bun"
      ? { test: scripts.has("test") ? run("test") : [...runner.argv, "test"] }
      : {}),
    ...(scripts.has("lint") ? { lint: run("lint") } : {}),
    ...(scripts.has("typecheck") ? { typecheck: run("typecheck") } : {}),
    ...(scripts.has("build") ? { build: run("build") } : {}),
  };
}

async function readPackageScripts(
  path: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<ReadonlySet<string>> {
  const source = await readTextIfPresent(path, readTextFile);
  if (source === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(source);
    if (parsed === null || typeof parsed !== "object") return new Set();
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (scripts === null || typeof scripts !== "object") return new Set();
    // Only string-valued entries. A script whose value is not a command is not a script,
    // and treating it as one would register a capability that cannot run.
    return new Set(
      Object.entries(scripts as Record<string, unknown>)
        .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
        .map(([name]) => name),
    );
  } catch {
    // Malformed JSON is a project problem, not a reason to refuse to start. No scripts
    // means no script-backed tools, which is the safe direction.
    return new Set();
  }
}

async function readTextIfPresent(
  path: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<string | null> {
  try {
    return await readTextFile(path);
  } catch {
    return null;
  }
}

/**
 * Target names a Makefile declares, from lines of the form `name:` or `name: deps`.
 *
 * Deliberately shallow: no `include` following, no variable expansion, no pattern rules.
 * A target this misses is a capability not offered, which is the safe direction; a target
 * it invented would be a command that fails on arrival.
 */
function parseMakeTargets(source: string): ReadonlySet<string> {
  const targets = new Set<string>();
  for (const line of source.split("\n")) {
    // Leading whitespace means a recipe line, not a target. `=` excludes variable
    // assignments like `test = foo`, and `%` excludes pattern rules.
    const match = /^([A-Za-z0-9_.-]+)\s*:(?!=)/u.exec(line);
    if (match?.[1] === undefined) continue;
    if (line.includes("%")) continue;
    targets.add(match[1]);
  }
  return targets;
}
