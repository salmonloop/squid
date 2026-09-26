import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where the decision model's API key lives, and how it is read.
 *
 * The decision curator (see `decision-curator-extension.ts`) calls a Jev-shaped
 * endpoint to prune the agent's context. That endpoint may be the paid hosted
 * Jev, a free self-hosted OpenJev/Kev, or nothing at all — and its credential
 * is a *separate* secret from the model that does the thinking. It is separate
 * on purpose: the two can point at different providers (a local Kev needs no
 * key while the chat model does), so folding the decision key into Pi's
 * `auth.json` under the chat provider would tie two logins that have no reason
 * to be one.
 *
 * Resolution order, highest wins:
 *   1. `SQUID_DECISION_KEY` in the (merged) env — the front-door override, and
 *      what a headless run or CI sets.
 *   2. the key persisted at `~/.pi/squid-decision.json` by a prior GUI save.
 *
 * The file is plaintext, mode 0600 — the same convention Pi uses for
 * `~/.pi/agent/auth.json` and `models.json`. It is never the Squid config file:
 * a credential must not sit in a file the settings form dumps back to the panel
 * verbatim. The value is written by `applyConfigSet` through
 * `writeDecisionKey`, read here, and — like Pi's own credentials — never read
 * back out for display; `hasDecisionKey` answers only yes or no.
 *
 * An empty key is not a key: a self-hosted endpoint that needs no auth still
 * gets a `Bearer` header, so `resolveDecisionKey` returns `""` unset as a
 * usable empty string only when the endpoint is keyless. In practice the
 * curator sends whatever this returns; a keyless replica ignores it.
 */

export function decisionKeyFile(home: string = homedir()): string {
  return join(home, ".pi", "squid-decision.json");
}

interface DecisionKeyStore {
  /** The (merged) environment; `SQUID_DECISION_KEY` wins when set non-empty. */
  readonly env: Record<string, string | undefined>;
  /** Override the persisted-file location; production uses the home default. */
  readonly file?: string;
}

/**
 * The decision key, or `undefined` when none is set anywhere. `undefined` is
 * the curator's signal to send an empty bearer (fine for keyless replicas) — it
 * is never an error here, because a missing key is a supported deployment, not
 * a misconfiguration.
 */
export function resolveDecisionKey(store: DecisionKeyStore): string | undefined {
  const fromEnv = store.env.SQUID_DECISION_KEY;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return loadPersistedDecisionKey(store.file);
}

function loadPersistedDecisionKey(file: string | undefined): string | undefined {
  const path = file ?? decisionKeyFile();
  try {
    if (!existsSync(path)) return undefined;
    const raw = JSON.parse(readFileSync(path, "utf8")) as { apiKey?: unknown };
    return typeof raw.apiKey === "string" && raw.apiKey.length > 0 ? raw.apiKey : undefined;
  } catch {
    // Unreadable or malformed reads as "no key", the same way Pi's own
    // credential read fails closed: the curator then runs keyless or fails
    // open, never crashes the session.
    return undefined;
  }
}

/**
 * Whether a decision key can be read — env or file — without exposing any of
 * it. Mirrors `hasReadableCredential` in `app-model.ts`: the settings form uses
 * it to tell an empty field that means "keep the stored key" from one that
 * means "none is set", and it never reveals the value.
 */
export function hasDecisionKey(store: DecisionKeyStore): boolean {
  return resolveDecisionKey(store) !== undefined;
}

/**
 * Persists a decision key to the 0600 file. Called only by the settings service
 * when the GUI submits the "Decision model API key" field; the value never
 * touches the Squid config file. An empty string clears it, mirroring how an
 * empty settings field means unset everywhere else.
 */
export function writeDecisionKey(key: string, file: string = decisionKeyFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const trimmed = key.trim();
  const body = trimmed.length === 0 ? {} : { apiKey: trimmed };
  writeFileSync(file, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort: a filesystem that cannot chmod (some Windows mounts) still
    // gets the file, and the key is no more exposed than Pi's own auth.json on
    // the same mount.
  }
}
