import { NoBeliefsError, type BeliefProvider, type BeliefRequest } from "./belief-provider.js";
import {
  BELIEF_LIMITS,
  BELIEF_SCHEMA_VERSION,
  BELIEF_TYPE,
  type BeliefState,
  type BeliefStateBatch,
  type BeliefValue,
} from "./belief-state.js";
import type { WorldState } from "./protocol.js";

/**
 * A deterministic `BeliefProvider` derived from the projection.
 *
 * Exists for the same reason `HeuristicPredictor` does: the belief layer needs a
 * baseline that is reproducible by construction, so a model-backed producer can be
 * compared against something rather than only against itself. It is also what
 * makes the semantic gate meaningful — a gate whose baseline is nondeterministic
 * cannot measure stability.
 *
 * It is not a cognition layer and does not pretend to be. Four rules over facts
 * the projection already holds, each naming the events it read, so every belief
 * carries real evidence rather than an assertion.
 */
export class HeuristicBeliefProvider implements BeliefProvider {
  public readonly name = "heuristic-belief";

  private readonly ttlMs: number;
  private readonly random: () => string;

  public constructor(options: { readonly ttlMs?: number; readonly random?: () => string } = {}) {
    // Well inside the contract's ceiling. A belief about what someone is doing
    // goes stale in minutes, not hours, and the validator rejects anything past
    // `BELIEF_LIMITS.maxTtlMs` anyway.
    this.ttlMs = Math.min(options.ttlMs ?? 120_000, BELIEF_LIMITS.maxTtlMs);
    this.random = options.random ?? (() => crypto.randomUUID());
  }

  public async infer(request: BeliefRequest): Promise<BeliefStateBatch> {
    const inferredAt = request.triggeredAt;
    const expiresAt = new Date(Date.parse(inferredAt) + this.ttlMs).toISOString();
    const beliefs: BeliefState[] = [];

    const push = (value: BeliefValue, confidence: number, evidence: readonly string[]): void => {
      // A belief with no evidence is an assertion, and the contract rejects the
      // whole batch for one — so a rule that cannot name its events contributes
      // nothing rather than poisoning the batch.
      const evidenceEventIds = evidence.filter((id) => id.length > 0);
      if (evidenceEventIds.length === 0) return;
      beliefs.push({
        id: `${request.id}:belief:${beliefs.length}`,
        type: BELIEF_TYPE,
        value,
        confidence,
        evidenceEventIds: evidenceEventIds.slice(0, BELIEF_LIMITS.maxEvidenceEventIds),
        inferredAt,
        expiresAt,
      });
    };

    for (const rule of beliefRules(request.worldState)) {
      push(rule.value, rule.confidence, rule.evidence);
      if (beliefs.length >= BELIEF_LIMITS.maxBeliefs) break;
    }

    // No rule fired, so there is nothing to assert. The contract requires at
    // least one belief per batch, which is the right shape: "no beliefs" and "no
    // batch" must not be two different things a consumer has to distinguish.
    // Rejecting here is the documented normal outcome — the coordinator reads it
    // as "no beliefs" and the prediction proceeds untouched.
    if (beliefs.length === 0) {
      throw new NoBeliefsError(request.id);
    }

    return {
      schemaVersion: BELIEF_SCHEMA_VERSION,
      beliefBatchId: `${request.id}:beliefs`,
      projectionGeneration: request.projectionGeneration,
      episodeId: request.episodeId,
      stateDigest: request.stateDigest,
      generatedAt: inferredAt,
      provider: this.name,
      modelVersion: "heuristic-1",
      promptVersion: "none",
      contextPolicyId: request.contextPolicyId,
      beliefs,
    };
  }
}

/**
 * The rules, ordered by confidence.
 *
 * Pure and exported-by-shape so a test can reason about one rule at a time. Note
 * each rule names the *events* it read: that is what makes a belief auditable
 * back to the timeline rather than being a claim about it.
 */
function beliefRules(
  state: WorldState,
): readonly { value: BeliefValue; confidence: number; evidence: readonly string[] }[] {
  const rules: { value: BeliefValue; confidence: number; evidence: readonly string[] }[] = [];

  const failedCommand = state.lastEventKind === "terminal_command_completed"
    && state.lastCommandOutcome?.succeeded === false;
  if (failedCommand) {
    const source = state.recentActions.find((action) => action.kind === "terminal_command");
    rules.push({
      value: "debug_failure",
      confidence: 0.7,
      evidence: source === undefined ? [] : [source.sourceEventId],
    });
  }

  const save = state.recentActions.find((action) => action.kind === "file_saved");
  if (save !== undefined && state.activeApplication?.id.includes("code") === true) {
    rules.push({
      value: "validate_change",
      confidence: 0.5,
      evidence: [save.sourceEventId],
    });
  }

  const text = state.textContext;
  if (text !== null && text.selection.trim().length > 0 && state.currentBrowserPage !== null) {
    rules.push({
      value: "research_selection",
      confidence: 0.4,
      evidence: [text.sourceEventId, state.currentBrowserPage.sourceEventId],
    });
  }

  if (
    text !== null
    && text.prefix.trim().length > 0
    && (state.focus?.role === "text_input" || state.focus?.role === "editor")
  ) {
    rules.push({ value: "draft_text", confidence: 0.35, evidence: [text.sourceEventId] });
  }

  return rules.sort((left, right) => right.confidence - left.confidence);
}
