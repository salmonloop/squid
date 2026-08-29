import { describe, expect, it } from "bun:test";
import { resolveAgentTurnTimeout } from "../src/resolve-agent-turn-timeout.js";

/**
 * The watchdog bound's own boundary: unset is the default (a watchdog nobody
 * asked for is still a watchdog), and anything malformed is a startup error —
 * a bound that silently meant something else than what was written is the
 * failure this resolution exists to prevent.
 */
describe("resolveAgentTurnTimeout", () => {
  it("defaults when the variable is unset or empty", () => {
    expect(resolveAgentTurnTimeout({})).toEqual({ timeoutMs: 600_000 });
    expect(resolveAgentTurnTimeout({ SQUID_AGENT_TURN_TIMEOUT_MS: "" })).toEqual({
      timeoutMs: 600_000,
    });
  });

  it("accepts a plain positive integer", () => {
    expect(resolveAgentTurnTimeout({ SQUID_AGENT_TURN_TIMEOUT_MS: "120000" })).toEqual({
      timeoutMs: 120_000,
    });
  });

  it("refuses zero, negative, and non-integer spellings", () => {
    for (const value of ["0", "-1", "1.5", "1e3", "0x14", " 5000", "soon"]) {
      expect(resolveAgentTurnTimeout({ SQUID_AGENT_TURN_TIMEOUT_MS: value })).toHaveProperty(
        "configError",
      );
    }
  });
});
