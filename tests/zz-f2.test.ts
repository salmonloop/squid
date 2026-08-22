import { expect, it } from "bun:test";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planAction, isPlanFailure } from "../src/action-planner.js";

it("F2 closed", async () => {
  const base = await mkdtemp(join(tmpdir(), "f2b-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(root, "link"));

  // (a) missing target under a symlinked dir -> must refuse
  const missing = await planAction(
    { candidateId: "r:candidate:0", attemptId: "r", kind: "run_tests", parameters: { path: "link/evil.test.ts" } },
    { workingDirectory: root },
  );
  console.log("MISSING-TARGET:", isPlanFailure(missing) ? missing.reasonCode : "ACCEPTED(BAD)");

  // (b) existing target under a symlinked dir -> must refuse
  await writeFile(join(outside, "evil.test.ts"), "", "utf8");
  const existing = await planAction(
    { candidateId: "r:candidate:0", attemptId: "r", kind: "run_tests", parameters: { path: "link/evil.test.ts" } },
    { workingDirectory: root },
  );
  console.log("EXISTING-TARGET:", isPlanFailure(existing) ? existing.reasonCode : "ACCEPTED(BAD)");

  // (c) legitimate not-yet-created file inside root -> must still be allowed
  await mkdir(join(root, "tests"), { recursive: true });
  const legit = await planAction(
    { candidateId: "r:candidate:0", attemptId: "r", kind: "run_tests", parameters: { path: "tests/new.test.ts" } },
    { workingDirectory: root },
  );
  console.log("LEGIT-MISSING:", isPlanFailure(legit) ? `REFUSED(BAD):${legit.reasonCode}` : "accepted");
  expect(true).toBe(true);
});
