import { describe, expect, it } from "bun:test";
import {
  AUDIT_TEXT_MAX_LENGTH,
  SEARCH_EGRESS_ALLOW_ID,
  SEARCH_EGRESS_DENY_ID,
  auditTextDigest,
  describeErrorForAudit,
  resolveSearchEgress,
  sanitizeAuditText,
} from "../src/action-egress.js";

describe("resolveSearchEgress", () => {
  it("allows when the variable is unset — the open-by-default posture", () => {
    expect(resolveSearchEgress(undefined)).toEqual({
      id: SEARCH_EGRESS_ALLOW_ID,
      searchEgress: "allow",
    });
  });

  it("denies on the exact opt-in spelling", () => {
    expect(resolveSearchEgress("deny")).toEqual({
      id: SEARCH_EGRESS_DENY_ID,
      searchEgress: "deny",
    });
  });

  it("still allows the exact allow spelling", () => {
    expect(resolveSearchEgress("allow")).toEqual({
      id: SEARCH_EGRESS_ALLOW_ID,
      searchEgress: "allow",
    });
  });

  it("rejects near-miss values as config errors, in both directions", () => {
    for (const value of ["Allow", "allowed", "ALLOW", "DENY", "Deny", "", "allow ", "deny ", "off"]) {
      const resolved = resolveSearchEgress(value);
      expect("configError" in resolved).toBe(true);
    }
  });
});

describe("sanitizeAuditText", () => {
  it("is deterministic for identical input", () => {
    // Audit digests are compared across processes, so both classes must be
    // reproducible — including the previewable one, whose text feeds the digest.
    expect(sanitizeAuditText("some selection", "selection"))
      .toEqual(sanitizeAuditText("some selection", "selection"));
    expect(sanitizeAuditText("Bearer abc123def4567890 tail", "mcp_summary"))
      .toEqual(sanitizeAuditText("Bearer abc123def4567890 tail", "mcp_summary"));
  });

  it("strips control characters and collapses whitespace", () => {
    const result = sanitizeAuditText("line1\n\tline2\u0000x", "rationale");
    expect(result.text).toBe("line1 line2 x");
  });

  it("redacts bearer tokens, url credentials, and long hex secrets", () => {
    expect(sanitizeAuditText("auth Bearer abc123def4567890", "mcp_summary").text)
      .toBe("auth [redacted]");
    // The scheme's slashes are consumed by the match, but the host stays visible.
    expect(sanitizeAuditText("https://user:hunter2@example.com/path", "mcp_summary").text)
      .toBe("https:[redacted]example.com/path");
    expect(sanitizeAuditText("key token: supersecretvalue1", "mcp_summary").text)
      .toBe("key [redacted]");
    expect(sanitizeAuditText(`digest ${"a".repeat(40)}`, "rationale").text)
      .toBe("digest [redacted]");
  });

  it("truncates to the fixed ceiling with original length preserved", () => {
    const result = sanitizeAuditText("x".repeat(AUDIT_TEXT_MAX_LENGTH + 50), "rationale");
    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBe(AUDIT_TEXT_MAX_LENGTH + 50);
    expect(result.text.length).toBeLessThanOrEqual(AUDIT_TEXT_MAX_LENGTH + 1);
  });

  it("never previews selections or summaries even when preview text exists", () => {
    expect(sanitizeAuditText("secret query", "selection").previewAllowed).toBe(false);
    expect(sanitizeAuditText("cd /repo && bun test", "summary").previewAllowed).toBe(false);
    expect(sanitizeAuditText("because focus matched", "rationale").previewAllowed).toBe(true);
    expect(sanitizeAuditText("tool returned ok", "mcp_summary").previewAllowed).toBe(true);
  });

  /**
   * `previewAllowed: false` is advice; a caller can ignore advice. For selection
   * and summary the sanitized string is therefore not returned at all, so
   * reaching for a preview is a compile error rather than a quiet leak. These
   * assertions pin the runtime half of that guarantee: even a caller who casts
   * the type away finds nothing to read.
   */
  it("withholds the sanitized string entirely for unpreviewable classes", () => {
    const secret = "quarterly revenue projection";
    for (const kind of ["selection", "summary"] as const) {
      const result = sanitizeAuditText(secret, kind);
      expect(Object.keys(result).sort()).toEqual([
        "originalLength",
        "previewAllowed",
        "truncated",
      ]);
      expect(JSON.stringify(result)).not.toContain(secret);
      // Measurements still work — that is the whole point of measuring.
      expect(result.originalLength).toBe(secret.length);
    }
  });

  it("agrees on truncation across both classes for the same input", () => {
    // The unpreviewable branch drops the redacted string, so it would be easy to
    // let the two branches disagree on whether truncation happened.
    const long = "x".repeat(AUDIT_TEXT_MAX_LENGTH + 1);
    expect(sanitizeAuditText(long, "selection").truncated).toBe(true);
    expect(sanitizeAuditText(long, "rationale").truncated).toBe(true);

    const short = "x".repeat(AUDIT_TEXT_MAX_LENGTH);
    expect(sanitizeAuditText(short, "selection").truncated).toBe(false);
    expect(sanitizeAuditText(short, "rationale").truncated).toBe(false);
  });
});

/**
 * An error message is untrusted text like any other. It quotes the thing that
 * failed — a path, a SQL fragment, a tool's own stderr — and a screen or MCP
 * failure can quote the selection outright, so every caught error reaches a log
 * or a diagnostic through this one function.
 */
describe("describeErrorForAudit", () => {
  it("sanitizes an Error's message the same way model text is sanitized", () => {
    expect(describeErrorForAudit(new Error("failed\n\ton  line"))).toBe("failed on line");
    expect(describeErrorForAudit(new Error("auth Bearer abc123def4567890")))
      .toBe("auth [redacted]");
    expect(describeErrorForAudit(new Error("x".repeat(AUDIT_TEXT_MAX_LENGTH + 10))).length)
      .toBeLessThanOrEqual(AUDIT_TEXT_MAX_LENGTH + 1);
  });

  it("handles non-Error throws without leaking their raw form", () => {
    expect(describeErrorForAudit("plain string")).toBe("plain string");
    expect(describeErrorForAudit({ toString: () => "token: supersecretvalue1" }))
      .toBe("[redacted]");
    expect(describeErrorForAudit(undefined)).toBe("undefined");
  });

  it("drops the stack, which would name the machine's directory layout", () => {
    const error = new Error("boom");
    expect(error.stack).toContain("action-egress.test");
    expect(describeErrorForAudit(error)).toBe("boom");
  });

  it("is deterministic, so diagnostics stay comparable across processes", () => {
    const error = new Error("same failure");
    expect(describeErrorForAudit(error)).toBe(describeErrorForAudit(error));
  });
});

describe("auditTextDigest", () => {
  it("is deterministic without a key", () => {
    expect(auditTextDigest("same")).toBe(auditTextDigest("same"));
    expect(auditTextDigest("same")).not.toBe(auditTextDigest("other"));
  });

  it("differs by key so digests cannot be brute-forced offline", () => {
    const key = new Uint8Array([1, 2, 3]);
    expect(auditTextDigest("same", key)).not.toBe(auditTextDigest("same"));
    expect(auditTextDigest("same", key)).toBe(auditTextDigest("same", key));
    expect(auditTextDigest("same", key).startsWith("hmac:")).toBe(true);
  });
});
