import { describe, expect, it } from "bun:test";
import { PANEL_PIPE_PREFIX, parsePanelPipeName, resolvePanel } from "../src/resolve-panel.js";

describe("resolvePanel", () => {
  it("is off when SQUID_PANEL_SOCKET is unset", () => {
    expect(resolvePanel({ env: {} })).toEqual({ enabled: false });
  });

  // Every case below is about the Unix spelling, so every one of them names its
  // platform instead of inheriting the host's. Omitting it reads as "platform is
  // irrelevant here", which is the opposite of true: the default is
  // `process.platform`, so on a Windows runner these same assertions would be
  // put to the win32 branch, where an absolute POSIX path is *correctly*
  // refused — and the suite would fail for being right.
  it("enables the panel for an absolute socket path", () => {
    expect(
      resolvePanel({ env: { SQUID_PANEL_SOCKET: "/tmp/squid-panel.sock" }, platform: "linux" }),
    ).toEqual({
      enabled: true,
      socketPath: "/tmp/squid-panel.sock",
    });
  });

  it("refuses a relative path rather than resolving it against the cwd", () => {
    // The socket file's mode is the only access boundary; a path that means a
    // different file depending on where the process launched would put that
    // boundary somewhere nobody chose.
    const result = resolvePanel({
      env: { SQUID_PANEL_SOCKET: "squid-panel.sock" },
      platform: "linux",
    });
    expect(result).toEqual({ configError: "SQUID_PANEL_SOCKET must be an absolute path." });
    expect("enabled" in result).toBe(false);
  });

  it("refuses a dot-relative path too", () => {
    // Named for the same reason, and asserted on the message rather than merely
    // on `"configError" in result`: the weaker form passes on Windows too, but
    // for the pipe-spelling reason, so it would keep reporting success while
    // testing something else entirely.
    const result = resolvePanel({
      env: { SQUID_PANEL_SOCKET: "./run/panel.sock" },
      platform: "linux",
    });
    expect(result).toEqual({ configError: "SQUID_PANEL_SOCKET must be an absolute path." });
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

  it("on Windows accepts a named pipe and hands back the normalized spelling", () => {
    // Windows has no std unix-socket transport, so a path spelling would produce
    // a panel that could never connect. The endpoint, not the platform, names
    // the transport — explicit is the only thing both ends can agree on.
    expect(
      resolvePanel({
        env: { SQUID_PANEL_SOCKET: "\\\\.\\pipe\\squid-panel" },
        platform: "win32",
      }),
    ).toEqual({ enabled: true, socketPath: "\\\\.\\pipe\\squid-panel" });

    // What the caller wrote is not necessarily what comes back: the resolution
    // carries the normal form, so the bind, the panel's connect, and any
    // diagnostic are all talking about one string.
    expect(
      resolvePanel({
        env: { SQUID_PANEL_SOCKET: "//./pipe/squid-panel" },
        platform: "win32",
      }),
    ).toEqual({ enabled: true, socketPath: "\\\\.\\pipe\\squid-panel" });
  });

  it("on Windows refuses a drive path and the loopback TCP spelling it replaced", () => {
    // A drive path is the mistake a Unix habit produces; tcp:// is the one an
    // older README produces. Both must fail at startup rather than bind
    // something the panel will not find.
    for (const value of ["C:\\Users\\me\\panel.sock", "tcp://127.0.0.1:41950"]) {
      expect(resolvePanel({ env: { SQUID_PANEL_SOCKET: value }, platform: "win32" })).toEqual({
        configError: "On Windows SQUID_PANEL_SOCKET must be a named pipe: \\\\.\\pipe\\<name>.",
      });
    }
  });

  it("on non-Windows refuses the pipe spelling rather than guessing a platform", () => {
    // A pipe value on Linux would bind a socket file whose name contains
    // backslashes, in the cwd, that the bundled panel binary never looks for —
    // the Rust side picks its transport from the build target. Refusing keeps
    // the two ends from disagreeing.
    expect(
      resolvePanel({
        env: { SQUID_PANEL_SOCKET: "\\\\.\\pipe\\squid-panel" },
        platform: "linux",
      }),
    ).toEqual({ configError: "SQUID_PANEL_SOCKET must be an absolute path." });
  });
});

describe("parsePanelPipeName", () => {
  it("accepts every spelling Bun accepts, and normalizes them to one", () => {
    // These four are the same pipe. Bun's own `normalize_pipe_name` rewrites
    // the prefix and keeps the name, so this function must agree exactly: a
    // value it accepts that Bun would not is a value that silently binds an
    // AF_UNIX socket instead.
    for (const spelling of [
      "\\\\.\\pipe\\squid-panel",
      "//./pipe/squid-panel",
      "\\\\?\\pipe\\squid-panel",
      "\\/.\\pipe/squid-panel",
    ]) {
      expect(parsePanelPipeName(spelling)).toBe("\\\\.\\pipe\\squid-panel");
    }
    expect(PANEL_PIPE_PREFIX).toBe("\\\\.\\pipe\\");
  });

  it("passes the name through untouched, including separators inside it", () => {
    // The pipe namespace is flat but permits separators in a name. Normalizing
    // them would connect to a pipe the caller did not ask for.
    expect(parsePanelPipeName("\\\\.\\pipe\\squid\\panel-7")).toBe(
      "\\\\.\\pipe\\squid\\panel-7",
    );
    expect(parsePanelPipeName("//./pipe/LOCAL/squid-panel")).toBe(
      "\\\\.\\pipe\\LOCAL/squid-panel",
    );
  });

  it("refuses a prefix with no name behind it", () => {
    // Length 9 exactly: a prefix and nothing else would bind a pipe called
    // nothing, so the boundary is > 9 rather than >= 9.
    expect(parsePanelPipeName("\\\\.\\pipe\\")).toBeNull();
    expect(parsePanelPipeName("//./pipe/")).toBeNull();
    // A separator where the name should start is the same emptiness one
    // character later.
    expect(parsePanelPipeName("\\\\.\\pipe\\\\name")).toBeNull();
  });

  it("refuses a malformed prefix rather than repairing it", () => {
    expect(parsePanelPipeName("\\.\\pipe\\squid-panel")).toBeNull(); // one leading separator
    expect(parsePanelPipeName("\\\\x\\pipe\\squid-panel")).toBeNull(); // device is not . or ?
    expect(parsePanelPipeName("\\\\.\\pipes\\squid-panel")).toBeNull(); // pipes, not pipe
    expect(parsePanelPipeName("\\\\.pipe\\squid-panel")).toBeNull(); // missing separator
  });

  it("refuses PIPE in the wrong case, because Bun does", () => {
    // Not pedantry: Bun compares those four bytes exactly, so an uppercase
    // spelling falls through to its AF_UNIX branch. Accepting it here is how
    // the gate would pass a value that then binds the wrong kind of thing.
    expect(parsePanelPipeName("\\\\.\\PIPE\\squid-panel")).toBeNull();
    expect(parsePanelPipeName("\\\\.\\Pipe\\squid-panel")).toBeNull();
  });

  it("refuses the spellings the other platform and the old transport would use", () => {
    expect(parsePanelPipeName("/tmp/squid-panel.sock")).toBeNull();
    expect(parsePanelPipeName("C:\\Users\\me\\panel.sock")).toBeNull();
    expect(parsePanelPipeName("tcp://127.0.0.1:41950")).toBeNull();
    expect(parsePanelPipeName("squid-panel")).toBeNull();
    expect(parsePanelPipeName("")).toBeNull();
  });
});
