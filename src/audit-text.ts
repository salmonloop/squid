import { createHmac } from "node:crypto";

/**
 * The choke point for text that is about to be logged.
 *
 * This module carried a second half: an `EgressPolicy` resolved from
 * `SQUID_SEARCH_EGRESS`, deciding whether a selection-bearing action was allowed
 * to leave the machine. That decision belonged to an action layer Squid no longer
 * has — Pi's sandbox governs what its tools may reach — so the policy is gone and
 * what remains is the sanitizer.
 *
 * It is still load-bearing, for a reason unrelated to egress: nearly every source
 * funnels its failures through `describeErrorForAudit`, and an error message
 * routinely quotes the thing that failed — a path, a window title, a tool's own
 * stderr. Without this, a diagnostic line is an unaudited channel for whatever the
 * sensors just read.
 */

/**
 * Stable length ceiling for sanitized audit text. Long enough for a useful
 * preview, short enough that a leaked rationale cannot carry a transcript.
 */
export const AUDIT_TEXT_MAX_LENGTH = 200;

/**
 * Length ceiling for the LLM-request *content preview* — deliberately larger
 * than `AUDIT_TEXT_MAX_LENGTH`, because this one field exists to show a person a
 * usable excerpt of what a request actually sent.
 *
 * It is a real, bounded widening of the panel's "metadata only" rule, and it
 * lives here on purpose: the taxonomy below forbids previewing `selection`/
 * `summary` because their content *is* the payload, and request content is
 * exactly that kind of text. `sanitizeLlmPreview` is the one sanctioned path
 * that previews it — still control-stripped, credential-redacted, and capped —
 * so the exception is auditable in the module that governs what text leaves.
 */
export const LLM_PREVIEW_MAX_LENGTH = 2000;

/** What kind of text went in, which decides whether a preview may exist. */
export type AuditTextClass =
  | "selection"
  | "summary"
  | "rationale"
  | "mcp_summary"
  | "diagnostic";

/** Classes whose content is itself the payload, so no preview may ever exist. */
export type UnpreviewableTextClass = "selection" | "summary";
export type PreviewableTextClass = "rationale" | "mcp_summary" | "diagnostic";

interface AuditTextMeasurements {
  /** Original length before truncation, so audits can compare without raw text. */
  readonly originalLength: number;
  readonly truncated: boolean;
}

/**
 * A selection or plan summary that has been measured but never previewed.
 *
 * `text` is absent by type, not by convention: for these classes the content is
 * the payload that would leave the machine, so there is no legitimate reader.
 * A caller reaching for a preview fails to compile instead of quietly logging
 * the selection it was supposed to withhold.
 */
export interface MeasuredAuditText extends AuditTextMeasurements {
  readonly previewAllowed: false;
}

/** Rationale or tool output, which may carry a redacted preview. */
export interface SanitizedAuditText extends AuditTextMeasurements {
  /** Truncated, control-character-free, credential-redacted text. */
  readonly text: string;
  readonly previewAllowed: true;
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
export function sanitizeAuditText(text: string, kind: PreviewableTextClass): SanitizedAuditText;
export function sanitizeAuditText(text: string, kind: UnpreviewableTextClass): MeasuredAuditText;
export function sanitizeAuditText(
  text: string,
  kind: AuditTextClass,
): SanitizedAuditText | MeasuredAuditText {
  const stripped = text.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  const redacted = redactCredentials(stripped);
  const truncated = redacted.length > AUDIT_TEXT_MAX_LENGTH;
  const measurements = { originalLength: text.length, truncated } as const;
  // The unpreviewable branch still computes the sanitized string, then drops it:
  // both branches must agree on `truncated`, and deciding that needs the redacted
  // length. The string itself never leaves this function.
  if (kind === "selection" || kind === "summary") {
    return { ...measurements, previewAllowed: false };
  }
  return {
    ...measurements,
    text: truncated ? `${redacted.slice(0, AUDIT_TEXT_MAX_LENGTH)}…` : redacted,
    previewAllowed: true,
  };
}

/**
 * Scrubs and bounds an LLM-request content preview for the debug viewer.
 *
 * Same control-character strip, whitespace collapse, and credential redaction as
 * `sanitizeAuditText`, but capped at `LLM_PREVIEW_MAX_LENGTH` rather than the
 * 200-char audit ceiling — this field is the excerpt, not a one-line label. The
 * result is a single line (newlines collapse to spaces) with a trailing `…` when
 * truncated. See `LLM_PREVIEW_MAX_LENGTH` for why this preview is allowed at all.
 */
export function sanitizeLlmPreview(text: string): string {
  const stripped = text.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  const redacted = redactCredentials(stripped);
  return redacted.length > LLM_PREVIEW_MAX_LENGTH
    ? `${redacted.slice(0, LLM_PREVIEW_MAX_LENGTH)}…`
    : redacted;
}

/**
 * The only sanctioned way to turn a caught error into text a diagnostic, a log
 * line, or a ledger detail may carry.
 *
 * An error message is not trusted prose. It routinely quotes the thing that
 * failed — a file path, a SQL fragment, a tool's own stderr — and a screen or
 * MCP failure can quote the selection outright. Every such string therefore
 * goes through the same sanitizer as model text: control characters stripped,
 * credentials redacted, length capped.
 *
 * Stacks are dropped deliberately. A stack names the machine's directory layout
 * and pins the exact build, which is more than an audit trail needs and more
 * than a log should hand to whoever reads it.
 */
export function describeErrorForAudit(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeAuditText(raw, "diagnostic").text;
}

/**
 * Integrity digest over sanitized text. HMAC with a process key when one is
 * provided so digests cannot be brute-forced offline; plain sha256 otherwise.
 * This proves two records saw the same text — it is not a privacy barrier.
 */
export function auditTextDigest(text: string, key?: Uint8Array): string {
  const digest = createHmac("sha256", key ?? new Uint8Array(0)).update(text).digest("hex");
  // The prefix is part of the contract: ledger schemas accept `sha256:` or
  // `hmac:` and reject a bare hex string, so a keyless digest is still tagged.
  return key === undefined ? `sha256:${digest}` : `hmac:${digest}`;
}
