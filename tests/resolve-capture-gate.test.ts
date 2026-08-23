import { describe, expect, it } from "bun:test";
import { resolveCaptureGate } from "../src/resolve-capture-gate.js";

describe("resolveCaptureGate", () => {
  it("is off when the variable is unset", () => {
    expect(resolveCaptureGate({ env: {} })).toEqual({ enabled: false });
    // Off means off: an unrelated variable must not enable anything either.
    expect(resolveCaptureGate({ env: { SQUID_CONTROL_FIFO: "/tmp/f" } })).toEqual({
      enabled: false,
    });
  });

  it("enables the fifo backend on the exact value", () => {
    const resolved = resolveCaptureGate({
      env: { SQUID_CONTROL: "fifo", SQUID_CONTROL_FIFO: "/tmp/control.fifo" },
    });
    expect(resolved).toMatchObject({ enabled: true, readerKind: "fifo" });
  });

  it("rejects a near-miss value as a config error rather than defaulting", () => {
    // The three-outcome rule: unset, exact value, or error. "on" would look
    // like success while silently reading nothing — and a gate that reads
    // nothing is a pause that never lands.
    const resolved = resolveCaptureGate({ env: { SQUID_CONTROL: "on" } });
    expect("configError" in resolved && resolved.configError).toContain(
      'SQUID_CONTROL must be unset (off) or exactly "fifo"',
    );
  });

  it("requires an absolute fifo path", () => {
    for (const path of [undefined, "", "relative/fifo"]) {
      const resolved = resolveCaptureGate({
        env: { SQUID_CONTROL: "fifo", ...(path === undefined ? {} : { SQUID_CONTROL_FIFO: path }) },
      });
      expect("configError" in resolved).toBe(true);
    }
  });

  it("rejects a poll interval that is not a positive integer", () => {
    for (const poll of ["0", "-5", "1.5", "abc"]) {
      const resolved = resolveCaptureGate({
        env: {
          SQUID_CONTROL: "fifo",
          SQUID_CONTROL_FIFO: "/tmp/control.fifo",
          SQUID_CONTROL_POLL_MS: poll,
        },
      });
      expect("configError" in resolved).toBe(true);
    }
  });

  it("ignores a poll interval when the gate is off", () => {
    const resolved = resolveCaptureGate({ env: { SQUID_CONTROL_POLL_MS: "bogus" } });
    expect(resolved).toEqual({ enabled: false });
  });
});
