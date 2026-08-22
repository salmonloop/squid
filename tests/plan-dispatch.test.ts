import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createActionPlanRecord,
  createAttemptRecord,
  createPlanDecisionRecord,
  InMemoryPredictionLedger,
  JsonlPredictionLedger,
  type ClaimDispatchInputs,
  type PredictionLedger,
} from "../src/prediction-ledger.js";
import { SqlitePredictionLedger } from "../src/sqlite-prediction-ledger.js";

const DIGEST = `sha256:${"b".repeat(64)}`;
const PARAMS_DIGEST = `sha256:${"c".repeat(64)}`;

const baseInputs: ClaimDispatchInputs = {
  attemptId: "req-1",
  candidateId: "req-1:candidate:0",
  runtimeSessionId: "session-a",
  projectionGeneration: 3,
  stateDigest: DIGEST,
  episodeId: "ep-1",
  triggerDisposition: "accepted",
  contextPolicyId: "passthrough",
  actionTrust: "trusted",
  egressPolicyId: "search-egress-deny-v1",
  planDigest: DIGEST,
};

async function seeded(): Promise<PredictionLedger> {
  const ledger = new InMemoryPredictionLedger();
  await ledger.appendAttempt(createAttemptRecord({
    triggerEventId: "evt-1",
    episodeId: "ep-1",
    triggeredAt: "2026-08-22T10:00:00.000Z",
    completedAt: "2026-08-22T10:00:00.100Z",
    runtimeSessionId: "session-a",
    stateDigest: DIGEST,
    projectionGeneration: 3,
    triggerDisposition: "accepted",
    contextPolicyId: "passthrough",
    actionTrust: "trusted",
    egressPolicyId: "search-egress-deny-v1",
    outcome: {
      requestId: "req-1",
      provider: "fake",
      status: "succeeded",
      latencyMs: 5,
      candidates: [{
        kind: "run_tests",
        rationale: "file saved in editor",
        confidence: 0.9,
        expiresAt: "2099-01-01T00:00:00.000Z",
        sourceEventIds: [],
        parameters: { path: "src/x.test.ts" },
      }],
    },
    candidates: [{
      candidateId: "req-1:candidate:0",
      ordinal: 0,
      candidate: {
        kind: "run_tests",
        rationale: "file saved in editor",
        confidence: 0.9,
        expiresAt: "2099-01-01T00:00:00.000Z",
        sourceEventIds: [],
        parameters: { path: "src/x.test.ts" },
      },
    }],
  }));
  await ledger.recordPlan(createActionPlanRecord({
    attemptId: "req-1",
    requestId: "req-1",
    candidateId: "req-1:candidate:0",
    planDigest: DIGEST,
    candidateParametersDigest: PARAMS_DIGEST,
    confirmation: "required",
    egressPolicyId: "search-egress-deny-v1",
  }));
  return ledger;
}

describe("claim state machine (shared semantics)", () => {
  it("rejects a claim before the user accepts the plan", async () => {
    const ledger = await seeded();
    const result = await ledger.claimDispatch(
      baseInputs, new Date().toISOString(), () => "token-1",
    );
    expect(result).toEqual({ status: "rejected", reasonCode: "not_accepted" });
  });

  it("claims exactly once after acceptance and returns an opaque token", async () => {
    const ledger = await seeded();
    await ledger.recordDecision(createPlanDecisionRecord({
      planDigest: DIGEST,
      decision: "accepted",
      detailsDigest: `sha256:${"d".repeat(64)}`,
    }));
    let tokenCounter = 0;
    const first = await ledger.claimDispatch(
      baseInputs, new Date().toISOString(), () => `token-${++tokenCounter}`,
    );
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") throw new Error("unreachable");
    // Same inputs again: already claimed, never re-authorized.
    const second = await ledger.claimDispatch(
      baseInputs, new Date().toISOString(), () => `token-${++tokenCounter}`,
    );
    expect(second.status).toBe("already_claimed");
    // The token is not stored raw.
    const records = await ledger.all();
    const dispatch = records.find((r) => r.recordType === "plan_dispatch");
    expect(dispatch).toBeDefined();
    const raw = JSON.stringify(records);
    expect(raw.includes(first.claimToken)).toBe(false);
  });

  it("rejects claims whose metadata diverges from the persisted attempt", async () => {
    for (const mutate of [
      (inputs: ClaimDispatchInputs) => ({ ...inputs, projectionGeneration: 4 }),
      (inputs: ClaimDispatchInputs) => ({ ...inputs, stateDigest: `sha256:${"e".repeat(64)}` }),
      (inputs: ClaimDispatchInputs) => ({ ...inputs, actionTrust: "suggestion_only" as const }),
      (inputs: ClaimDispatchInputs) => ({ ...inputs, triggerDisposition: "late" as const }),
      (inputs: ClaimDispatchInputs) => ({ ...inputs, runtimeSessionId: "session-b" }),
      (inputs: ClaimDispatchInputs) => ({ ...inputs, episodeId: null }),
    ]) {
      const ledger = await seeded();
      await ledger.recordDecision(createPlanDecisionRecord({
        planDigest: DIGEST,
        decision: "accepted",
        detailsDigest: `sha256:${"d".repeat(64)}`,
      }));
      const result = await ledger.claimDispatch(
        mutate(baseInputs), new Date().toISOString(), () => "token-x",
      );
      expect(result.status).toBe("rejected");
    }
  });

  it("completes only with the exact claim token; conflicting outcomes are conflicts", async () => {
    const ledger = await seeded();
    await ledger.recordDecision(createPlanDecisionRecord({
      planDigest: DIGEST,
      decision: "accepted",
      detailsDigest: `sha256:${"d".repeat(64)}`,
    }));
    const claimed = await ledger.claimDispatch(
      baseInputs, new Date().toISOString(), () => "real-token",
    );
    if (claimed.status !== "claimed") throw new Error("expected claim");
    const digestA = `sha256:${"f".repeat(64)}`;
    const wrongToken = await ledger.completeDispatch(
      { planDigest: DIGEST, claimToken: "wrong" }, "succeeded", digestA,
      new Date().toISOString(),
    );
    expect(wrongToken).toEqual({ status: "conflict", reasonCode: "token_mismatch" });
    const ok = await ledger.completeDispatch(
      { planDigest: DIGEST, claimToken: claimed.claimToken }, "succeeded", digestA,
      new Date().toISOString(),
    );
    expect(ok).toEqual({ status: "completed" });
    // Identical completion is idempotent.
    const replay = await ledger.completeDispatch(
      { planDigest: DIGEST, claimToken: claimed.claimToken }, "succeeded", digestA,
      new Date().toISOString(),
    );
    expect(replay).toEqual({ status: "completed" });
    // A different outcome after a terminal one is a conflict, never a rewrite.
    const flipped = await ledger.completeDispatch(
      { planDigest: DIGEST, claimToken: claimed.claimToken }, "failed", digestA,
      new Date().toISOString(),
    );
    expect(flipped).toEqual({ status: "conflict", reasonCode: "outcome_conflict" });
  });
});

describe("ledger backend conformance for dispatch records", () => {
  /**
   * Each backend gets its own fresh directory. A shared path would hand a
   * JSONL-written text file to SQLite on the next iteration, which fails as a
   * corrupt database rather than as a semantic difference.
   */
  const backends: readonly (readonly [string, (dir: string) => PredictionLedger])[] = [
    ["sqlite", (dir) => new SqlitePredictionLedger(join(dir, "ledger.db"))],
    ["jsonl", (dir) => new JsonlPredictionLedger(join(dir, "ledger.jsonl"))],
  ];

  for (const [name, create] of backends) {
    it(`${name} matches in-memory claim semantics`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `squid-ledger-${name}-`));
      const ledger = await seededIn(create(dir));
      try {
        const rejected = await ledger.claimDispatch(
          baseInputs, new Date().toISOString(), () => "t1",
        );
        expect(rejected.status).toBe("rejected");

        await ledger.recordDecision(createPlanDecisionRecord({
          planDigest: DIGEST,
          decision: "accepted",
          detailsDigest: `sha256:${"d".repeat(64)}`,
        }));
        const claimed = await ledger.claimDispatch(
          baseInputs, new Date().toISOString(), () => "t2",
        );
        expect(claimed.status).toBe("claimed");

        const duplicate = await ledger.claimDispatch(
          baseInputs, new Date().toISOString(), () => "t3",
        );
        expect(duplicate.status).toBe("already_claimed");
      } finally {
        if (ledger instanceof SqlitePredictionLedger) {
          ledger.close();
        }
      }
    });
  }
});

describe("system-side invalidation", () => {
  /**
   * The user accepted the plan and the world then moved. That is not a second
   * user decision — the audit trail must not claim a rejection the user never
   * made — so it is recorded as a distinct invalidation, and the plan can never
   * be claimed afterwards.
   */
  it("withdraws an accepted plan without forging a user rejection", async () => {
    const ledger = await seeded();
    await ledger.recordDecision(createPlanDecisionRecord({
      planDigest: DIGEST,
      decision: "accepted",
      detailsDigest: `sha256:${"d".repeat(64)}`,
    }));

    await ledger.recordStateRejection(baseInputs, "state_changed");

    const records = await ledger.all();
    const invalidation = records.find((r) => r.recordType === "plan_invalidation");
    expect(invalidation).toMatchObject({ planDigest: DIGEST, reasonCode: "state_changed" });
    // The user's acceptance still stands as what they actually said.
    const decisions = records.filter((r) => r.recordType === "plan_decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decision: "accepted" });

    const claim = await ledger.claimDispatch(
      baseInputs, new Date().toISOString(), () => "too-late",
    );
    expect(claim).toEqual({ status: "rejected", reasonCode: "state_changed" });
  });

  it("is idempotent and agrees across backends", async () => {
    for (const create of [
      async () => new InMemoryPredictionLedger(),
      async () => new SqlitePredictionLedger(
        join(await mkdtemp(join(tmpdir(), "squid-invalidate-")), "ledger.db"),
      ),
      async () => new JsonlPredictionLedger(
        join(await mkdtemp(join(tmpdir(), "squid-invalidate-")), "ledger.jsonl"),
      ),
    ]) {
      const ledger = await seededIn(await create());
      try {
        await ledger.recordDecision(createPlanDecisionRecord({
          planDigest: DIGEST,
          decision: "accepted",
          detailsDigest: `sha256:${"d".repeat(64)}`,
        }));
        await ledger.recordStateRejection(baseInputs, "state_changed");
        // A replayed invalidation is the same fact, not a conflict.
        await ledger.recordStateRejection(baseInputs, "state_changed");

        const invalidations = (await ledger.all())
          .filter((r) => r.recordType === "plan_invalidation");
        expect(invalidations).toHaveLength(1);
        const claim = await ledger.claimDispatch(
          baseInputs, new Date().toISOString(), () => "nope",
        );
        expect(claim).toEqual({ status: "rejected", reasonCode: "state_changed" });
      } finally {
        if (ledger instanceof SqlitePredictionLedger) ledger.close();
      }
    }
  });
});

describe("concurrent claims", () => {
  /**
   * Two dispatches of one candidate racing each other. Exactly one may win: the
   * claim is what authorizes an outside-world call, so a second winner would
   * mean the same action runs twice.
   */
  it("admits exactly one winner across parallel claims", async () => {
    for (const create of [
      async () => new InMemoryPredictionLedger(),
      async () => new SqlitePredictionLedger(
        join(await mkdtemp(join(tmpdir(), "squid-race-")), "ledger.db"),
      ),
    ]) {
      const ledger = await seededIn(await create());
      try {
        await ledger.recordDecision(createPlanDecisionRecord({
          planDigest: DIGEST,
          decision: "accepted",
          detailsDigest: `sha256:${"d".repeat(64)}`,
        }));

        const now = new Date().toISOString();
        const attempts = await Promise.all(
          Array.from({ length: 8 }, (_unused, index) =>
            ledger.claimDispatch(baseInputs, now, () => `race-token-${index}`)),
        );

        const claimed = attempts.filter((result) => result.status === "claimed");
        expect(claimed).toHaveLength(1);
        // Everything else is refused, and no refusal is a fabricated success.
        expect(attempts.filter((r) => r.status === "already_claimed")).toHaveLength(7);
        const dispatches = (await ledger.all())
          .filter((record) => record.recordType === "plan_dispatch");
        expect(dispatches).toHaveLength(1);
      } finally {
        if (ledger instanceof SqlitePredictionLedger) ledger.close();
      }
    }
  });
});

describe("reconciliation across a restart", () => {
  /**
   * A claimed dispatch whose process died before completion. On reopen the
   * record must still be there, still open — that is the reconciliation signal —
   * and the stale token must not be able to close it.
   */
  it("keeps an open dispatched record and refuses a stale token after reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squid-restart-"));
    const path = join(dir, "ledger.db");

    const first = await seededIn(new SqlitePredictionLedger(path));
    let token: string;
    try {
      await first.recordDecision(createPlanDecisionRecord({
        planDigest: DIGEST,
        decision: "accepted",
        detailsDigest: `sha256:${"d".repeat(64)}`,
      }));
      const claimed = await first.claimDispatch(
        baseInputs, new Date().toISOString(), () => "survives-restart",
      );
      if (claimed.status !== "claimed") throw new Error("expected a claim");
      token = claimed.claimToken;
    } finally {
      (first as SqlitePredictionLedger).close();
    }

    // Reopen: the crash left a claimed, uncompleted dispatch.
    const reopened = new SqlitePredictionLedger(path);
    try {
      const dispatch = (await reopened.all())
        .find((record) => record.recordType === "plan_dispatch");
      expect(dispatch).toBeDefined();
      expect(dispatch).not.toHaveProperty("completedOutcome");

      // Re-claiming is refused: the action may already have run.
      const again = await reopened.claimDispatch(
        baseInputs, new Date().toISOString(), () => "second-token",
      );
      expect(again.status).toBe("already_claimed");

      // A wrong token cannot close it; the surviving token still can, because
      // reconciliation is a decision a human makes with the real outcome.
      const wrong = await reopened.completeDispatch(
        { planDigest: DIGEST, claimToken: "not-the-token" },
        "succeeded",
        `sha256:${"e".repeat(64)}`,
        new Date().toISOString(),
      );
      expect(wrong).toEqual({ status: "conflict", reasonCode: "token_mismatch" });

      const settled = await reopened.completeDispatch(
        { planDigest: DIGEST, claimToken: token },
        "succeeded",
        `sha256:${"e".repeat(64)}`,
        new Date().toISOString(),
      );
      expect(settled).toEqual({ status: "completed" });
    } finally {
      reopened.close();
    }
  });
});

async function seededIn(ledger: PredictionLedger): Promise<PredictionLedger> {
  const source = await seeded();
  for (const record of await source.all()) {
    if (record.recordType === "attempt") await ledger.appendAttempt(record);
    else if (record.recordType === "plan") await ledger.recordPlan(record);
    else if (record.recordType === "feedback") await ledger.appendFeedback(record);
    else if (record.recordType === "plan_decision") await ledger.recordDecision(record);
  }
  return ledger;
}
