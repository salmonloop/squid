import { describe, expect, it } from "bun:test";
import {
  NoBeliefsError,
  validateBatchAgainstRequest,
  type BeliefProvider,
  type BeliefRequest,
} from "../src/belief-provider.js";
import { BELIEF_LIMITS, validateBeliefStateBatch, type BeliefStateBatch } from "../src/belief-state.js";
import { BeliefBackedPredictionProvider, type CognitionProvider } from "../src/cognition-provider.js";
import { HeuristicBeliefProvider } from "../src/heuristic-belief-provider.js";
import { candidate } from "../src/fake-prediction-provider.js";
import { emptyWorldState, type PredictionCandidate, type WorldState } from "../src/protocol.js";
import type { PredictionRequest } from "../src/prediction-provider.js";

const EPISODE = "ep-1";
const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = "2026-08-22T12:00:00.000Z";
const EVENT_AT = "2026-08-22T11:59:00.000Z";

function request(overrides: Partial<BeliefRequest> = {}): BeliefRequest {
  return {
    id: "req-1",
    worldState: emptyWorldState(),
    episodeId: EPISODE,
    stateDigest: DIGEST,
    projectionGeneration: 3,
    contextPolicyId: "passthrough",
    triggeredAt: EVENT_AT,
    ...overrides,
  };
}

/** A world where a test command just failed. */
function failedCommandState(): WorldState {
  return {
    ...emptyWorldState(),
    updatedAt: EVENT_AT,
    episode: { id: EPISODE, startedAt: "2026-08-22T11:00:00.000Z", eventCount: 2 },
    lastEventKind: "terminal_command_completed",
    lastCommandOutcome: { commandClass: "test", succeeded: false, exitCode: 1 },
    recentActions: [{
      kind: "terminal_command",
      occurredAt: EVENT_AT,
      sourceEventId: "evt-cmd",
      applicationId: null,
      target: "test",
      outcome: "failed",
    }],
  };
}

/** A world where a code file was saved in an editor. */
function savedInEditorState(): WorldState {
  return {
    ...emptyWorldState(),
    updatedAt: EVENT_AT,
    episode: { id: EPISODE, startedAt: "2026-08-22T11:00:00.000Z", eventCount: 2 },
    activeApplication: { id: "com.vscode.code", name: "VS Code" },
    recentActions: [{
      kind: "file_saved",
      occurredAt: EVENT_AT,
      sourceEventId: "evt-save",
      applicationId: "com.vscode.code",
      target: "src/x.ts",
      outcome: "succeeded",
    }],
  };
}

function validationContext(eventIds: readonly string[]) {
  return {
    now: NOW,
    currentEpisodeId: EPISODE,
    currentStateDigest: DIGEST,
    currentProjectionGeneration: 3,
    eventOccurredAt: new Map(eventIds.map((id) => [id, EVENT_AT])),
    maxTtlMs: BELIEF_LIMITS.maxTtlMs,
  };
}

describe("HeuristicBeliefProvider", () => {
  it("produces a batch the contract accepts", async () => {
    const provider = new HeuristicBeliefProvider();
    const batch = await provider.infer(request({ worldState: failedCommandState() }));

    const validated = validateBeliefStateBatch(batch, validationContext(["evt-cmd"]));
    expect(validated.ok).toBe(true);
    expect(batch.beliefs.map((belief) => belief.value)).toEqual(["debug_failure"]);
  });

  it("names the events each belief was inferred from", async () => {
    const provider = new HeuristicBeliefProvider();
    const batch = await provider.infer(request({ worldState: failedCommandState() }));
    // Evidence is what makes a belief auditable back to the timeline rather than
    // a claim about it. The contract rejects a batch containing an unevidenced
    // belief, so this is enforced, not merely conventional.
    expect(batch.beliefs[0]!.evidenceEventIds).toEqual(["evt-cmd"]);
  });

  it("refuses rather than asserting a rule that cannot name its evidence", async () => {
    // A failing command with no recorded action to point at: the rule matches but
    // has nothing to cite. Emitting it unevidenced would invalidate the whole
    // batch, so the rule contributes nothing — and with no other rule firing,
    // there is nothing to assert at all.
    //
    // The contract requires `minItems: 1`, which is deliberate: "no beliefs" and
    // "no batch" must not be two states a consumer has to tell apart. So the
    // provider rejects with `NoBeliefsError`, which the shadow runner maps to
    // status "none" — a normal outcome, never a reported failure.
    const state: WorldState = {
      ...failedCommandState(),
      recentActions: [],
    };
    await expect(
      new HeuristicBeliefProvider().infer(request({ worldState: state })),
    ).rejects.toBeInstanceOf(NoBeliefsError);
  });

  it("is deterministic for identical state, which is what a gate can measure", async () => {
    const provider = new HeuristicBeliefProvider();
    const state = savedInEditorState();
    const first = await provider.infer(request({ worldState: state }));
    const second = await provider.infer(request({ worldState: state }));
    expect(second.beliefs.map((b) => [b.value, b.confidence, b.evidenceEventIds]))
      .toEqual(first.beliefs.map((b) => [b.value, b.confidence, b.evidenceEventIds]));
  });

  it("orders beliefs by confidence", async () => {
    // A world matching two rules at once: a failed command and a save in an editor.
    const state: WorldState = { ...failedCommandState(), ...savedInEditorState(),
      lastEventKind: "terminal_command_completed",
      lastCommandOutcome: { commandClass: "test", succeeded: false, exitCode: 1 },
      recentActions: [
        ...failedCommandState().recentActions,
        ...savedInEditorState().recentActions,
      ],
    };
    const batch = await new HeuristicBeliefProvider().infer(request({ worldState: state }));
    const confidences = batch.beliefs.map((belief) => belief.confidence);
    expect([...confidences].sort((a, b) => b - a)).toEqual(confidences);
  });

  it("caps its own TTL below the contract ceiling", async () => {
    const provider = new HeuristicBeliefProvider({ ttlMs: BELIEF_LIMITS.maxTtlMs * 10 });
    const batch = await provider.infer(request({ worldState: failedCommandState() }));
    const belief = batch.beliefs[0]!;
    const ttl = Date.parse(belief.expiresAt) - Date.parse(belief.inferredAt);
    expect(ttl).toBeLessThanOrEqual(BELIEF_LIMITS.maxTtlMs);
  });
});

/**
 * A provider's own claim that its batch is valid is not evidence. These checks
 * exist because a batch describing a different episode, digest, generation, or
 * context policy is about a world that no longer exists — and a consumer cannot
 * tell a stale belief from a fresh one by looking at it.
 */
describe("validateBatchAgainstRequest", () => {
  async function batchFor(overrides: Partial<BeliefRequest> = {}): Promise<{
    readonly batch: BeliefStateBatch;
    readonly request: BeliefRequest;
  }> {
    const req = request({ worldState: failedCommandState(), ...overrides });
    return { batch: await new HeuristicBeliefProvider().infer(req), request: req };
  }

  it("accepts a batch that agrees with the request it answered", async () => {
    const { batch, request: req } = await batchFor();
    const result = validateBatchAgainstRequest(batch, req, validationContext(["evt-cmd"]));
    expect(result.ok).toBe(true);
  });

  it("refuses a batch whose episode, digest, generation, or policy moved", async () => {
    const { batch, request: req } = await batchFor();
    const context = validationContext(["evt-cmd"]);

    for (const [field, value, reason] of [
      ["episodeId", "ep-2", "episode_mismatch"],
      ["stateDigest", `sha256:${"b".repeat(64)}`, "state_digest_mismatch"],
      ["projectionGeneration", 4, "projection_generation_mismatch"],
      ["contextPolicyId", "redacting", "context_policy_mismatch"],
    ] as const) {
      const result = validateBatchAgainstRequest(
        { ...batch, [field]: value },
        req,
        context,
      );
      // Some divergences are caught by the shared validator first (it compares
      // against the same current values), so either that or the specific
      // mismatch is correct — what matters is that none of them is accepted.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect([reason, "batch_invalid"]).toContain(result.reasonCode);
      }
    }
  });

  it("refuses a malformed batch outright", async () => {
    const { request: req } = await batchFor();
    const context = validationContext(["evt-cmd"]);
    for (const malformed of [null, {}, { schemaVersion: 99 }, "a string"]) {
      const result = validateBatchAgainstRequest(malformed, req, context);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe("batch_invalid");
    }
  });

  it("refuses a batch citing an event the timeline does not contain", async () => {
    const { batch, request: req } = await batchFor();
    // Evidence must be real. An unknown event ID means the belief cannot be
    // audited, which the contract treats as fatal for the whole batch.
    const result = validateBatchAgainstRequest(batch, req, validationContext([]));
    expect(result.ok).toBe(false);
  });
});

describe("BeliefBackedPredictionProvider", () => {
  const liveRequest: PredictionRequest = {
    id: "req-1",
    worldState: failedCommandState(),
    episodeId: EPISODE,
    triggeredAt: EVENT_AT,
  };

  function cognitionSpy(): {
    readonly provider: CognitionProvider;
    readonly seen: (BeliefStateBatch | null)[];
  } {
    const seen: (BeliefStateBatch | null)[] = [];
    return {
      seen,
      provider: {
        name: "spy-cognition",
        predict: async (req) => {
          seen.push(req.beliefs);
          return [candidate("inspect_error", 0.7)];
        },
      },
    };
  }

  it("passes resolved beliefs through to cognition", async () => {
    const spy = cognitionSpy();
    const batch = await new HeuristicBeliefProvider().infer(request({ worldState: failedCommandState() }));
    const provider = new BeliefBackedPredictionProvider(spy.provider, async () => batch);

    const candidates = await provider.predict(liveRequest, new AbortController().signal);
    expect(candidates.map((c) => c.kind)).toEqual(["inspect_error"]);
    expect(spy.seen[0]).toBe(batch);
  });

  /**
   * The belief layer must never be on the critical path. An unreachable or broken
   * belief producer degrades to cognition-from-state, and the coordinator's own
   * heuristic fallback still sits underneath that.
   */
  it("degrades to null beliefs when the resolver rejects", async () => {
    const spy = cognitionSpy();
    const provider = new BeliefBackedPredictionProvider(spy.provider, async () => {
      throw new Error("belief provider unreachable");
    });

    const candidates = await provider.predict(liveRequest, new AbortController().signal);
    expect(candidates.map((c) => c.kind)).toEqual(["inspect_error"]);
    expect(spy.seen[0]).toBeNull();
  });

  it("degrades to null beliefs when the resolver returns nothing", async () => {
    const spy = cognitionSpy();
    const provider = new BeliefBackedPredictionProvider(spy.provider, async () => null);
    await provider.predict(liveRequest, new AbortController().signal);
    expect(spy.seen[0]).toBeNull();
  });

  it("lets a cognition failure surface, since that is a prediction failure", async () => {
    // Distinct from a belief failure: if cognition itself cannot answer, there is
    // no prediction, and the coordinator's fallback is what handles it.
    const provider = new BeliefBackedPredictionProvider(
      { name: "broken", predict: async () => { throw new Error("cognition failed"); } },
      async () => null,
    );
    await expect(provider.predict(liveRequest, new AbortController().signal))
      .rejects.toThrow("cognition failed");
  });

  it("reports the cognition provider's own name", async () => {
    const provider = new BeliefBackedPredictionProvider(cognitionSpy().provider, async () => null);
    expect(provider.name).toBe("spy-cognition");
  });

  it("forwards the abort signal so a cancelled prediction cancels cognition", async () => {
    let seenAborted: boolean | undefined;
    const provider = new BeliefBackedPredictionProvider(
      {
        name: "signal-spy",
        predict: async (_req, signal) => {
          seenAborted = signal.aborted;
          return [];
        },
      },
      async () => null,
    );
    const controller = new AbortController();
    controller.abort();
    await provider.predict(liveRequest, controller.signal);
    expect(seenAborted).toBe(true);
  });
});
