import type { ProjectProfile } from "../../src/project-detect.js";

/**
 * The project profile every planner-side test injects.
 *
 * These tests exercise containment, quoting, digests, and dispatch — not
 * ecosystem detection, which has its own suite (`tests/project-detect.test.ts`).
 * Injecting the profile keeps them independent of whatever markers happen to be
 * in a temp directory, and pins the exact commands the old hardcoded table
 * produced, so behaviour parity is explicit rather than accidental.
 */
export const bunProject: ProjectProfile = {
  ecosystem: "bun",
  commands: {
    test: ["bun", "test"],
    lint: ["bun", "run", "lint"],
    typecheck: ["bun", "run", "typecheck"],
  },
};
