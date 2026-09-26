import type { ContextEvent, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_BASE_URL,
  DEFAULT_FREQUENCY,
  DEFAULT_MIN_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_THRESHOLD,
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
import { askJev } from "./jev-curator/jev.js";
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
 * Wrapped rather than depended on: see `jev-curator/README.md`. The wrapper
 * differs from the TUI original in three ways that matter here:
 *   - **No TUI.** No `pi-tui` import, no `ctx.ui` calls — the resident agent is
 *     headless and a dialog would have nothing to draw into. Diagnostics go to
 *     the injected `log` callback, on the same channel every other Squid
 *     sensor's do.
 *   - **Injected config.** The `CuratorConfig` is resolved from Squid's *merged*
 *     env (config file under process env) by `resolveCuratorConfig`, not read
 *     from `process.env` here. That keeps the one contract this repo enforces —
 *     resolvers read the merged env — unbroken.
 *   - **Injected key.** The decision key comes from `decision-keystore.ts` (env
 *     or the 0600 file), never Pi's `auth.json`: the decision model and the
 *     chat model are separate logins.
 *
 * Fail-open is total: no key on a keyless endpoint is fine, any Jev error keeps
 * everything, and a throw is caught by Pi's context runner and logged. The
 * agent never loses a turn to this.
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
        // Keyless endpoints (a local Kev with auth off) are supported: the
        // curator sends an empty bearer, which such a replica ignores. Only a
        // paid endpoint that requires a key will 401 — and that path fails open
        // like every other error below.
        const apiKey = resolveDecisionKey({ env: options.env }) ?? "";

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
        // the new units after the checkpoint for Jev.
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
          const decision = await askJev(
            newUnits.map((n) => n.unit),
            apiKey,
            cfg,
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
