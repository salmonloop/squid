import { describe, expect, it } from "bun:test";
import {
  admitAction,
  type AdmissionContext,
} from "../src/action-admission.js";
import { SEARCH_EGRESS_ALLOW_ID, type EgressPolicy } from "../src/action-egress.js";
import { createAttemptRecord, candidateEnvelopes } from "../src/prediction-ledger.js";
import { createActivityEvent, emptyWorldState } from "../src/protocol.js";
import type { ImmutableActionPlan } from "../src/action-plan.js";
import type { PredictionCandidate, PredictionAttemptRecord, WorldState } from "../src/protocol.js";
import { SquidCore } from "../src/squid-core.js";
import { InMemoryEventStore } from "../src/event-store.js";

/**
 * The end-to-end guarantee issue #7 asks for, pinned deterministically: a save
 * carrying the editor's own pid flows through the real reducer into the
 * unchanged `admitRunTests` equality check and comes out admitted — while a
 * save whose pid does not match the foreground is still refused.
 *
 * The identity used here is a unix pid because that is what
 * `screen-text-reader-macos` reports for the foreground process; the plain
 * equality between the two IS the design — no translation layer exists to
 * paper over a mismatch.
 */
const EDITOR_PID = 4242;
const NOW = new Date("2026-08-22T12:00:00.000Z");
const FUTURE = "2026-08-22T12:05:00.000Z";
const STATE_DIGEST = `sha256:${"a".repeat(64)}`;
const SESSION = "session-a";
const ALLOW: EgressPolicy = { id: SEARCH_EGRESS_ALLOW_ID, searchEgress: "allow" };

function testsCandidate(): PredictionCandidate {
  return {
    kind: "run_tests",
    toolId: "run_tests",
    rationale: "file saved by the editor itself",
    confidence: 0.9,
    expiresAt: FUTURE,
    sourceEventIds: ["evt-save"],
    parameters: { path: "src/a.test.ts" },
  };
}

function testsPlan(): ImmutableActionPlan {
  return {
    planSchemaVersion: 1,
    kind: "run_tests",
    descriptorId: "run_tests",
    candidateId: "req-1:candidate:0",
    attemptId: "req-1",
    tool: "run_command",
    arguments: { command: "cd /workspace/project && bun test -- src/a.test.ts" },
    summary: "cd /workspace/project && bun test -- src/a.test.ts",
    confirmation: "required",
    canonicalWorkingDirectory: "/workspace/project",
    canonicalTarget: "/workspace/project/src/a.test.ts",
  };
}

function attemptFor(
  candidate: PredictionCandidate,
  episodeId: string | null,
): PredictionAttemptRecord {
  const outcome = {
    requestId: "req-1",
    provider: "fake",
    status: "succeeded" as const,
    latencyMs: 4,
    candidates: [candidate],
  };
  return createAttemptRecord({
    triggerEventId: "evt-save",
    episodeId,
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

async function coreWithForeground(pid: number): Promise<WorldState> {
  const core = new SquidCore(new InMemoryEventStore());
  await core.ingest(createActivityEvent({
    kind: "application_activated",
    payload: { applicationId: String(pid), applicationName: "Code" },
  }));
  await core.ingest(createActivityEvent({
    kind: "focus_changed",
    payload: {
      applicationId: String(pid),
      windowTitle: "a.test.ts — project",
      role: "editor",
      label: null,
    },
  }));
  const result = await core.ingest(createActivityEvent({
    kind: "file_saved",
    eventId: "evt-save",
    payload: { path: "src/a.test.ts", applicationId: String(pid) },
    source: { kind: "ide", instanceId: "editor-save-host" },
  }));
  return result.state;
}

describe("editor-attributed save admission", () => {
  it("admits run_tests on an editor-reported save with no rule change", async () => {
    // Same pid for writer and foreground: the projection carried the owner
    // through — the fact the watcher could never report — and the unchanged
    // equality check accepts it.
    const state = await coreWithForeground(EDITOR_PID);
    expect(state.recentActions[0]).toMatchObject({
      kind: "file_saved",
      applicationId: String(EDITOR_PID),
      target: "src/a.test.ts",
    });

    const candidate = testsCandidate();
    const context: AdmissionContext = {
      plan: testsPlan(),
      attempt: attemptFor(candidate, state.episode?.id ?? null),
      candidate,
      state,
      runtimeSessionId: SESSION,
      stateDigest: STATE_DIGEST,
      projectionGeneration: 7,
      contextPolicyId: "passthrough",
      actionTrust: "trusted",
      egressPolicy: ALLOW,
      now: NOW,
    };
    expect(admitAction(context)).toEqual({ admitted: true });
  });

  it("still refuses when another editor wrote while Code is in front", async () => {
    // The distinction issue #7 exists to make: ownership comes from the frame,
    // not from whatever was in front. A different writing pid fails the same
    // equality check that foreground inference would have passed.
    const state = await coreWithForeground(EDITOR_PID);
    const candidate = testsCandidate();
    const context: AdmissionContext = {
      plan: testsPlan(),
      attempt: attemptFor(candidate, state.episode?.id ?? null),
      candidate,
      state: {
        ...state,
        recentActions: [{ ...state.recentActions[0]!, applicationId: "9999" }],
      },
      runtimeSessionId: SESSION,
      stateDigest: STATE_DIGEST,
      projectionGeneration: 7,
      contextPolicyId: "passthrough",
      actionTrust: "trusted",
      egressPolicy: ALLOW,
      now: NOW,
    };
    expect(admitAction(context)).toEqual({
      admitted: false,
      reasonCode: "coding_application_mismatch",
    });
  });

  it("leaves the watcher's unattributed save refused, as before", async () => {
    // The filesystem source keeps reporting null and the negative fixture's
    // guarantee survives this change untouched.
    const state: WorldState = {
      ...emptyWorldState(),
      activeApplication: { id: String(EDITOR_PID), name: "Code" },
      recentActions: [{
        kind: "file_saved",
        occurredAt: NOW.toISOString(),
        sourceEventId: "evt-watcher",
        applicationId: null,
        target: "src/a.test.ts",
        outcome: "unknown",
      }],
    };
    const candidate = testsCandidate();
    const context: AdmissionContext = {
      plan: testsPlan(),
      attempt: attemptFor(candidate, state.episode?.id ?? null),
      candidate,
      state,
      runtimeSessionId: SESSION,
      stateDigest: STATE_DIGEST,
      projectionGeneration: 7,
      contextPolicyId: "passthrough",
      actionTrust: "trusted",
      egressPolicy: ALLOW,
      now: NOW,
    };
    expect(admitAction(context)).toEqual({
      admitted: false,
      reasonCode: "coding_application_mismatch",
    });
  });
});
