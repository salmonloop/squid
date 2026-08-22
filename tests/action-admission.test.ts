import { describe, expect, it } from "bun:test";
import {
  admitAction,
  type AdmissionContext,
  type AdmissionReasonCode,
} from "../src/action-admission.js";
import {
  digestActionPlan,
  digestCandidateParameters,
  type ImmutableActionPlan,
} from "../src/action-plan.js";
import {
  SEARCH_EGRESS_ALLOW_ID,
  SEARCH_EGRESS_DENY_ID,
  type EgressPolicy,
} from "../src/action-egress.js";
import { createAttemptRecord, candidateEnvelopes } from "../src/prediction-ledger.js";
import type { PredictionAttemptRecord } from "../src/prediction-ledger.js";
import type { PredictionCandidate, WorldState } from "../src/protocol.js";
import { emptyWorldState } from "../src/protocol.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const FUTURE = "2026-08-22T12:05:00.000Z";
const STATE_DIGEST = `sha256:${"a".repeat(64)}`;
const SESSION = "session-a";
const OWNER = { applicationId: "browser", windowTitle: "Docs — Chrome" };

const ALLOW: EgressPolicy = { id: SEARCH_EGRESS_ALLOW_ID, searchEgress: "allow" };
const DENY: EgressPolicy = { id: SEARCH_EGRESS_DENY_ID, searchEgress: "deny" };

function searchCandidate(selection = "quantum tunneling"): PredictionCandidate {
  return {
    kind: "search_selection",
    rationale: "selection in a browser window",
    confidence: 0.8,
    expiresAt: FUTURE,
    sourceEventIds: ["evt-1"],
    parameters: { selection },
  };
}

function testsCandidate(path = "src/x.test.ts"): PredictionCandidate {
  return {
    kind: "run_tests",
    rationale: "file saved in a coding application",
    confidence: 0.9,
    expiresAt: FUTURE,
    sourceEventIds: ["evt-2"],
    parameters: { path },
  };
}

function searchPlan(selection = "quantum tunneling"): ImmutableActionPlan {
  return {
    planSchemaVersion: 1,
    kind: "search_selection",
    candidateId: "req-1:candidate:0",
    attemptId: "req-1",
    tool: "search_web",
    arguments: { query: selection },
    summary: `Search the web for a ${selection.length}-character selection`,
    confirmation: "none",
    canonicalWorkingDirectory: null,
    canonicalTarget: null,
  };
}

function testsPlan(target = "/repo/src/x.test.ts"): ImmutableActionPlan {
  return {
    planSchemaVersion: 1,
    kind: "run_tests",
    candidateId: "req-1:candidate:0",
    attemptId: "req-1",
    tool: "run_command",
    arguments: { command: `cd /repo && bun test -- src/x.test.ts` },
    summary: `cd /repo && bun test -- src/x.test.ts`,
    confirmation: "required",
    canonicalWorkingDirectory: "/repo",
    canonicalTarget: target,
  };
}

function attemptFor(
  candidate: PredictionCandidate,
  overrides: Partial<Parameters<typeof createAttemptRecord>[0]> = {},
): PredictionAttemptRecord {
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
    ...overrides,
  });
}

/** A world where a browser selection is the freshest observation. */
function searchState(selection = "quantum tunneling"): WorldState {
  return {
    ...emptyWorldState(),
    updatedAt: "2026-08-22T11:59:30.000Z",
    episode: { id: "ep-1", startedAt: "2026-08-22T11:00:00.000Z", eventCount: 4 },
    activeApplication: { id: "browser", name: "Chrome" },
    focus: { applicationId: "browser", windowTitle: "Docs — Chrome", role: "text_input", label: null },
    textContext: {
      owner: OWNER,
      prefix: "",
      suffix: "",
      selection,
      language: null,
      sourceEventId: "evt-1",
      observedAt: "2026-08-22T11:59:30.000Z",
      observationOrdinal: 9,
    },
    currentBrowserPage: {
      url: "https://example.com/docs",
      title: "Docs",
      host: "example.com",
      owner: OWNER,
      sourceEventId: "evt-0",
      observedAt: "2026-08-22T11:59:00.000Z",
      observationOrdinal: 4,
    },
  };
}

/** A world where the newest save came from a coding application. */
function testsState(target = "src/x.test.ts"): WorldState {
  return {
    ...emptyWorldState(),
    updatedAt: "2026-08-22T11:59:30.000Z",
    episode: { id: "ep-1", startedAt: "2026-08-22T11:00:00.000Z", eventCount: 3 },
    activeApplication: { id: "com.vscode.code", name: "VS Code" },
    recentActions: [{
      kind: "file_saved",
      occurredAt: "2026-08-22T11:59:29.000Z",
      sourceEventId: "evt-2",
      applicationId: "com.vscode.code",
      target,
      outcome: "unknown",
    }],
  };
}

function context(overrides: Partial<AdmissionContext> = {}): AdmissionContext {
  const candidate = searchCandidate();
  return {
    plan: searchPlan(),
    attempt: attemptFor(candidate),
    candidate,
    state: searchState(),
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

describe("digestActionPlan", () => {
  it("is stable across key order and distinct across content", () => {
    const plan = searchPlan();
    const reordered = {
      canonicalTarget: plan.canonicalTarget,
      canonicalWorkingDirectory: plan.canonicalWorkingDirectory,
      confirmation: plan.confirmation,
      summary: plan.summary,
      arguments: plan.arguments,
      tool: plan.tool,
      attemptId: plan.attemptId,
      candidateId: plan.candidateId,
      kind: plan.kind,
      planSchemaVersion: plan.planSchemaVersion,
    } as ImmutableActionPlan;

    expect(digestActionPlan(reordered)).toBe(digestActionPlan(plan));
    expect(digestActionPlan(searchPlan("other text"))).not.toBe(digestActionPlan(plan));
    expect(digestActionPlan(plan)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("digests candidate parameters independently of key order", () => {
    const left = digestCandidateParameters({ path: "a", selection: "b" });
    const right = digestCandidateParameters({ selection: "b", path: "a" });
    expect(left).toBe(right);
  });
});

describe("admitAction general checks", () => {
  it("admits a search whose selection, owners, and egress all line up", () => {
    expect(admitAction(context())).toEqual({ admitted: true });
  });

  it("refuses when the attempt is missing or not schema v2", () => {
    expect(refusal({ attempt: undefined })).toBe("attempt_missing");
  });

  it("refuses an unknown candidate", () => {
    expect(refusal({ candidate: undefined })).toBe("candidate_unknown");
  });

  it("refuses when runtime identity, episode, digest, or generation moved", () => {
    expect(refusal({ runtimeSessionId: "session-b" })).toBe("runtime_session_mismatch");
    expect(refusal({ state: { ...searchState(), episode: null } })).toBe("episode_mismatch");
    expect(refusal({ stateDigest: `sha256:${"b".repeat(64)}` })).toBe("state_digest_mismatch");
    expect(refusal({ projectionGeneration: 8 })).toBe("projection_generation_mismatch");
  });

  it("refuses an attempt triggered by a late event", () => {
    const candidate = searchCandidate();
    expect(refusal({
      attempt: attemptFor(candidate, { triggerDisposition: "late" }),
    })).toBe("trigger_disposition_late");
  });

  it("refuses when either the attempt or the current runtime is suggestion-only", () => {
    const candidate = searchCandidate();
    expect(refusal({
      attempt: attemptFor(candidate, { actionTrust: "suggestion_only" }),
    })).toBe("action_trust_insufficient");
    expect(refusal({ actionTrust: "suggestion_only" })).toBe("action_trust_insufficient");
  });

  it("refuses when the context or egress policy differs from the attempt", () => {
    expect(refusal({ contextPolicyId: "redacting" })).toBe("context_policy_mismatch");
    expect(refusal({ egressPolicy: DENY })).toBe("egress_policy_mismatch");
  });

  it("refuses a candidate that expired exactly now", () => {
    const candidate = { ...searchCandidate(), expiresAt: NOW.toISOString() };
    expect(refusal({ candidate, attempt: attemptFor(candidate) })).toBe("candidate_expired");
  });
});

describe("admitAction search checks", () => {
  it("refuses when egress is denied even if everything else matches", () => {
    const candidate = searchCandidate();
    expect(refusal({
      attempt: attemptFor(candidate, { egressPolicyId: SEARCH_EGRESS_DENY_ID }),
      egressPolicy: DENY,
    })).toBe("search_egress_denied");
  });

  it("refuses when the selection is gone, empty, or changed", () => {
    expect(refusal({ state: { ...searchState(), textContext: null } })).toBe("selection_empty");
    expect(refusal({ state: searchState("   ") })).toBe("selection_empty");
    expect(refusal({ state: searchState("something else") })).toBe("selection_changed");
  });

  it("refuses when no browser page is present", () => {
    expect(refusal({ state: { ...searchState(), currentBrowserPage: null } })).toBe("browser_page_missing");
  });

  it("refuses when page, selection, and foreground owners disagree", () => {
    const state = searchState();
    expect(refusal({
      state: {
        ...state,
        currentBrowserPage: { ...state.currentBrowserPage!, owner: null },
      },
    })).toBe("owner_mismatch");
    expect(refusal({
      state: {
        ...state,
        focus: { applicationId: "terminal", windowTitle: "zsh", role: "text_input", label: null },
      },
    })).toBe("owner_mismatch");
  });

  it("refuses a selection observed before the current page", () => {
    const state = searchState();
    expect(refusal({
      state: {
        ...state,
        textContext: { ...state.textContext!, observationOrdinal: 4 },
      },
    })).toBe("observation_out_of_order");
  });
});

describe("admitAction run_tests checks", () => {
  function testsContext(overrides: Partial<AdmissionContext> = {}): AdmissionContext {
    const candidate = testsCandidate();
    return context({
      plan: testsPlan(),
      candidate,
      attempt: attemptFor(candidate),
      state: testsState(),
      ...overrides,
    });
  }

  it("admits when the coding app and newest save still match the plan", () => {
    expect(admitAction(testsContext())).toEqual({ admitted: true });
  });

  it("refuses when the foreground is no longer a coding application", () => {
    const result = admitAction(testsContext({
      state: { ...testsState(), activeApplication: { id: "com.apple.finder", name: "Finder" } },
    }));
    expect(result).toEqual({ admitted: false, reasonCode: "coding_application_mismatch" });
  });

  it("refuses when the newest save came from another application", () => {
    const state = testsState();
    const result = admitAction(testsContext({
      state: {
        ...state,
        recentActions: [{ ...state.recentActions[0]!, applicationId: "com.apple.textedit" }],
      },
    }));
    expect(result).toEqual({ admitted: false, reasonCode: "coding_application_mismatch" });
  });

  it("refuses when the newest save is a different file than the plan targets", () => {
    const result = admitAction(testsContext({ state: testsState("src/other.test.ts") }));
    expect(result).toEqual({ admitted: false, reasonCode: "saved_path_mismatch" });
  });

  it("refuses a target that merely ends with the saved path's characters", () => {
    // "/repo/src/xa.ts".endsWith("a.ts") is true, but they are different files.
    // Authorization compares resolved paths, not string suffixes: otherwise
    // saving one file would authorize running any file whose name ends with it.
    const result = admitAction(testsContext({
      plan: testsPlan("/repo/src/xa.ts"),
      state: testsState("src/a.ts"),
    }));
    expect(result).toEqual({ admitted: false, reasonCode: "saved_path_mismatch" });
  });

  it("admits the saved file addressed relative to the canonical root", () => {
    const result = admitAction(testsContext({
      plan: testsPlan("/repo/src/a.ts"),
      state: testsState("src/a.ts"),
    }));
    expect(result).toEqual({ admitted: true });
  });

  it("refuses a target outside the plan's own working directory", () => {
    const result = admitAction(testsContext({
      plan: testsPlan("/elsewhere/src/x.test.ts"),
      state: testsState("src/x.test.ts"),
    }));
    expect(result).toEqual({ admitted: false, reasonCode: "saved_path_mismatch" });
  });
});
