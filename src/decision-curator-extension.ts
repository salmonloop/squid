import type {
  ContextEvent,
  InlineExtension,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_BASE_URL,
  DEFAULT_FREQUENCY,
  DEFAULT_MIN_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_THRESHOLD,
  JEV_TIMEOUT_MS,
  MAX_STATE_TOKENS,
  MAX_UNIT_CHARS,
  type CuratorConfig,
} from "./jev-curator/config.js";
import {
  describeMessage,
  estimateTokens,
  fingerprintUnit,
  groupIntoUnits,
  type Unit,
} from "./jev-curator/units.js";
import { JudgmentCheckpoint } from "./jev-curator/checkpoint.js";
import { resolveDecisionKey } from "./decision-keystore.js";

/**
 * The decision curator: a headless inline extension that trims the resident
 * agent's context before each LLM call, asking a fast Jev-shaped decision model
 * which pieces any future thought will actually need.
 *
 * This is the "is this worth the agent's attention" gate the design settled on,
 * living exactly where the design put it — on the agent's own context, never on
 * capture. Capture stays whole and irreversible; this only narrows what the
 * *model* sees, so a wrong "drop" costs the agent a fact it can re-derive, never
 * a lost observation. That is the same posture Squid's egress side already has:
 * the store keeps everything, the view onto it is what gets bounded.
 *
 * The decision call goes through Pi's own classifier transport
 * (`ctx.modelRegistry.classify` on the `typesafe-system-one` API) — the same
 * `/v1/systemone` endpoint the vendored HTTP client used, with Pi owning the
 * wire, the bearer, and the timeout. Three things stay Squid's:
 *   - **No TUI.** The resident agent is headless; diagnostics go to the
 *     injected `log` callback, on the same channel every other Squid sensor's
 *     do.
 *   - **Injected config.** The `CuratorConfig` is resolved from Squid's *merged*
 *     env (config file under process env) by `resolveCuratorConfig`, not read
 *     from `process.env` here. That keeps the one contract this repo enforces —
 *     resolvers read the merged env — unbroken.
 *   - **Injected key.** The decision key comes from `decision-keystore.ts` (env
 *     or the 0600 file) and is passed per-request, never Pi's `auth.json`: the
 *     decision model and the chat model are separate logins.
 *
 * Fail-open is total: no key on a keyless endpoint is fine, any classifier
 * error keeps everything, and a throw is caught by Pi's context runner and
 * logged. The agent never loses a turn to this.
 */

/** Off unless the enum says otherwise; unset ("") is on, per the schema. */
export function decisionCuratorEnabled(env: Record<string, string | undefined>): boolean {
  return env.SQUID_DECISION_CURATOR !== "off";
}

/**
 * Builds the `CuratorConfig` from the merged env. Every value has a schema
 * default, so a run that set nothing gets the hosted-Jev defaults and a run
 * that set only the endpoint keeps the rest.
 */
export function resolveCuratorConfig(env: Record<string, string | undefined>): CuratorConfig {
  const threshold = Number.parseFloat(env.SQUID_DECISION_THRESHOLD ?? "");
  return {
    baseUrl: (env.SQUID_DECISION_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: env.SQUID_DECISION_MODEL || DEFAULT_MODEL,
    threshold: Number.isFinite(threshold)
      ? Math.min(1, Math.max(0, threshold))
      : DEFAULT_THRESHOLD,
    minTokens: DEFAULT_MIN_TOKENS,
    frequency: DEFAULT_FREQUENCY,
  };
}

/**
 * Pi-ai's `ClassifierModel` is not re-exported through pi-coding-agent, so the
 * entry is built structurally: the same fields as Pi's `typesafe` catalog entry
 * for `jev-latest`, pointed at the configured endpoint. `baseUrl` gets `/v1`
 * because the transport appends `systemone` to it, so the wire URL stays
 * `{baseUrl}/v1/systemone` — the endpoint OpenJev and Kev replicas serve.
 */
interface JevClassifierModel {
  readonly type: "classifier";
  readonly id: string;
  readonly name: string;
  readonly api: "typesafe-system-one";
  readonly provider: "typesafe";
  readonly baseUrl: string;
  readonly input: ("text" | "image")[];
  readonly cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  readonly contextWindow: number;
}

/** One boolean question per context unit, framed for permanent removal. */
interface BoolQuestion {
  readonly type: "bool";
  readonly instructions: string;
  readonly criteria: { true: string; false: string };
}

interface ClassifierDecision {
  /** Local indexes (into the `newUnits` array) that were actually judged. */
  judged: number[];
  /** Subset of `judged` to keep. */
  keep: Set<number>;
}

function truncate(s: string, maxChars: number): string {
  return s.length > maxChars ? s.slice(0, maxChars) + "\n…[truncated]" : s;
}

/**
 * Ask the decision model which new units any future response might need, via
 * `classify`. Returns the decision, or `null` on any failure — the caller must
 * fail open (keep everything, record nothing) so the new units are retried on
 * the next event.
 *
 * `classify` never rejects: transport, auth, and response errors come back as
 * `stopReason: "error"`. `maxRetries: 0` and the timeout keep a slow or
 * overloaded endpoint from stalling the LLM request this sits ahead of.
 *
 * Units that do not fit the state budget are left out of `judged` so the
 * caller leaves them unjudged for the next event instead of permanently
 * keeping them without a decision.
 */
async function classifyNewUnits(
  newUnits: Unit[],
  model: JevClassifierModel,
  cfg: CuratorConfig,
  apiKey: string,
  registry: ModelRegistry,
  signal: AbortSignal | undefined,
): Promise<ClassifierDecision | null> {
  if (newUnits.length === 0) return { judged: [], keep: new Set() };

  const lines = newUnits.map((u, i) => `[${i}] (${u.label})\n${truncate(u.text, MAX_UNIT_CHARS)}`);

  // Newest units first within the state budget; the rest stay unjudged
  // for the next event. The newest unit is always included so we make
  // progress even if a single unit exceeds the budget on its own.
  const maxChars = MAX_STATE_TOKENS * 4;
  const selected: number[] = [];
  let used = 0;
  for (let i = newUnits.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    if (selected.length > 0 && used + line.length > maxChars) break;
    used += line.length;
    selected.unshift(i);
  }

  const questions: Record<string, BoolQuestion> = {};
  for (const i of selected) {
    const unit = newUnits[i];
    if (unit === undefined) continue;
    questions[`u${i}`] = {
      type: "bool",
      instructions:
        `Consider ONLY context unit [${i}] (${unit.label}) in the transcript above. ` +
        `Is this context unit likely ESSENTIAL to completing a future response in this conversation? ` +
        `Keep it only if a later response is likely to directly depend on its unique instructions, facts, ` +
        `file contents, code, or tool results. Do NOT keep it merely because it provides background, ` +
        `might be useful, or could possibly become relevant. Prefer discarding transient reasoning, ` +
        `intermediate tool output, already-summarized information, and redundant context. ` +
        `When uncertain, answer no.`,
      criteria: {
        true: "This unit is likely essential to a future response — keep it",
        false: "This unit is not essential or is uncertain — permanently discard it",
      },
    };
  }

  const result = await registry.classify(
    model,
    {
      // Pi's classifier state is a JSON object; the transcript rides in one
      // field. The wire body is `{"transcript": "…"}` where the vendored
      // client sent the transcript as a bare string.
      state: { transcript: selected.map((i) => lines[i]).join("\n\n") },
      questions,
    },
    // The options object is exactOptionalPropertyTypes-clean: `signal` is
    // spread only when the session actually has one.
    { apiKey, timeoutMs: JEV_TIMEOUT_MS, maxRetries: 0, ...(signal ? { signal } : {}) },
  );
  if (result.stopReason !== "stop") return null;

  const keep = new Set<number>();
  for (const i of selected) {
    const ans = result.answers[`u${i}`];
    // Keep on yes (>= threshold), and on any missing or malformed answer:
    // never discard on an undecided question.
    if (ans?.type !== "bool" || ans.probability >= cfg.threshold) keep.add(i);
  }
  return { judged: selected, keep };
}

export interface DecisionCuratorOptions {
  /** The merged env (config file under process env), for config + key. */
  readonly env: Record<string, string | undefined>;
  /** One JSON line per curation pass; wired to the session's stderr logger. */
  readonly log?: (line: string) => void;
}

/**
 * The inline extension. Returns `undefined` when disabled, so the caller can
 * spread it into `extensionFactories` conditionally without a placeholder.
 */
export function decisionCuratorExtension(
  options: DecisionCuratorOptions,
): InlineExtension | undefined {
  if (!decisionCuratorEnabled(options.env)) return undefined;

  const cfg = resolveCuratorConfig(options.env);
  const model: JevClassifierModel = {
    type: "classifier",
    id: cfg.model,
    name: "Jev",
    api: "typesafe-system-one",
    provider: "typesafe",
    baseUrl: `${cfg.baseUrl}/v1`,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 64000,
  };
  const log = options.log ?? (() => {});
  const checkpoint = new JudgmentCheckpoint();
  let contextCalls = 0;

  return {
    name: "squid-decision-curator",
    hidden: true,
    factory: (pi) => {
      // Judgments are per-session so a resumed session never reuses a stale
      // verdict about a unit whose meaning has since changed.
      pi.on("session_start", () => {
        checkpoint.clear();
        contextCalls = 0;
      });

      pi.on("context", async (event: ContextEvent, ctx) => {
        contextCalls++;

        const messages = event.messages;
        if (messages.length <= 2) return;

        const usage = ctx.getContextUsage();
        const estTokens =
          usage?.tokens ??
          messages.reduce((n, m) => n + estimateTokens(describeMessage(m).text), 0);
        if (estTokens < cfg.minTokens) return;

        const units = groupIntoUnits(messages);
        if (units.length <= 1) return;

        // The latest unit is the current request: never judge or drop it now.
        // It becomes eligible once newer messages arrive.
        const latest = units[units.length - 1];
        if (latest !== undefined) latest.alwaysKeep = true;

        // Classify against the checkpoint: reuse past judgments, collect only
        // the new units after the checkpoint for the decision model.
        const keepUnit = new Array<boolean>(units.length).fill(true);
        const newUnits: { unit: Unit; index: number }[] = [];
        for (let i = 0; i < units.length; i++) {
          const u = units[i];
          if (u === undefined || u.alwaysKeep) continue;
          const prior = checkpoint.get(fingerprintUnit(u));
          if (prior === undefined) newUnits.push({ unit: u, index: i }); else keepUnit[i] = prior;
        }

        const queryDue = contextCalls % cfg.frequency === 0;
        if (newUnits.length > 0 && queryDue) {
          // Keyless endpoints (a local Kev with auth off) are supported: the
          // transport refuses to post without a key, so a placeholder bearer
          // is sent, which such a replica ignores. Only a paid endpoint that
          // requires a real key will 401 — and that path fails open like
          // every other error.
          const decision = await classifyNewUnits(
            newUnits.map((n) => n.unit),
            model,
            cfg,
            resolveDecisionKey({ env: options.env }) ?? "keyless",
            ctx.modelRegistry,
            ctx.signal,
          );
          // Fail open: keep everything this turn, record nothing so the new
          // units are retried on the next event.
          if (!decision) {
            log(JSON.stringify({ decisionCurator: "fail_open", newUnits: newUnits.length }));
            return;
          }
          for (const local of decision.judged) {
            const entry = newUnits[local];
            if (entry === undefined) continue;
            const keep = decision.keep.has(local);
            checkpoint.record(fingerprintUnit(entry.unit), keep);
            keepUnit[entry.index] = keep;
          }
        } else if (newUnits.length > 0) {
          // New units exist but this is not a query turn: keep them all,
          // unrecorded, so a later query turn judges them.
          return;
        }

        // Apply removals: drop every message belonging to a discarded unit.
        const keptIdx = new Set<number>();
        let removedMessages = 0;
        units.forEach((u, ui) => {
          if (keepUnit[ui]) u.messageIndexes.forEach((mi) => keptIdx.add(mi));
          else removedMessages += u.messageIndexes.length;
        });

        if (removedMessages === 0) return;

        const keptMessages = messages.filter((_, mi) => keptIdx.has(mi));
        log(
          JSON.stringify({
            decisionCurator: "trimmed",
            from: messages.length,
            kept: keptMessages.length,
            removed: removedMessages,
          }),
        );
        return { messages: keptMessages };
      });
    },
  };
}
