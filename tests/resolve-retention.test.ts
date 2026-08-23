import { describe, expect, it } from "bun:test";
import { HOUR_MS, resolveRetention, retentionCutoffMs } from "../src/resolve-retention.js";

describe("resolveRetention", () => {
  it("is off when the variable is unset", () => {
    expect(resolveRetention({ env: {} })).toEqual({ enabled: false });
  });

  it("accepts a positive integer of hours", () => {
    expect(resolveRetention({ env: { SQUID_RETENTION_HOURS: "72" } })).toEqual({
      enabled: true,
      hours: 72,
    });
    expect(resolveRetention({ env: { SQUID_RETENTION_HOURS: "1" } })).toEqual({
      enabled: true,
      hours: 1,
    });
  });

  it("refuses every malformed spelling as a config error", () => {
    for (const value of ["", "0", "-3", "2.5", "abc", "1e3", " 24", "24 ", "9007199254740993"]) {
      const resolved = resolveRetention({ env: { SQUID_RETENTION_HOURS: value } });
      expect("configError" in resolved).toBe(true);
    }
  });

  it("names the variable in the config error", () => {
    const resolved = resolveRetention({ env: { SQUID_RETENTION_HOURS: "soon" } });
    expect("configError" in resolved && resolved.configError).toContain("SQUID_RETENTION_HOURS");
  });

  it("computes the cutoff as now minus the bound in whole hours", () => {
    const now = Date.parse("2026-08-22T12:00:00.000Z");
    expect(retentionCutoffMs(72, now)).toBe(now - 72 * HOUR_MS);
    // Zero hours is refused at parse time, so arithmetic never produces
    // "delete the present".
    expect(HOUR_MS).toBe(3_600_000);
  });
});
