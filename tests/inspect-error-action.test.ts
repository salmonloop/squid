import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitAction,
  type AdmissionContext,
  type AdmissionReasonCode,
} from "../src/action-admission.js";
import type { ImmutableActionPlan } from "../src/action-plan.js";
import { declaredChecks } from "../src/tool-descriptors.js";
import { isPlanFailure, planAction } from "../src/action-planner.js";
import { bunProject } from "./fixtures/bun-project.js";
import { SEARCH_EGRESS_ALLOW_ID, type EgressPolicy } from "../src/action-egress.js";
import { candidateEnvelopes, createAttemptRecord } from "../src/prediction-ledger.js";
import type { PredictionCandidate, WorldState } from "../src/protocol.js";
import { emptyWorldState } from "../src/protocol.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const FUTURE = "2026-08-22T12:05:00.000Z";
const STATE_DIGEST = `sha256:${"a".repeat(64)}`;
const SESSION = "session-a";
const ALLOW: EgressPolicy = { id: SEARCH_EGRESS_ALLOW_ID, searchEgress: "allow" };

const identity = { candidateId: "req-1:candidate:0", attemptId: "req-1" } as const;

function inspectCandidate(commandClass = "test"): PredictionCandidate {
  return {
    kind: "inspect_error",
    toolId: "run_check",
    rationale: "the most recent terminal command failed",
    confidence: 0.7,
    expiresAt: FUTURE,
    sourceEventIds: ["evt-1"],
    parameters: { commandClass, exitCode: 1 },
  };
}

/** A world where the newest fact is a failing command of the given class. */
function failedCommandState(commandClass = "test", succeeded = false): WorldState {
  return {
    ...emptyWorldState(),
    updatedAt: "2026-08-22T11:59:30.000Z",
    episode: { id: "ep-1", startedAt: "2026-08-22T11:00:00.000Z", eventCount: 2 },
    lastEventKind: "terminal_command_completed",
    lastCommandOutcome: { commandClass, succeeded, exitCode: succeeded ? 0 : 1 },
  };
}

function attemptFor(candidate: PredictionCandidate) {
  const outcome = {
    requestId: "req-1",
    provider: "fake",
    status: "succeeded" as const,
    latencyMs: 4,
    candidates: [candidate],
  };
  return createAttemptRecord({
    triggerEventId: "evt-1",
    episodeId: "ep-1",
    triggeredAt: "2026-08-22T11:59:00.000Z",
    completedAt: "2026-08-22T11:59:00.100Z",
    runtimeSessionId: SESSION,
    stateDigest: STATE_DIGEST,
    projectionGeneration: 7,
    triggerDisposition: "accepted",
    contextPolicyId: "passthrough",
    actionTrust: "trusted",
    egressPolicyId: SEARCH_EGRESS_ALLOW_ID,
    outcome,
    candidates: candidateEnvelopes("req-1", outcome.candidates),
  });
}

function inspectPlan(commandClass = "test"): ImmutableActionPlan {
  return {
    planSchemaVersion: 1,
    kind: "inspect_error",
    descriptorId: "run_check",
    candidateId: identity.candidateId,
    attemptId: identity.attemptId,
    tool: "run_command",
    arguments: { command: `cd /repo && bun test` },
    summary: `cd /repo && bun test`,
    confirmation: "required",
    canonicalWorkingDirectory: "/repo",
    canonicalTarget: null,
  };
}

function context(overrides: Partial<AdmissionContext> = {}): AdmissionContext {
  const candidate = inspectCandidate();
  return {
    plan: inspectPlan(),
    attempt: attemptFor(candidate),
    candidate,
    state: failedCommandState(),
    runtimeSessionId: SESSION,
    stateDigest: STATE_DIGEST,
    projectionGeneration: 7,
    contextPolicyId: "passthrough",
    actionTrust: "trusted",
    egressPolicy: ALLOW,
    now: NOW,
    ...overrides,
  };
}

function refusal(overrides: Partial<AdmissionContext>): AdmissionReasonCode | "admitted" {
  const result = admitAction(context(overrides));
  return result.admitted ? "admitted" : result.reasonCode;
}

/**
 * The capability mapping is narrow because the captured fact is narrow.
 * `TerminalCommandCompletedPayload` holds a class, a flag, and an exit code — no
 * command text, no output, no working directory — so "show me the failing output"
 * cannot be served from history. Re-running the project's script for the class is
 * the only option the recorded fact supports.
 */
describe("planAction for inspect_error", () => {
  it("plans the project script for each re-runnable class", async () => {
    const root = await mkdtemp(join(tmpdir(), "squid-inspect-"));
    const expected: Record<string, string> = {
      test: "bun test",
      lint: "bun run lint",
      typecheck: "bun run typecheck",
    };
    for (const commandClass of declaredChecks(bunProject)) {
      const planned = await planAction(
        { ...identity, toolId: "run_check", parameters: { commandClass } },
        { workingDirectory: root, project: bunProject },
      );
      if (isPlanFailure(planned)) throw new Error(`${commandClass}: ${planned.reasonCode}`);
      expect(planned.plan.arguments.command).toContain(expected[commandClass]!);
      expect(planned.plan.tool).toBe("run_command");
      // Bypassed at registration (issue #11), same posture as run_tests: the
      // plan carries what the descriptor declares.
      expect(planned.plan.confirmation).toBe("none");
      // No path parameter, so there is no path boundary for the gateway to
      // re-verify before the call.
      expect(planned.plan.canonicalTarget).toBeNull();
    }
  });

  /**
   * The list is a subset of what `classifyCommand` can report, and the exclusions
   * are the point: a failed `kubectl apply` must not propose running itself
   * again, and a failed `bun install` must not re-touch the network and lockfile.
   */
  it("refuses classes that are not safe to run again", async () => {
    const root = await mkdtemp(join(tmpdir(), "squid-inspect-"));
    for (const commandClass of ["install", "vcs", "container", "other", "build"]) {
      const planned = await planAction(
        { ...identity, toolId: "run_check", parameters: { commandClass } },
        { workingDirectory: root, project: bunProject },
      );
      expect(isPlanFailure(planned) && planned.reasonCode).toBe("parameters_invalid");
    }
  });

  it("refuses a missing, non-string, or unknown class", async () => {
    const root = await mkdtemp(join(tmpdir(), "squid-inspect-"));
    for (const parameters of [{}, { commandClass: 7 }, { commandClass: "" }, { commandClass: "TEST" }]) {
      const planned = await planAction(
        { ...identity, toolId: "run_check", parameters },
        { workingDirectory: root, project: bunProject },
      );
      expect(isPlanFailure(planned) && planned.reasonCode).toBe("parameters_invalid");
    }
  });

  it("requires an absolute, resolvable working directory", async () => {
    const missing = await planAction({
      ...identity,
      toolId: "run_check",
      parameters: { commandClass: "test" },
    }, { project: bunProject });
    expect(isPlanFailure(missing) && missing.reasonCode).toBe("workdir_missing");

    const relative = await planAction(
      { ...identity, toolId: "run_check", parameters: { commandClass: "test" } },
      { workingDirectory: "relative/dir", project: bunProject },
    );
    expect(isPlanFailure(relative) && relative.reasonCode).toBe("workdir_not_absolute");

    const absent = await planAction(
      { ...identity, toolId: "run_check", parameters: { commandClass: "test" } },
      { workingDirectory: "/definitely/not/here", project: bunProject },
    );
    expect(isPlanFailure(absent) && absent.reasonCode).toBe("workdir_unresolvable");
  });

  it("quotes the canonical root so a space in a path cannot split the command", async () => {
    const base = await mkdtemp(join(tmpdir(), "squid inspect "));
    const planned = await planAction(
      { ...identity, toolId: "run_check", parameters: { commandClass: "test" } },
      { workingDirectory: base, project: bunProject },
    );
    if (isPlanFailure(planned)) throw new Error(planned.reasonCode);
    const command = String(planned.plan.arguments.command);
    // shell-quote wraps or escapes; either way the raw unescaped space must not
    // appear directly after `cd `.
    expect(command.startsWith(`cd ${base} &&`)).toBe(false);
    expect(command).toContain("bun test");
  });

  it("produces a stable digest for the same class and root", async () => {
    const root = await mkdtemp(join(tmpdir(), "squid-inspect-"));
    const build = (commandClass: string) => planAction(
      { ...identity, toolId: "run_check", parameters: { commandClass } },
      { workingDirectory: root, project: bunProject },
    );
    const first = await build("test");
    const second = await build("test");
    const other = await build("lint");
    if (isPlanFailure(first) || isPlanFailure(second) || isPlanFailure(other)) {
      throw new Error("planning failed");
    }
    expect(first.planDigest).toBe(second.planDigest);
    expect(first.planDigest).not.toBe(other.planDigest);
  });
});

describe("admitAction for inspect_error", () => {
  it("admits when the same class is still failing", () => {
    expect(admitAction(context())).toEqual({ admitted: true });
  });

  it("refuses when no command outcome is in the projection", () => {
    expect(refusal({ state: { ...failedCommandState(), lastCommandOutcome: null } }))
      .toBe("command_outcome_missing");
  });

  /**
   * The check that matters in practice. A user who fixes the problem and re-runs
   * successfully before confirming must not then have the old failure's re-run
   * executed — success is the reason to drop the action, not a weaker failure.
   */
  it("refuses once the command has succeeded", () => {
    expect(refusal({ state: failedCommandState("test", true) })).toBe("command_succeeded");
  });

  it("refuses when a different class failed since the prediction", () => {
    expect(refusal({ state: failedCommandState("lint") })).toBe("command_outcome_changed");
  });

  it("refuses when the candidate names no class at all", () => {
    const candidate: PredictionCandidate = {
      ...inspectCandidate(),
      parameters: { exitCode: 1 },
    };
    expect(refusal({ candidate, attempt: attemptFor(candidate) }))
      .toBe("command_outcome_changed");
  });

  it("still enforces every general check", () => {
    // The per-kind branch runs last, so an inspect_error plan is refused on
    // identity and freshness exactly like the other kinds.
    expect(refusal({ runtimeSessionId: "session-b" })).toBe("runtime_session_mismatch");
    expect(refusal({ projectionGeneration: 8 })).toBe("projection_generation_mismatch");
    expect(refusal({ actionTrust: "suggestion_only" })).toBe("action_trust_insufficient");
    const expired = { ...inspectCandidate(), expiresAt: NOW.toISOString() };
    expect(refusal({ candidate: expired, attempt: attemptFor(expired) }))
      .toBe("candidate_expired");
  });
});
