import { HeuristicPredictor } from "./baseline-predictor.js";
import type { BeliefOutcome } from "./belief-provider.js";
import type { BeliefProvider } from "./belief-provider.js";
import type { BeliefProviderKind } from "./resolve-belief-provider.js";
import type { BeliefStateBatch } from "./belief-state.js";
import {
  PassthroughContextPolicy,
  RedactingContextPolicy,
  type ContextPolicy,
} from "./context-policy.js";
import { resolveBeliefProvider } from "./resolve-belief-provider.js";
import {
  parseProviderGateMode,
  parseProviderMode,
  selectPredictionProvider,
  type ProviderGateMode,
  type ProviderSelection,
} from "./provider-selector.js";
import { DEFAULT_PROVIDER_GATE_TIMEOUT_MS } from "./provider-gate.js";

/**
 * Wires the real Pi and replay-gate seams into `selectPredictionProvider` and
 * reads the two environment variables both watch entry points use.
 *
 * This file exists so `provider-selector.ts` stays a pure function of its
 * inputs: the selector is unit-tested with stubs and imports no model runtime,
 * while everything env-dependent and dependency-heavy lives here — the same
 * split as `provider-gate.ts` versus `gate-pi.ts`. Both entry points call this
 * rather than duplicating the wiring.
 *
 * The Pi module graph is imported lazily, inside the `pi` branch only. Loading
 * it costs roughly 650ms on this machine, which the default heuristic path has
 * no reason to pay — and a static import would make "the default touches no
 * model" true only of execution, not of startup.
 */
export type WatchProviderResolution =
  | {
    readonly ok: true;
    readonly selection: ProviderSelection;
    /**
     * Which belief producer the run is configured for, and how to build one —
     * threaded through because the shadow path needs a producer from the same
     * variable, and a second `resolveBeliefProvider` call there would read env
     * twice for one fact. The live cognition path builds its own instance
     * internally; this factory exists for callers that need another one.
     */
    readonly belief: {
      readonly kind: BeliefProviderKind;
      readonly createProvider: () => Promise<BeliefProvider>;
    };
  }
  /** A recognized variable held an unrecognized value. The caller reports and exits. */
  | { readonly ok: false; readonly configError: string };

/** What a resolved provider reports about its own belief layer, per request. */
export interface WatchProviderDiagnostic {
  readonly kind: "belief_outcome";
  readonly requestId: string;
  readonly provider: string;
  readonly status: BeliefOutcome["status"];
  readonly latencyMs: number;
  /** Absent on success. Already sanitized where it carries provider text. */
  readonly reasonCode?: string;
}

/** A belief batch that survived validation, with the request it answered. */
export interface WatchProviderBeliefBatch {
  readonly requestId: string;
  readonly provider: string;
  readonly batch: BeliefStateBatch;
}

export interface ResolveWatchProviderOptions {
  /**
   * Reports belief outcomes for a cognition run.
   *
   * Without it, a cognition provider silently predicting belief-free forever is
   * indistinguishable from one the belief layer is feeding — the two differ only
   * in the ranking, and a wrong ranking looks like a bad model rather than a
   * starved one. Optional so existing callers and tests are unchanged, but the
   * watch session supplies it.
   */
  readonly onDiagnostic?: (diagnostic: WatchProviderDiagnostic) => void;
  /**
   * Receives every batch that survived validation, for persistence as history.
   *
   * Deliberately a second seam rather than a field on the diagnostic above. The
   * two carry different things to different places under different rules: a
   * diagnostic is a sanitized line for an operator's terminal, and this is an
   * audit record for the ledger. Folding them would force one of the two — either
   * the log line starts carrying beliefs, or the ledger stops being able to. A
   * widened diagnostic would also be a trap: every consumer would receive the
   * batch and have to remember not to print it.
   */
  readonly onBeliefBatch?: (observed: WatchProviderBeliefBatch) => void;
}

export async function resolveWatchProvider(
  env: Record<string, string | undefined> = process.env,
  options: ResolveWatchProviderOptions = {},
): Promise<WatchProviderResolution> {
  const mode = parseProviderMode(env.SQUID_PROVIDER);
  if (mode === null) {
    return {
      ok: false,
      configError: 'SQUID_PROVIDER must be "heuristic", "pi", or "cognition".',
    };
  }

  const gate = parseProviderGateMode(env.SQUID_PROVIDER_GATE);
  if (gate === null) {
    return { ok: false, configError: 'SQUID_PROVIDER_GATE must be "probe", "replay", or "off".' };
  }

  // Resolved in every mode — even ones that never use it — so a typo in the
  // variable fails startup everywhere rather than only where a belief layer
  // happens to be observed. The resolution itself is cheap: the producer is
  // built on demand, and the default's module graph loads no model.
  const beliefResolution = resolveBeliefProvider({ env });
  if ("configError" in beliefResolution) {
    return { ok: false, configError: beliefResolution.configError };
  }
  const belief = { kind: beliefResolution.kind, createProvider: beliefResolution.createProvider };

  // The policy spelling is validated in every mode, not just the ones that
  // consume it: a typo must fail startup wherever it appears, or the
  // "unrecognized value is a startup error" contract holds only for some
  // providers — and a heuristic run would silently take passthrough while an
  // identical cognition run refused to start.
  const contextPolicy = resolveContextPolicy(env);
  if ("configError" in contextPolicy) {
    return { ok: false, configError: contextPolicy.configError };
  }

  if (mode === "heuristic") {
    return {
      ok: true,
      selection: await selectPredictionProvider({
        mode,
        heuristic: new HeuristicPredictor(),
      }),
      belief,
    };
  }

  if (mode === "cognition") {
    return resolveCognitionProvider(gate, env, options, belief);
  }

  const [{ PiRuntime }, { runProviderGate }, { heuristicEvaluationScenarios }] = await Promise.all([
    import("./pi-runtime.js"),
    import("./provider-gate.js"),
    import("./evaluation-fixtures.js"),
  ]);

  const selection = await selectPredictionProvider({
    mode,
    gate,
    heuristic: new HeuristicPredictor(),
    ...(contextPolicy.policy === undefined ? {} : { contextPolicy: contextPolicy.policy }),
    createPi: () => new PiRuntime(),
    // Resolve the model once up front, so an outage declines with a stated
    // reason instead of surfacing as a failed prediction on the first event.
    probePi: () => new PiRuntime().checkAvailability(),
    runGate: () => runProviderGate({
      scenarios: heuristicEvaluationScenarios,
      createProvider: () => new PiRuntime(),
      probeAvailability: () => new PiRuntime().checkAvailability(),
      // Matches `gate:pi`: well above the observed single-call latency, below
      // the point where a hung provider would stall startup indefinitely.
      timeoutMs: DEFAULT_PROVIDER_GATE_TIMEOUT_MS,
    }),
  });

  return { ok: true, selection, belief };
}

/**
 * Assembles the belief-backed cognition provider and the gate that admits it.
 *
 * One `ContextPolicy` instance is built here and used three times: the gate
 * projects state through it, the belief resolver names it, and the selection
 * returns it so the live coordinator applies it. All three have to be the same
 * policy or the gate is not scoring the run it authorizes — and the failure is
 * quiet in both directions.
 *
 * Get the *id* wrong and every belief batch fails `context_policy_mismatch`
 * during the replay, so the gate measures a cognition layer that never saw a
 * belief and passes it for being indistinguishable from the heuristic. Get the
 * *policy* wrong — the original defect here — and the gate feeds the belief
 * producer full window titles and paths while the live run feeds it redacted
 * ones, so a producer earns `trusted` on evidence it can never reproduce. The
 * belief contract cannot catch the second case: a cooperative producer echoes
 * back whatever id it was handed, so request and batch agree either way.
 */
/**
 * Resolves `SQUID_CONTEXT_POLICY` into the projection model-mode providers see.
 *
 * Absent means passthrough — the open-by-default posture, where what the model
 * receives is the same world state the local fallback reads. `redacting` is
 * the explicit opt-in that narrows window titles, URLs, file paths, focus
 * text, and action targets before anything leaves the process; anything else
 * is a startup error rather than a silent choice of posture. The policy is
 * resolved once here so the selector, the gate, and the belief layer all name
 * and apply the same one.
 */
function resolveContextPolicy(
  env: Record<string, string | undefined>,
): { readonly policy: ContextPolicy } | { readonly configError: string } {
  const raw = env.SQUID_CONTEXT_POLICY;
  if (raw === undefined || raw === "passthrough") {
    return { policy: new PassthroughContextPolicy() };
  }
  if (raw === "redacting") {
    return { policy: new RedactingContextPolicy() };
  }
  return {
    configError: 'SQUID_CONTEXT_POLICY must be unset (passthrough), "passthrough", or "redacting".',
  };
}

/**
 * The producer's own reachability check as a gate hook, or null when the
 * producer declares none. Narrowing once here keeps the optional method off
 * every call site that consumes it.
 */
function probeProducer(
  producer: BeliefProvider,
): (() => Promise<string | null>) | null {
  const check = producer.checkAvailability;
  return check === undefined ? null : () => check.call(producer);
}

async function resolveCognitionProvider(
  gate: ProviderGateMode,
  env: Record<string, string | undefined>,
  options: ResolveWatchProviderOptions,
  belief: {
    readonly kind: BeliefProviderKind;
    readonly createProvider: () => Promise<BeliefProvider>;
  },
): Promise<WatchProviderResolution> {
  // Which producer sits behind the seam is a config question, answered before any
  // model graph loads: a typo must fail startup rather than silently run the
  // deterministic rules while an operator believes a model is being scored. The
  // resolution itself arrives from the caller — one read of the variable per run.
  const contextPolicy = resolveContextPolicy(env);
  if ("configError" in contextPolicy) {
    return { ok: false, configError: contextPolicy.configError };
  }

  const [
    { BeliefRerankCognition },
    { createBeliefResolver },
    { BeliefBackedPredictionProvider },
    { runSemanticGate },
    { heuristicEvaluationScenarios },
  ] = await Promise.all([
    import("./belief-rerank-cognition.js"),
    import("./belief-resolver.js"),
    import("./cognition-provider.js"),
    import("./semantic-gate.js"),
    import("./evaluation-fixtures.js"),
  ]);

  /**
   * One observation point feeding two consumers, because there is only one fact:
   * a belief attempt settled. The terminal line describes it without the beliefs;
   * the ledger record is the beliefs. Deriving both here rather than letting the
   * session re-derive either keeps `BeliefOutcome` the single source of what
   * happened — a batch that reached the ledger without a matching diagnostic, or
   * the reverse, would be a report and an audit trail disagreeing about the same
   * request.
   *
   * Only the live provider observes. The gate replays the corpus four times, so
   * wiring it there would emit sixty lines of startup noise describing a replay
   * rather than the user's session, and would write ledger records for
   * predictions that never happened.
   */
  const observeOutcome = (outcome: BeliefOutcome): void => {
    options.onDiagnostic?.({
      kind: "belief_outcome",
      requestId: outcome.requestId,
      provider: outcome.provider,
      status: outcome.status,
      latencyMs: outcome.latencyMs,
      // Never the batch. `status` and `reasonCode` are a closed vocabulary plus
      // already-sanitized provider text; the beliefs themselves go to the ledger.
      ...(outcome.reasonCode === undefined ? {} : { reasonCode: outcome.reasonCode }),
    });
    // Only a batch that survived validation is history worth keeping. A rejected
    // or absent one is already fully described by the diagnostic's reason code,
    // and persisting it would put a batch the contract refused into the audit
    // trail as though it had been believed.
    if (outcome.batch !== null) {
      options.onBeliefBatch?.({
        requestId: outcome.requestId,
        provider: outcome.provider,
        batch: outcome.batch,
      });
    }
  };
  const observed = options.onDiagnostic !== undefined || options.onBeliefBatch !== undefined;

  // One producer instance, shared. A `BeliefProvider` holds no per-request state, and
  // the model-backed one opens a model runtime in its constructor — the gate builds a
  // provider per scenario per replay, so constructing a producer alongside each would
  // open that runtime 57 times to answer 57 questions.
  const producer = await belief.createProvider();
  const buildResolver = (observe: boolean) => createBeliefResolver({
    beliefProvider: producer,
    contextPolicyId: contextPolicy.policy.id,
    ...(observe && observed ? { onOutcome: observeOutcome } : {}),
  });

  const probe = probeProducer(producer);

  const createGateProvider = () => new BeliefBackedPredictionProvider(
    new BeliefRerankCognition(),
    buildResolver(false),
  );

  return {
    ok: true,
    belief,
    selection: await selectPredictionProvider({
      mode: "cognition",
      gate,
      heuristic: new HeuristicPredictor(),
      createCognition: () => new BeliefBackedPredictionProvider(
        new BeliefRerankCognition(),
        buildResolver(true),
      ),
      contextPolicy: contextPolicy.policy,
      runSemanticGate: () => runSemanticGate({
        scenarios: heuristicEvaluationScenarios,
        createProvider: createGateProvider,
        contextPolicy: contextPolicy.policy,
        // Present only for a model-backed producer. The heuristic is in-process and
        // cannot be unavailable, and a probe that always succeeds would only add a way
        // for the gate to skip — which reads as "not evaluated", the one verdict that
        // must not admit. A model that is merely unreachable must skip rather than fail,
        // since an outage is not evidence about the producer.
        // Probed on the already-created producer rather than a throwaway: a
        // model-backed provider opens its model runtime in its constructor, so
        // constructing one just to check availability would start — and never
        // dispose — a second runtime beside the live one.
        ...(probe === null ? {} : { probeAvailability: probe }),
        // A model call runs 7–15s against the configured endpoint, and the gate makes
        // one per cut point. The default coordinator timeout would score a reachable
        // producer as a failure for being slow.
        ...(belief.kind === "heuristic" ? {} : { timeoutMs: BELIEF_GATE_TIMEOUT_MS }),
      }),
    }),
  };
}

/**
 * Ceiling for one belief-backed prediction inside the gate.
 *
 * Well above the observed 7–15s time-to-first-byte of the configured endpoint, below
 * the point where a hung producer stalls startup indefinitely. Matches the reasoning
 * behind `DEFAULT_PROVIDER_GATE_TIMEOUT_MS`; kept separate because this path pays for
 * two model calls in sequence when a cognition layer is also model-backed.
 */
const BELIEF_GATE_TIMEOUT_MS = 90_000;
