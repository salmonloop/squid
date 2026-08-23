import { describeErrorForAudit } from "./action-egress.js";
import type { BeliefProvider, BeliefOutcome, BeliefRequest } from "./belief-provider.js";
import { NoBeliefsError, validateBatchAgainstRequest } from "./belief-provider.js";
import { BELIEF_LIMITS } from "./belief-state.js";
import type { CognitionProvider } from "./cognition-provider.js";
import type { PredictionOutcome } from "./prediction-provider.js";
import type { PredictionCandidate, WorldState } from "./protocol.js";

/**
 * Runs a cognition path beside the live one, records what it would have done, and
 * dispatches nothing.
 *
 * This is the only honest way to earn trust in a new predictor. A gate scores a
 * fixed corpus; shadow mode scores the user's actual days, which is where the
 * corpus is wrong. And it does so without the new path being able to cause
 * anything: `ShadowCognitionRunner` has no dispatcher, no gateway, and no ledger
 * write that a claim could ever validate against.
 *
 * Deliberately not wired into `PredictionRuntime`. The runtime owns the live
 * path, and a shadow failure must not be able to delay or fail a real prediction
 * — so the caller observes outcomes and feeds them here, rather than the runtime
 * awaiting a second provider inline.
 */

export interface ShadowObservation {
  readonly requestId: string;
  /** What the live path actually produced. */
  readonly liveCandidates: readonly PredictionCandidate[];
  /** What the shadow path would have produced. Empty when it failed. */
  readonly shadowCandidates: readonly PredictionCandidate[];
  readonly beliefStatus: BeliefOutcome["status"];
  /** Belief values the batch asserted, for aggregation. Never free text. */
  readonly beliefValues: readonly string[];
  readonly shadowStatus: "succeeded" | "failed";
  readonly latencyMs: number;
  /** Stable identifier. Never carries model text. */
  readonly reasonCode?: string;
  /** True when live and shadow agree on the top-1 kind. */
  readonly top1Agrees: boolean;
}

export interface ShadowCognitionRunnerOptions {
  readonly beliefProvider: BeliefProvider;
  readonly cognition: CognitionProvider;
  /** Called for every observation. The only output this class has. */
  readonly onObservation: (observation: ShadowObservation) => void;
  /** Hard cap per shadow attempt. Default 15s, matching the live coordinator. */
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly random?: () => string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class ShadowCognitionRunner {
  private readonly beliefProvider: BeliefProvider;
  private readonly cognition: CognitionProvider;
  private readonly onObservation: (observation: ShadowObservation) => void;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly random: () => string;

  private inFlight = new Set<Promise<void>>();
  private disposed = false;

  public constructor(options: ShadowCognitionRunnerOptions) {
    this.beliefProvider = options.beliefProvider;
    this.cognition = options.cognition;
    this.onObservation = options.onObservation;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? (() => crypto.randomUUID());
  }

  /**
   * Observes one live outcome and runs the shadow path for the same state.
   *
   * Returns immediately. A shadow run must never be on the path of a live
   * prediction, so the caller does not await it; `awaitIdle` exists for tests and
   * shutdown.
   */
  public observe(input: {
    readonly outcome: PredictionOutcome;
    readonly worldState: WorldState;
    readonly stateDigest: string;
    readonly projectionGeneration: number;
    readonly contextPolicyId: string;
    readonly eventOccurredAt: ReadonlyMap<string, string>;
  }): void {
    if (this.disposed) return;
    const episodeId = input.worldState.episode?.id;
    if (episodeId === undefined) {
      // A belief is scoped to an episode by contract; without one there is
      // nothing valid to produce.
      return;
    }
    const run = this.run({ ...input, episodeId });
    this.inFlight.add(run);
    void run.then(
      () => this.inFlight.delete(run),
      () => this.inFlight.delete(run),
    );
  }

  /** Resolves once every in-flight shadow run has settled. */
  public async awaitIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    await this.awaitIdle();
  }

  private async run(input: {
    readonly outcome: PredictionOutcome;
    readonly worldState: WorldState;
    readonly stateDigest: string;
    readonly projectionGeneration: number;
    readonly contextPolicyId: string;
    readonly episodeId: string;
    readonly eventOccurredAt: ReadonlyMap<string, string>;
  }): Promise<void> {
    const startedAt = this.now().getTime();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const request: BeliefRequest = {
      id: this.random(),
      worldState: input.worldState,
      episodeId: input.episodeId,
      stateDigest: input.stateDigest,
      projectionGeneration: input.projectionGeneration,
      contextPolicyId: input.contextPolicyId,
      triggeredAt: input.worldState.updatedAt ?? new Date(startedAt).toISOString(),
    };

    let beliefStatus: BeliefOutcome["status"] = "failed";
    let beliefValues: string[] = [];
    let batch = null as Awaited<ReturnType<BeliefProvider["infer"]>> | null;
    let reasonCode: string | undefined;
    try {
      const produced = await this.beliefProvider.infer(request, controller.signal);
      const validated = validateBatchAgainstRequest(produced, request, {
        now: this.now().toISOString(),
        currentEpisodeId: input.episodeId,
        currentStateDigest: input.stateDigest,
        currentProjectionGeneration: input.projectionGeneration,
        eventOccurredAt: input.eventOccurredAt,
        maxTtlMs: BELIEF_LIMITS.maxTtlMs,
      });
      if (validated.ok) {
        beliefStatus = "succeeded";
        batch = validated.batch;
        beliefValues = validated.batch.beliefs.map((belief) => belief.value);
      } else {
        // The provider answered but its batch did not survive validation — a
        // different problem from an unreachable provider, and one a gate has to
        // be able to tell apart.
        beliefStatus = "rejected";
        reasonCode = validated.reasonCode;
      }
    } catch (error) {
      // "Nothing to assert" is a normal answer, not a failure. Folding it into
      // `failed` would make a quiet desktop indistinguishable from a broken
      // belief layer, and the gate's health measure would read every idle moment
      // as an outage.
      beliefStatus = error instanceof NoBeliefsError
        ? "none"
        : controller.signal.aborted ? "timeout" : "failed";
      if (!(error instanceof NoBeliefsError)) reasonCode = describeErrorForAudit(error);
    }

    let shadowCandidates: readonly PredictionCandidate[] = [];
    let shadowStatus: ShadowObservation["shadowStatus"] = "failed";
    try {
      shadowCandidates = await this.cognition.predict(
        { id: request.id, worldState: input.worldState, episodeId: input.episodeId, triggeredAt: request.triggeredAt, beliefs: batch },
        controller.signal,
      );
      shadowStatus = "succeeded";
    } catch (error) {
      reasonCode = describeErrorForAudit(error);
    } finally {
      clearTimeout(timer);
    }

    const liveTop = input.outcome.candidates[0]?.kind ?? null;
    const shadowTop = shadowCandidates[0]?.kind ?? null;
    this.onObservation({
      requestId: input.outcome.requestId,
      liveCandidates: input.outcome.candidates,
      shadowCandidates,
      beliefStatus,
      beliefValues,
      shadowStatus,
      latencyMs: this.now().getTime() - startedAt,
      ...(reasonCode === undefined ? {} : { reasonCode }),
      top1Agrees: liveTop === shadowTop,
    });
  }
}

/**
 * Aggregates shadow observations into something an operator can read.
 *
 * Counts only: a report that quoted candidate parameters would put the selection
 * and paths a shadow run saw into an operator's terminal, which is exactly what
 * the audit rules forbid elsewhere.
 */
export interface ShadowReport {
  readonly observations: number;
  readonly shadowSucceeded: number;
  readonly beliefByStatus: Readonly<Record<string, number>>;
  readonly beliefByValue: Readonly<Record<string, number>>;
  readonly top1Agreement: number;
  readonly shadowTop1ByKind: Readonly<Record<string, number>>;
  readonly latencyMs: { readonly p50: number | null; readonly max: number | null };
}

export function buildShadowReport(
  observations: readonly ShadowObservation[],
): ShadowReport {
  const tally = (values: readonly string[]): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  };

  const latencies = observations.map((o) => o.latencyMs).sort((a, b) => a - b);
  const p50 = latencies.length === 0
    ? null
    : latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.5) - 1)] ?? null;

  return {
    observations: observations.length,
    shadowSucceeded: observations.filter((o) => o.shadowStatus === "succeeded").length,
    beliefByStatus: tally(observations.map((o) => o.beliefStatus)),
    beliefByValue: tally(observations.flatMap((o) => o.beliefValues)),
    top1Agreement: observations.length === 0
      ? 0
      : observations.filter((o) => o.top1Agrees).length / observations.length,
    shadowTop1ByKind: tally(
      observations.map((o) => o.shadowCandidates[0]?.kind ?? "<none>"),
    ),
    latencyMs: { p50, max: latencies.at(-1) ?? null },
  };
}
