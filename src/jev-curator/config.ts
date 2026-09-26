/**
 * Vendored from pi-jev-context-curator v1.1.0 (MIT, © 2026 Shashank H).
 * See src/jev-curator/README.md for why this lives in-tree rather than as a
 * dependency: Squid's config reaches an extension through its own merged env,
 * so this fork reads an injected `CuratorConfig` instead of `process.env`.
 *
 * Only the constants and the config *shape* are kept here; the upstream
 * `loadConfig()` (which read `process.env` directly) is deliberately gone.
 */

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_MODEL = "jev-latest";
export const DEFAULT_THRESHOLD = 0.5;
export const DEFAULT_MIN_TOKENS = 8000;
export const DEFAULT_FREQUENCY = 5;

/** Keep Jev's `state` comfortably under its 32k token cap. */
export const MAX_STATE_TOKENS = 28000;
/** Evidence per unit sent to Jev (chars, ~4 chars/token). */
export const MAX_UNIT_CHARS = 1500;
export const JEV_TIMEOUT_MS = 15000;

export interface CuratorConfig {
 baseUrl: string;
 model: string;
 /** Keep a unit when Jev's "needed" probability >= threshold. */
 threshold: number;
 /** Only curate when estimated context tokens exceed this. */
 minTokens: number;
 /** Run a new Jev query on every Nth context/model call. */
 frequency: number;
}
