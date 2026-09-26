import { describe, expect, it } from "bun:test";
import {
  DEFAULT_ATTENTION_WINDOW_MINUTES,
  MINUTE_MS,
  resolveAttentionWindow,
} from "../src/resolve-attention-window.js";

describe("resolveAttentionWindow", () => {
  it("uses the default bound when the variable is unset — not off", () => {
    // An unbounded view is the failure this exists to prevent, so a run that
    // configures nothing still gets a bound, unlike retention.
    expect(resolveAttentionWindow({ env: {} })).toEqual({
      minutes: DEFAULT_ATTENTION_WINDOW_MINUTES,
      windowMs: DEFAULT_ATTENTION_WINDOW_MINUTES * MINUTE_MS,
    });
  });

  it("accepts a positive integer of minutes and converts to milliseconds once", () => {
    expect(resolveAttentionWindow({ env: { SQUID_ATTENTION_WINDOW_MINUTES: "30" } })).toEqual({
      minutes: 30,
      windowMs: 30 * MINUTE_MS,
    });
    expect(resolveAttentionWindow({ env: { SQUID_ATTENTION_WINDOW_MINUTES: "1" } })).toEqual({
      minutes: 1,
      windowMs: MINUTE_MS,
    });
  });

  it("refuses every malformed spelling as a config error", () => {
    // Empty string is a value the env layer passes verbatim (not the absence a
    // blank settings field writes), so it is judged like the rest. `Number()`
    // would take "1e3" and " 15"; a lax parse here would mean a window other
    // than the one written.
    for (const value of ["", "0", "-3", "2.5", "abc", "1e3", " 15", "15 ", "9007199254740993"]) {
      const resolved = resolveAttentionWindow({ env: { SQUID_ATTENTION_WINDOW_MINUTES: value } });
      expect("configError" in resolved).toBe(true);
    }
  });

  it("names the variable in the config error", () => {
    const resolved = resolveAttentionWindow({ env: { SQUID_ATTENTION_WINDOW_MINUTES: "soon" } });
    expect("configError" in resolved && resolved.configError).toContain("SQUID_ATTENTION_WINDOW_MINUTES");
  });

  it("keeps minute as the human unit and one minute as 60_000 ms", () => {
    expect(MINUTE_MS).toBe(60_000);
    expect(DEFAULT_ATTENTION_WINDOW_MINUTES).toBe(15);
  });
});
