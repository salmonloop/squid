import { describe, expect, it } from "bun:test";
import { resolvePanel } from "../src/resolve-panel.js";

describe("resolvePanel", () => {
  it("is off when SQUID_PANEL_SOCKET is unset", () => {
    expect(resolvePanel({ env: {} })).toEqual({ enabled: false });
  });

  it("enables the panel for an absolute socket path", () => {
    expect(resolvePanel({ env: { SQUID_PANEL_SOCKET: "/tmp/squid-panel.sock" } })).toEqual({
      enabled: true,
      socketPath: "/tmp/squid-panel.sock",
    });
  });

  it("refuses a relative path rather than resolving it against the cwd", () => {
    // The socket file's mode is the only access boundary; a path that means a
    // different file depending on where the process launched would put that
    // boundary somewhere nobody chose.
    const result = resolvePanel({ env: { SQUID_PANEL_SOCKET: "squid-panel.sock" } });
    expect(result).toEqual({ configError: "SQUID_PANEL_SOCKET must be an absolute path." });
    expect("enabled" in result).toBe(false);
  });

  it("refuses a dot-relative path too", () => {
    const result = resolvePanel({ env: { SQUID_PANEL_SOCKET: "./run/panel.sock" } });
    expect("configError" in result).toBe(true);
  });

  it("treats an empty value as a configuration error, not a second way to say off", () => {
    const result = resolvePanel({ env: { SQUID_PANEL_SOCKET: "" } });
    expect(result).toEqual({
      configError: "SQUID_PANEL_SOCKET must name a path, or be unset (off).",
    });
  });

  it("ignores unrelated capability variables", () => {
    expect(
      resolvePanel({ env: { SQUID_CONTROL: "fifo", SQUID_CONTROL_FIFO: "/tmp/gate" } }),
    ).toEqual({ enabled: false });
  });

  it("reads process.env when no env is supplied", () => {
    // Default-off matters most here: an unset variable in the real environment
    // must not start a socket nobody asked for.
    const saved = process.env.SQUID_PANEL_SOCKET;
    delete process.env.SQUID_PANEL_SOCKET;
    try {
      expect(resolvePanel()).toEqual({ enabled: false });
    } finally {
      if (saved !== undefined) process.env.SQUID_PANEL_SOCKET = saved;
    }
  });
});
