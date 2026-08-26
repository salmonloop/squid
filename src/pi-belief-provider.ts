import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describeErrorForAudit } from "./action-egress.js";
import {
  admitBeliefBatch,
  beliefSystemPrompt,
  BELIEF_PROMPT_VERSION,
  type ProposedBelief,
} from "./belief-admission.js";
import { evidenceTimeline } from "./belief-evidence.js";
import { NoBeliefsError, type BeliefProvider, type BeliefRequest } from "./belief-provider.js";
import { beliefValues, type BeliefStateBatch } from "./belief-state.js";
import {
  createPiSession,
  resolveModel,
  resolvePiModel,
  startPiModelRuntime,
  type ModelRuntime,
  type ResolvedModel,
} from "./pi-session-factory.js";

/**
 * A model-backed `BeliefProvider`: the model names the intent, a pure reducer decides.
 *
 * This is the producer the belief seam was built for. `HeuristicBeliefProvider` reads
 * the same projection as `HeuristicPredictor` with the same kind of rules, so it adds
 * structure and measurability rather than understanding; a model can name an intent no
 * rule states.
 *
 * What it cannot do is repeat itself. A hosted endpoint is nondeterministic for reasons
 * that live in the serving kernels rather than in the caller, and the SDK exposes no
 * sampling controls at all — `thinkingLevel` and nothing else, no temperature, no seed.
 * So this class is deliberately thin: talk to the model, hand the raw proposals to
 * `admitBeliefBatch`, and abstain when nothing survives. Every property a ranking could
 * pivot on is decided there, offline and testable; see that module for why.
 *
 * The question asked here is narrower than `PiRuntime`'s. `PiRuntime` asks for an
 * action with parameters and a rationale; this asks only which intents from a closed
 * five-value vocabulary hold, each citing events from a list the prompt supplies. The
 * narrower question is the one the belief contract can check.
 */

/**
 * Well inside the contract ceiling, and matching `HeuristicBeliefProvider`. A belief
 * about what someone is doing goes stale in minutes; a longer claim would be a producer
 * overreaching rather than a producer being useful.
 */
const DEFAULT_TTL_MS = 120_000;

export interface PiBeliefProviderOptions {
  readonly provider?: string;
  readonly modelId?: string;
  readonly ttlMs?: number;
}

export class PiBeliefProvider implements BeliefProvider {
  public readonly name = "pi-belief";

  private readonly provider: string;
  private readonly modelId: string;
  private readonly ttlMs: number;
  private readonly modelRuntimePromise: Promise<ModelRuntime>;

  public constructor(options: PiBeliefProviderOptions = {}) {
    const resolved = resolvePiModel(options);
    this.provider = resolved.provider;
    this.modelId = resolved.modelId;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.modelRuntimePromise = startPiModelRuntime();
  }

  /**
   * Returns a reason when the configured model cannot be resolved, or null when it can.
   * The constructor cannot report this — it only starts the runtime — and a gate needs
   * the distinction: an unreachable model must skip, not fail, because an outage is not
   * evidence about the producer.
   */
  public async checkAvailability(): Promise<string | null> {
    try {
      const modelRuntime = await this.modelRuntimePromise;
      return resolveModel(modelRuntime, this.provider, this.modelId) === null
        ? `Pi belief model is unavailable: ${this.provider}/${this.modelId}`
        : null;
    } catch (error) {
      return describeErrorForAudit(error);
    }
  }

  public async infer(request: BeliefRequest, signal: AbortSignal): Promise<BeliefStateBatch> {
    const modelRuntime = await this.modelRuntimePromise;
    const model = resolveModel(modelRuntime, this.provider, this.modelId);
    if (model === null) {
      throw new Error(`Pi belief model is unavailable: ${this.provider}/${this.modelId}`);
    }

    // The same map the validator will check citations against, so the model is told
    // exactly what it may cite rather than being left to guess and then refused.
    const citableEvents = evidenceTimeline(request.worldState);
    const proposals = await this.propose(model, modelRuntime, request, citableEvents, signal);

    const batch = admitBeliefBatch({
      proposals,
      request,
      citableEvents,
      provider: this.name,
      modelVersion: `${this.provider}/${this.modelId}`,
      promptVersion: BELIEF_PROMPT_VERSION,
      ttlMs: this.ttlMs,
    });
    // "Nothing survived admission" and "the model asserted nothing" are the same answer
    // to a consumer, and both are normal. The resolver maps this to `none`, the
    // prediction proceeds from state, and the ranking stays the heuristic's — which is
    // how a model that cannot repeat itself costs coverage instead of stability.
    if (batch === null) throw new NoBeliefsError(request.id);
    return batch;
  }

  private async propose(
    model: ResolvedModel,
    modelRuntime: ModelRuntime,
    request: BeliefRequest,
    citableEvents: ReadonlyMap<string, string>,
    signal: AbortSignal,
  ): Promise<readonly ProposedBelief[]> {
    let proposals: readonly ProposedBelief[] = [];
    const emitBeliefs = defineTool({
      name: "emit_beliefs",
      label: "Emit beliefs",
      description: "Report what the user is currently doing, then stop.",
      parameters: Type.Object({
        beliefs: Type.Array(Type.Object({
          value: Type.Union(beliefValues.map((value) => Type.Literal(value))),
          confidence: Type.Number(),
          evidenceEventIds: Type.Array(Type.String()),
        })),
      }),
      execute: async (_toolCallId, params) => {
        // Kept raw. The schema bounds the shape, not the meaning, and every judgement
        // about what may be believed belongs to `admitBeliefBatch`.
        proposals = params.beliefs.map((belief) => ({
          value: belief.value,
          confidence: belief.confidence,
          evidenceEventIds: [...belief.evidenceEventIds],
        }));
        return {
          content: [{ type: "text", text: "Beliefs emitted." }],
          details: params,
          terminate: true,
        };
      },
    });

    const handle = await createPiSession({
      model,
      modelRuntime,
      cwd: process.cwd(),
      systemPrompt: beliefSystemPrompt(citableEvents),
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      tools: ["emit_beliefs"],
      customTools: [emitBeliefs],
      signal,
    });

    // A signal already aborted before the session existed is a cancellation the
    // caller's own error names. The factory wired disposal to a later abort.
    if (signal.aborted) {
      handle.dispose();
      throw new NoBeliefsError(request.id);
    }

    try {
      await handle.session.prompt(JSON.stringify({ worldState: request.worldState }));
      return proposals;
    } finally {
      handle.dispose();
    }
  }
}
