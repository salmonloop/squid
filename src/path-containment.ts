import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Whether a model-supplied path really lands inside the working directory.
 *
 * Extracted from `action-planner.ts`'s `run_tests` case, unchanged in behaviour, because
 * it is now the boundary every catalog tool leans on rather than one branch of one switch.
 * A model proposes a path string; this decides whether that string names something inside
 * the root. Duplicating the reasoning per tool is how one tool ends up with the weaker
 * version of it.
 *
 * Two passes, and both are needed:
 *
 * 1. **Lexical.** Rejects the obvious `../..` before touching the filesystem, so an
 *    unresolvable path cannot be used to probe for existence outside the root.
 * 2. **Canonical.** `realpath` on the deepest existing ancestor, then the missing tail
 *    re-appended. A target that does not exist yet is legitimate — a test file the run
 *    will create — but its *directories* still decide containment. Resolving only the full
 *    path and falling back to the lexical join on failure would skip every symlink on the
 *    way down, so a planted `link/ -> /outside` plus a not-yet-existing `link/x.test.ts`
 *    would pass containment while the command executes outside the root.
 */

export type PathContainmentFailure =
  | "path_absolute"
  | "path_control_characters"
  | "path_escapes_workdir"
  | "path_unresolvable"
  | "workdir_missing"
  | "workdir_not_absolute"
  | "workdir_control_characters"
  | "workdir_unresolvable";

export interface ContainedPath {
  /** Canonical realpath of the root the command runs in. */
  readonly canonicalWorkingDirectory: string;
  /** Canonical realpath of the target, with any missing tail appended. */
  readonly canonicalTarget: string;
  /** The target relative to the canonical root. Safe to pass as an argv element. */
  readonly relativeTarget: string;
}

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;

/**
 * Canonicalizes the working directory alone, for tools that run a command but name no file.
 *
 * Separate from `containPath` because "no target" is a legitimate shape — a project-wide
 * check has nothing to contain — and folding it in would mean inventing a target just to
 * satisfy a signature.
 */
export async function canonicalizeWorkdir(
  workingDirectory: string | undefined,
  resolvePath: (path: string) => Promise<string> = realpath,
): Promise<{ readonly canonicalWorkingDirectory: string } | { readonly reasonCode: PathContainmentFailure }> {
  if (workingDirectory === undefined) return { reasonCode: "workdir_missing" };
  if (!isAbsolute(workingDirectory)) return { reasonCode: "workdir_not_absolute" };
  if (CONTROL_CHARACTERS.test(workingDirectory)) {
    return { reasonCode: "workdir_control_characters" };
  }
  try {
    return { canonicalWorkingDirectory: await resolvePath(workingDirectory) };
  } catch {
    return { reasonCode: "workdir_unresolvable" };
  }
}

export async function containPath(
  path: string,
  workingDirectory: string | undefined,
  resolvePath: (path: string) => Promise<string> = realpath,
): Promise<ContainedPath | { readonly reasonCode: PathContainmentFailure }> {
  if (CONTROL_CHARACTERS.test(path)) return { reasonCode: "path_control_characters" };
  // An absolute path is refused rather than re-based: a model that supplied one was not
  // describing a location inside the project, and silently reinterpreting it would make
  // the approved summary describe a different file than the one named.
  if (isAbsolute(path)) return { reasonCode: "path_absolute" };

  const workdir = await canonicalizeWorkdir(workingDirectory, resolvePath);
  if ("reasonCode" in workdir) return workdir;
  const canonicalWorkingDirectory = workdir.canonicalWorkingDirectory;

  const lexical = relative(canonicalWorkingDirectory, resolve(canonicalWorkingDirectory, path));
  if (lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    return { reasonCode: "path_escapes_workdir" };
  }

  const joined = resolve(canonicalWorkingDirectory, lexical);
  let canonicalTarget: string;
  try {
    canonicalTarget = await resolvePath(joined);
  } catch {
    const ancestor = await resolveDeepestAncestor(
      canonicalWorkingDirectory, lexical, resolvePath,
    );
    if (ancestor === null) return { reasonCode: "path_unresolvable" };
    canonicalTarget = ancestor;
  }

  const containment = relative(canonicalWorkingDirectory, canonicalTarget);
  if (
    containment === ".."
    || containment.startsWith(`..${sep}`)
    || isAbsolute(containment)
  ) {
    return { reasonCode: "path_escapes_workdir" };
  }

  return { canonicalWorkingDirectory, canonicalTarget, relativeTarget: containment };
}

/**
 * Canonicalizes a target that may not exist yet.
 *
 * Walks from the full path toward the root until something resolves, then re-appends the
 * segments that did not. Every existing component — including any symlinked directory on
 * the way down — is traversed by `realpath`, so a link pointing outside the root surfaces
 * in the returned path and fails the containment check that follows.
 *
 * Returns null when not even the canonical root resolves, which means the working
 * directory vanished mid-plan and there is nothing safe to target.
 */
export async function resolveDeepestAncestor(
  canonicalWorkdir: string,
  relativeTarget: string,
  resolvePath: (path: string) => Promise<string>,
): Promise<string | null> {
  const segments = relativeTarget.split(sep).filter((segment) => segment.length > 0);
  const missing: string[] = [];

  while (segments.length > 0) {
    missing.unshift(segments.pop()!);
    const candidate = segments.length === 0
      ? canonicalWorkdir
      : resolve(canonicalWorkdir, segments.join(sep));
    try {
      const resolved = await resolvePath(candidate);
      return resolve(resolved, ...missing);
    } catch {
      continue;
    }
  }

  try {
    return resolve(await resolvePath(canonicalWorkdir), ...missing);
  } catch {
    return null;
  }
}
