import { describe, expect, it } from "bun:test";
import {
  admitBeliefBatch,
  quantizeConfidence,
  type ProposedBelief,
} from "../src/belief-admission.js";
import type { BeliefRequest } from "../src/belief-provider.js";
import { validateBeliefStateBatch, BELIEF_LIMITS, BELIEF_TYPE } from "../src/belief-state.js";
import { emptyWorldState } from "../src/protocol.js";

/**
 * The reducer is the half of a model-backed producer that has to be right, and it is
 * the half that needs no model: given the same proposals it must always yield the same
 * batch, and it must refuse everything the belief contract would refuse.
 *
 * These run offline in `bun test` for that reason. The measured verdict on the model
 * itself lives in `bun run gate:belief`, which costs minutes of endpoint time and has
 * no business in a test suite.
 */

const TRIGGERED_AT = "2026-08-24T09:00:03.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

/** The events a belief may cite, with when each happened. Two, both in the past. */
const CITABLE = new Map([
  ["evt-save", "2026-08-24T09:00:01.000Z"],
  ["evt-text", "2026-08-24T09:00:02.000Z"],
]);

function request(overrides: Partial<BeliefRequest> = {}): BeliefRequest {
  return {
    id: "req-1",
    worldState: emptyWorldState(),
    episodeId: "ep-1",
    stateDigest: DIGEST,
    projectionGeneration: 7,
    contextPolicyId: "redacting",
    triggeredAt: TRIGGERED_AT,
    ...overrides,
  };
}

function proposal(overrides: Partial<ProposedBelief> = {}): ProposedBelief {
  return {
    value: "validate_change",
    confidence: 0.7,
    evidenceEventIds: ["evt-save"],
    ...overrides,
  };
}

function admit(
  proposals: readonly ProposedBelief[],
  overrides: { request?: BeliefRequest; citableEvents?: ReadonlyMap<string, string>; ttlMs?: number } = {},
) {
  return admitBeliefBatch({
    proposals,
    request: overrides.request ?? request(),
    citableEvents: overrides.citableEvents ?? CITABLE,
    provider: "pi-belief",
    modelVersion: "bifrost/deepseek-v4-flash",
    promptVersion: "belief-intent-1",
    ttlMs: overrides.ttlMs ?? 120_000,
  });
}

describe("quantizeConfidence", () => {
  it("collapses a band to one value", () => {
    // The measured wobble this exists for: the same world produced 0.85 and 0.9 on
    // consecutive asks. Both must reduce to the same number or arithmetic noise can
    // reorder candidates.
    expect(quantizeConfidence(0.85)).toBe(quantizeConfidence(0.9));
    expect(quantizeConfidence(0.5)).toBe(quantizeConfidence(0.79));
    expect(quantizeConfidence(0)).toBe(quantizeConfidence(0.49));
  });

  it("keeps the bands ordered and distinct", () => {
    // Quantizing must not flatten the ordinal away: a confident belief still has to
    // outrank a weak one, or the reducer would have destroyed the only signal it kept.
    expect(quantizeConfidence(0.9)).toBeGreaterThan(quantizeConfidence(0.6));
    expect(quantizeConfidence(0.6)).toBeGreaterThan(quantizeConfidence(0.2));
  });

  it("clamps a producer that reports outside [0,1]", () => {
    expect(quantizeConfidence(4)).toBe(quantizeConfidence(1));
    expect(quantizeConfidence(-2)).toBe(quantizeConfidence(0));
  });
});

describe("admitBeliefBatch", () => {
  it("produces a batch the belief contract accepts", () => {
    const batch = admit([proposal()]);
    expect(batch).not.toBeNull();

    // Validated through the real contract rather than by inspecting fields: what
    // matters is that the resolver will accept what this produced, and the contract is
    // the only authority on that.
    const validated = validateBeliefStateBatch(batch, {
      now: TRIGGERED_AT,
      currentEpisodeId: "ep-1",
      currentStateDigest: DIGEST,
      currentProjectionGeneration: 7,
      eventOccurredAt: CITABLE,
      maxTtlMs: BELIEF_LIMITS.maxTtlMs,
    });
    expect(validated.ok).toBe(true);
  });

  it("echoes the request's projection identity instead of trusting a producer", () => {
    // A producer that reported its own digest could claim a world it never saw, and the
    // validator's equality check would then be comparing a claim against itself.
    const batch = admit([proposal()])!;
    expect(batch.stateDigest).toBe(DIGEST);
    expect(batch.projectionGeneration).toBe(7);
    expect(batch.episodeId).toBe("ep-1");
    expect(batch.contextPolicyId).toBe("redacting");
    expect(batch.generatedAt).toBe(TRIGGERED_AT);
  });

  it("reduces identical proposals to an identical batch", () => {
    // The property the whole design rests on: the model may wobble, but everything
    // downstream of it must not. Serialized rather than compared field by field, since
    // key order and array order are exactly what a ranking would pivot on.
    const proposals = [proposal(), proposal({ value: "draft_text", evidenceEventIds: ["evt-text"] })];
    expect(JSON.stringify(admit(proposals))).toBe(JSON.stringify(admit(proposals)));
  });

  it("reduces confidences inside one band to an identical batch", () => {
    // This is the measured failure mode, stated as an assertion: 0.85 and 0.9 for the
    // same world must produce byte-identical batches, so the ranking cannot move.
    const low = admit([proposal({ confidence: 0.85 })]);
    const high = admit([proposal({ confidence: 0.9 })]);
    expect(JSON.stringify(low)).toBe(JSON.stringify(high));
  });

  it("ignores the order a producer emitted its beliefs in", () => {
    const save = proposal();
    const text = proposal({ value: "draft_text", evidenceEventIds: ["evt-text"] });
    // Emission order is a property of the model's sampling, not of the world. Two
    // orderings of the same assertions are the same assertion.
    expect(JSON.stringify(admit([save, text]))).toBe(JSON.stringify(admit([text, save])));
  });

  it("orders beliefs by the vocabulary rather than by confidence", () => {
    // Sorting on confidence would reintroduce the wobble the bands removed, and a band
    // tie would then fall back to the producer's emission order.
    const batch = admit([
      proposal({ value: "draft_text", confidence: 0.95, evidenceEventIds: ["evt-text"] }),
      proposal({ value: "debug_failure", confidence: 0.1, evidenceEventIds: ["evt-save"] }),
    ])!;
    expect(batch.beliefs.map((belief) => belief.value)).toEqual(["debug_failure", "draft_text"]);
  });

  it("refuses an intent citing an event the projection cannot vouch for", () => {
    // The whole batch is not lost — only the unevidenced intent. One hallucinated
    // citation killing every belief is the contract's own behaviour, and strictly worse.
    const batch = admit([
      proposal({ evidenceEventIds: ["evt-never-happened"] }),
      proposal({ value: "draft_text", evidenceEventIds: ["evt-text"] }),
    ])!;
    expect(batch.beliefs.map((belief) => belief.value)).toEqual(["draft_text"]);
  });

  it("refuses an intent whose evidence postdates the belief", () => {
    // Evidence a belief could not have read when it was inferred is not evidence.
    const batch = admit([proposal({ evidenceEventIds: ["evt-future"] })], {
      citableEvents: new Map([...CITABLE, ["evt-future", "2026-08-24T09:00:09.000Z"]]),
    });
    expect(batch).toBeNull();
  });

  it("refuses an intent with no evidence at all", () => {
    expect(admit([proposal({ evidenceEventIds: [] })])).toBeNull();
  });

  it("drops the unknown intent rather than carrying it", () => {
    // `unknown` maps to no action, so it can never move a ranking. Carrying it would
    // let a batch look non-empty while asserting nothing an operator could read.
    expect(admit([proposal({ value: "unknown" })])).toBeNull();

    const batch = admit([proposal({ value: "unknown" }), proposal()])!;
    expect(batch.beliefs.map((belief) => belief.value)).toEqual(["validate_change"]);
  });

  it("refuses a value outside the closed vocabulary", () => {
    expect(admit([proposal({ value: "take_over_the_machine" })])).toBeNull();
  });

  it("refuses a non-finite confidence", () => {
    expect(admit([proposal({ confidence: Number.NaN })])).toBeNull();
  });

  it("collapses a repeated intent to its strongest assertion", () => {
    // A producer repeating itself must not be able to inflate a rank, and
    // `BeliefRerankCognition` keeps only the strongest anyway — so the batch should say
    // what the ranking will use.
    const batch = admit([
      proposal({ confidence: 0.2 }),
      proposal({ confidence: 0.95 }),
    ])!;
    expect(batch.beliefs).toHaveLength(1);
    expect(batch.beliefs[0]!.confidence).toBe(quantizeConfidence(0.95));
  });

  it("deduplicates and orders evidence chronologically", () => {
    const batch = admit([
      proposal({ evidenceEventIds: ["evt-text", "evt-save", "evt-text"] }),
    ])!;
    expect(batch.beliefs[0]!.evidenceEventIds).toEqual(["evt-save", "evt-text"]);
  });

  it("abstains when the producer asserted nothing", () => {
    // "Nothing to assert" is a normal answer. The caller turns null into
    // `NoBeliefsError`, which the resolver already reads as the outcome `none`.
    expect(admit([])).toBeNull();
  });

  it("keeps every belief typed as the one shipped schema", () => {
    const batch = admit([proposal()])!;
    expect(batch.beliefs.every((belief) => belief.type === BELIEF_TYPE)).toBe(true);
  });

  it("clamps a TTL beyond the contract ceiling", () => {
    const batch = admit([proposal()], { ttlMs: BELIEF_LIMITS.maxTtlMs * 10 })!;
    const lifetime = Date.parse(batch.beliefs[0]!.expiresAt)
      - Date.parse(batch.beliefs[0]!.inferredAt);
    expect(lifetime).toBe(BELIEF_LIMITS.maxTtlMs);
  });

  it("refuses a request whose trigger time is not a timestamp", () => {
    // Every belief is inferred at `triggeredAt` and expires relative to it, so an
    // unparseable one would make expiry meaningless rather than merely wrong.
    expect(admit([proposal()], { request: request({ triggeredAt: "not-a-time" }) })).toBeNull();
  });

  it("caps a producer that asserts more beliefs than the contract allows", () => {
    // Bounded by the vocabulary in practice — duplicates collapse — but the cap is what
    // keeps an untrusted producer from turning a batch into a data sink.
    const batch = admit(
      Array.from({ length: BELIEF_LIMITS.maxBeliefs + 10 }, (_unused, index) =>
        proposal({ value: index % 2 === 0 ? "validate_change" : "draft_text" })),
    )!;
    expect(batch.beliefs.length).toBeLessThanOrEqual(BELIEF_LIMITS.maxBeliefs);
  });
});
