import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  canonicalizeWorkdir,
  containPath,
} from "../src/path-containment.js";

/**
 * These are filesystem-backed on purpose. The whole point of the two-pass containment
 * is that the canonical pass sees through symlinks, and no injected resolver can fake
 * what `realpath` does to a real planted link. The lexical pass is still covered here
 * too, because it fires first and its rejection codes are part of the contract every
 * catalog tool inherits.
 */

async function makeTempRoot(): Promise<string> {
  // `realpath` because the subject canonicalizes its root, and every assertion
  // below compares against a path this helper built. On Windows `tmpdir()`
  // reports the 8.3 short name (`C:\\Users\\RUNNER~1\\...`), so without this the
  // expected path carries the short form while `containPath` returns the long
  // one and the two never match — and probe paths derived from the short root
  // miss the files this helper just planted.
  return await realpath(await mkdtemp(join(tmpdir(), "squid-containment-")));
}

async function plantProject(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await makeTempRoot();
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "existing.test.ts"), "test();\n");
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("containPath — lexical pass", () => {
  it("rejects control characters in the path", async () => {
    const result = await containPath("src/\u0000x.test.ts", "/tmp");
    expect(result).toEqual({ reasonCode: "path_control_characters" });
  });

  it("rejects an absolute path rather than re-basing it", async () => {
    const result = await containPath("/etc/passwd", "/tmp/project");
    expect(result).toEqual({ reasonCode: "path_absolute" });
  });

  it("rejects a lexical .. escape without probing whether the target exists", async () => {
    // The workdir exists but neither `..` target nor anything else is checked: the
    // lexical pass fires before any path resolution, so the answer cannot leak
    // existence information from outside the root.
    const root = await makeTempRoot();
    try {
      const result = await containPath("../../outside.txt", root);
      expect(result).toEqual({ reasonCode: "path_escapes_workdir" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a path that is exactly `..`", async () => {
    const root = await makeTempRoot();
    try {
      const result = await containPath("..", root);
      expect(result).toEqual({ reasonCode: "path_escapes_workdir" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("containPath — workdir validation", () => {
  it("reports a missing working directory", async () => {
    const result = await containPath("a.test.ts", undefined);
    expect(result).toEqual({ reasonCode: "workdir_missing" });
  });

  it("reports a relative working directory", async () => {
    const result = await containPath("a.test.ts", "relative/dir");
    expect(result).toEqual({ reasonCode: "workdir_not_absolute" });
  });

  it("reports control characters in the working directory", async () => {
    const result = await containPath("a.test.ts", "/tmp/pro\u001fject");
    expect(result).toEqual({ reasonCode: "workdir_control_characters" });
  });

  it("reports an unresolvable working directory", async () => {
    const result = await containPath(
      "a.test.ts",
      join(tmpdir(), "squid-no-such-dir-9f2c"),
    );
    expect(result).toEqual({ reasonCode: "workdir_unresolvable" });
  });
});

describe("containPath — canonical pass against a real filesystem", () => {
  it("contains an existing file and reports its relative target", async () => {
    const { root, cleanup } = await plantProject();
    try {
      const result = await containPath("src/existing.test.ts", root);
      if (!("relativeTarget" in result)) throw new Error(JSON.stringify(result));
      expect(result.relativeTarget).toBe(join("src", "existing.test.ts"));
      expect(result.canonicalWorkingDirectory).toBe(await realpath(root));
      expect(result.canonicalTarget).toBe(await realpath(join(root, "src/existing.test.ts")));
    } finally {
      await cleanup();
    }
  });

  it("contains a not-yet-existing file whose directories all exist", async () => {
    const { root, cleanup } = await plantProject();
    try {
      const result = await containPath("src/freshly-created.test.ts", root);
      if (!("relativeTarget" in result)) throw new Error(JSON.stringify(result));
      expect(result.canonicalTarget).toBe(resolve(root, "src/freshly-created.test.ts"));
    } finally {
      await cleanup();
    }
  });

  it("contains a deep missing tail by anchoring on the deepest existing ancestor", async () => {
    const { root, cleanup } = await plantProject();
    try {
      // Neither `gen` nor anything under it exists yet; only `src` anchors the walk.
      const result = await containPath("src/gen/deep/new.test.ts", root);
      if (!("relativeTarget" in result)) throw new Error(JSON.stringify(result));
      expect(result.canonicalTarget).toBe(resolve(root, "src/gen/deep/new.test.ts"));
    } finally {
      await cleanup();
    }
  });

  it("rejects a symlinked FILE that resolves outside the root", async () => {
    const { root, cleanup } = await plantProject();
    try {
      const outsideDir = await makeTempRoot();
      await writeFile(join(outsideDir, "secret.txt"), "outside\n");
      await symlink(join(outsideDir, "secret.txt"), join(root, "leak.txt"));

      const result = await containPath("leak.txt", root);
      expect(result).toEqual({ reasonCode: "path_escapes_workdir" });
      await rm(outsideDir, { recursive: true, force: true });
    } finally {
      await cleanup();
    }
  });

  it("rejects a symlinked DIRECTORY plus a missing tail — the case resolving only the full path would miss", async () => {
    const { root, cleanup } = await plantProject();
    try {
      const outsideDir = await makeTempRoot();
      await symlink(outsideDir, join(root, "link"));

      const result = await containPath("link/planted.test.ts", root);
      expect(result).toEqual({ reasonCode: "path_escapes_workdir" });
      await rm(outsideDir, { recursive: true, force: true });
    } finally {
      await cleanup();
    }
  });

  it("canonicalizes a symlinked working directory into its real location", async () => {
    const { root, cleanup } = await plantProject();
    try {
      const alias = await makeTempRoot();
      await symlink(root, join(alias, "project"));

      const result = await containPath("src/existing.test.ts", join(alias, "project"));
      if (!("relativeTarget" in result)) throw new Error(JSON.stringify(result));
      expect(result.canonicalWorkingDirectory).toBe(await realpath(root));
      expect(result.relativeTarget.startsWith("..")).toBe(false);

      await rm(alias, { recursive: true, force: true });
    } finally {
      await cleanup();
    }
  });
});

describe("canonicalizeWorkdir", () => {
  it("accepts an absolute directory and returns its canonical form", async () => {
    const root = await makeTempRoot();
    try {
      const result = await canonicalizeWorkdir(root);
      expect("canonicalWorkingDirectory" in result).toBe(true);
      if ("canonicalWorkingDirectory" in result) {
        expect(result.canonicalWorkingDirectory).toBe(await realpath(root));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects undefined, relative, and unresolvable roots", async () => {
    expect(await canonicalizeWorkdir(undefined)).toEqual({ reasonCode: "workdir_missing" });
    expect(await canonicalizeWorkdir("relative")).toEqual({
      reasonCode: "workdir_not_absolute",
    });
    expect(
      await canonicalizeWorkdir(join(tmpdir(), "squid-no-such-dir-9f2c")),
    ).toEqual({ reasonCode: "workdir_unresolvable" });
  });
});
