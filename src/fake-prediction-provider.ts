import type { PredictionCandidate, PredictionKind } from "./protocol.js";
import type { PredictionProvider, PredictionRequest } from "./prediction-provider.js";

export interface FakePredictionProviderOptions {
  /** Candidates to return on success. */
  readonly candidates: readonly PredictionCandidate[];
  /** Delay before resolving. Default 0. */
  readonly delayMs?: number;
  /** If set, reject with this error instead of resolving. */
  readonly error?: Error;
  /** If true, reject when the signal aborts. Default true. */
  readonly respectSignal?: boolean;
  /** Provider name reported in outcomes. Default "fake". */
  readonly name?: string;
}

/**
 * A controllable provider for tests and offline evaluation. It can simulate
 * latency, failure, and signal-respecting cancellation.
 */
export class FakePredictionProvider implements PredictionProvider {
  public readonly name: string;
  private readonly candidates: readonly PredictionCandidate[];
  private readonly delayMs: number;
  private readonly error: Error | undefined;
  private readonly respectSignal: boolean;

  public constructor(options: FakePredictionProviderOptions) {
    this.name = options.name ?? "fake";
    this.candidates = options.candidates;
    this.delayMs = options.delayMs ?? 0;
    this.error = options.error;
    this.respectSignal = options.respectSignal ?? true;
  }

  public predict(
    request: PredictionRequest,
    signal: AbortSignal,
  ): Promise<readonly PredictionCandidate[]> {
    return new Promise((resolve, reject) => {
      if (this.respectSignal && signal.aborted) {
        reject(new PredictionCancelledError(request.id));
        return;
      }

      const onAbort = () => {
        clearTimeout(timer);
        if (this.respectSignal) {
          reject(new PredictionCancelledError(request.id));
        } else {
          resolve(this.candidates);
        }
      };

      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        if (this.error) {
          reject(this.error);
        } else {
          resolve(this.candidates);
        }
      }, this.delayMs);

      if (this.respectSignal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

export class PredictionCancelledError extends Error {
  public constructor(public readonly requestId: string) {
    super(`Prediction request ${requestId} was cancelled.`);
    this.name = "PredictionCancelledError";
  }
}

/**
 * Build a candidate with the given kind and confidence. Helpful for terser test
 * fixtures.
 */
export function candidate(
  kind: PredictionKind,
  confidence = 0.5,
  parameters: PredictionCandidate["parameters"] = {},
): PredictionCandidate {
  return {
    kind,
    rationale: `fake ${kind}`,
    confidence,
    expiresAt: new Date(Date.now() + 20_000).toISOString(),
    sourceEventIds: [],
    parameters,
  };
}
