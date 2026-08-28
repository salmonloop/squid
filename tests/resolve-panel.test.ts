import { describe, expect, it } from "bun:test";
import { parsePanelTcpEndpoint, resolvePanel } from "../src/resolve-panel.js";

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

  it("on Windows accepts only the loopback TCP spelling", () => {
    // Windows has no std unix-socket transport, so a path spelling would
    // produce a panel that could never connect. The endpoint, not the platform,
    // names the transport — explicit is the only thing both ends can agree on.
    expect(
      resolvePanel({ env: { SQUID_PANEL_SOCKET: "tcp://127.0.0.1:41950" }, platform: "win32" }),
    ).toEqual({ enabled: true, socketPath: "tcp://127.0.0.1:41950" });

    expect(
      resolvePanel({ env: { SQUID_PANEL_SOCKET: "C:\\Users\\me\\panel.sock" }, platform: "win32" }),
    ).toEqual({ configError: "On Windows SQUID_PANEL_SOCKET must be tcp://127.0.0.1:<port>." });
  });

  it("on Windows still refuses a wildcard or non-loopback host", () => {
    // The parse rejects these already, but the platform gate must not loosen
    // what the spelling gate tightened.
    expect(
      resolvePanel({ env: { SQUID_PANEL_SOCKET: "tcp://0.0.0.0:4000" }, platform: "win32" }),
    ).toEqual({ configError: "On Windows SQUID_PANEL_SOCKET must be tcp://127.0.0.1:<port>." });
  });

  it("on non-Windows refuses the TCP spelling rather than guessing a platform", () => {
    // A tcp:// value on Linux would silently bind a listener the bundled panel
    // binary never connects to, because the Rust side picks its transport from
    // the build target. Refusing keeps the two ends from disagreeing.
    expect(
      resolvePanel({ env: { SQUID_PANEL_SOCKET: "tcp://127.0.0.1:41950" }, platform: "linux" }),
    ).toEqual({ configError: "SQUID_PANEL_SOCKET must be an absolute path." });
  });
});

describe("parsePanelTcpEndpoint", () => {
  it("accepts the only endpoint the Windows panel is allowed to use", () => {
    expect(parsePanelTcpEndpoint("tcp://127.0.0.1:41950")).toEqual({
      hostname: "127.0.0.1",
      port: 41950,
    });
  });

  it("refuses any host but loopback", () => {
    // A general host would turn the unauthenticated control socket into a
    // network service; loopback is the whole boundary on Windows.
    expect(parsePanelTcpEndpoint("tcp://0.0.0.0:4000")).toBeNull();
    expect(parsePanelTcpEndpoint("tcp://localhost:4000")).toBeNull();
    expect(parsePanelTcpEndpoint("tcp://192.168.1.4:4000")).toBeNull();
    expect(parsePanelTcpEndpoint("tcp://[::1]:4000")).toBeNull();
  });

  it("refuses malformed ports", () => {
    expect(parsePanelTcpEndpoint("tcp://127.0.0.1")).toBeNull();
    expect(parsePanelTcpEndpoint("tcp://127.0.0.1:0")).toBeNull();
    expect(parsePanelTcpEndpoint("tcp://127.0.0.1:65536")).toBeNull();
    expect(parsePanelTcpEndpoint("tcp://127.0.0.1:notaport")).toBeNull();
  });

  it("refuses extra URL structure", () => {
    expect(parsePanelTcpEndpoint("tcp://user@127.0.0.1:4000")).toBeNull();
    expect(parsePanelTcpEndpoint("tcp://127.0.0.1:4000/base")).toBeNull();
    expect(parsePanelTcpEndpoint("tcp://127.0.0.1:4000?x=1")).toBeNull();
    expect(parsePanelTcpEndpoint("tcp://127.0.0.1:4000#frag")).toBeNull();
  });

  it("refuses the non-tcp spellings a Unix path could take", () => {
    expect(parsePanelTcpEndpoint("/tmp/squid-panel.sock")).toBeNull();
    expect(parsePanelTcpEndpoint("127.0.0.1:4000")).toBeNull();
  });
});
