import { createHmac } from "node:crypto";

/**
 * The egress decision for selection-bearing actions. Search sends user text
 * off the machine, so it needs an explicit opt-in; every other value is a
 * configuration error rather than a silent default.
 */
export type EgressDecision = "deny" | "allow";

export interface EgressPolicy {
  readonly id: "search-egress-deny-v1" | "search-egress-allow-v1";
  readonly searchEgress: EgressDecision;
}

/** Audit ID for the deny posture. Also the runtime's conservative default. */
export const SEARCH_EGRESS_DENY_ID = "search-egress-deny-v1";
/** Audit ID for the explicit allow posture. */
export const SEARCH_EGRESS_ALLOW_ID = "search-egress-allow-v1";

/**
 * Resolves `SQUID_SEARCH_EGRESS` into exactly one of three outcomes:
 * unset = deny, exact "allow" = allow, anything else = startup error.
 * A typo like "Allow" or "allowed" must not widen egress by accident.
 */
export function resolveSearchEgress(
  value: string | undefined,
): EgressPolicy | { readonly configError: string } {
  if (value === undefined) {
    return { id: SEARCH_EGRESS_DENY_ID, searchEgress: "deny" };
  }
  if (value === "allow") {
    return { id: SEARCH_EGRESS_ALLOW_ID, searchEgress: "allow" };
  }
  return {
    configError: 'SQUID_SEARCH_EGRESS must be unset (deny) or exactly "allow".',
  };
}

/**
 * Stable length ceiling for sanitized audit text. Long enough for a useful
 * preview, short enough that a leaked rationale cannot carry a transcript.
 */
export const AUDIT_TEXT_MAX_LENGTH = 200;

/** What kind of text went in, which decides whether a preview may exist. */
export type AuditTextClass = "selection" | "summary" | "rationale" | "mcp_summary";

export interface SanitizedAuditText {
  /** Truncated, control-character-free, credential-redacted text. */
  readonly text: string;
  /** Original length before truncation, so audits can compare without raw text. */
  readonly originalLength: number;
  readonly truncated: boolean;
  /**
   * Selection and plan summaries are never previewed — their content is the
   * payload that would leave the machine. Rationale and MCP summaries may
   * show a redacted preview.
   */
  readonly previewAllowed: boolean;
}

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // Bearer and token-style authorization headers
  /bearer\s+[a-z0-9._~+/=-]{8,}/giu,
  /token[:=]\s*\S{8,}/giu,
  // URL userinfo (user:password@) — keep the host visible for debugging
  /\/\/[^\s/:@]+:[^\s/@]+@/gu,
  // Long hex/base64-ish secrets
  /\b[a-f0-9]{32,}\b/giu,
];

function redactCredentials(text: string): string {
  let result = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    result = result.replace(pattern, "[redacted]");
  }
  return result;
}

/**
 * Single choke point for any text heading to logs, feedback, or the ledger.
 * Deterministic: identical input always yields identical output, so audit
 * digests remain comparable across processes. Raw text never survives this
 * function into persistence — callers log the returned object only.
 */
export function sanitizeAuditText(text: string, kind: AuditTextClass): SanitizedAuditText {
  const stripped = text.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  const redacted = redactCredentials(stripped);
  const truncated = redacted.length > AUDIT_TEXT_MAX_LENGTH;
  return {
    text: truncated ? `${redacted.slice(0, AUDIT_TEXT_MAX_LENGTH)}…` : redacted,
    originalLength: text.length,
    truncated,
    previewAllowed: kind === "rationale" || kind === "mcp_summary",
  };
}

/**
 * Integrity digest over sanitized text. HMAC with a process key when one is
 * provided so digests cannot be brute-forced offline; plain sha256 otherwise.
 * This proves two records saw the same text — it is not a privacy barrier.
 */
export function auditTextDigest(text: string, key?: Uint8Array): string {
  const digest = createHmac("sha256", key ?? new Uint8Array(0)).update(text).digest("hex");
  return key === undefined ? digest : `hmac:${digest}`;
}
