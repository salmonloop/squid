import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  defaultPanelEndpoint,
  panelExecutablePath,
  resolveWatchRoot,
} from "../src/app-defaults.js";
import {
  askFirstRunAnswers,
  modelConfigurationStatus,
  writeModelConfiguration,
  type FirstRunIO,
} from "../src/app-model.js";
import { ensureSupervisedConfig, prepareLaunch, spawnPanelProcess } from "../src/squid-app.js";

describe("defaultPanelEndpoint", () => {
  it("names the platform's transport: a pipe on Windows, a socket path elsewhere", () => {
    expect(defaultPanelEndpoint({}, "win32")).toBe("\\\\.\\pipe\\squid-panel");
    expect(defaultPanelEndpoint({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux"))
      .toBe("/run/user/1000/squid-panel.sock");
  });

  it("falls back to /tmp when the runtime directory is unset or relative", () => {
    // `resolvePanel` refuses a relative path, so honoring a malformed
    // XDG_RUNTIME_DIR would turn a sane default into a broken startup.
    expect(defaultPanelEndpoint({}, "linux")).toBe("/tmp/squid-panel.sock");
    expect(defaultPanelEndpoint({ XDG_RUNTIME_DIR: "run/user" }, "linux"))
      .toBe("/tmp/squid-panel.sock");
  });
});

describe("resolveWatchRoot", () => {
  it("prefers the variable, then the home directory", () => {
    expect(resolveWatchRoot({ SQUID_WATCH_ROOT: "/tmp/demo" }, "linux")).toBe("/tmp/demo");
    expect(resolveWatchRoot({}, "linux")).not.toBe("");
  });
});

describe("panelExecutablePath", () => {
  it("follows the target, not the host", () => {
    // A Windows zip unpacked anywhere still names its panel `squid-ui.exe`.
    // The separator spelling is the host's (`join` decides), so the assertion
    // that carries the contract is the file name and the directory it sits in,
    // neither of which a platform may rewrite.
    const binary = process.platform === "win32" ? "C:\\opt\\squid\\squid" : "/opt/squid/squid";
    expect(basename(panelExecutablePath("windows", binary))).toBe("squid-ui.exe");
    expect(basename(panelExecutablePath("other", binary))).toBe("squid-ui");
    expect(dirname(panelExecutablePath("windows", binary))).toBe(dirname(binary));
  });
});

describe("modelConfigurationStatus", () => {
  it("is ready only when both the provider and the credential exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "squid-model-"));
    try {
      writeFileSync(
        join(dir, "models.json"),
        JSON.stringify({ providers: { bifrost: { baseUrl: "https://x/v1" } } }),
      );
      writeFileSync(
        join(dir, "auth.json"),
        JSON.stringify({ bifrost: { type: "api_key", key: "k" } }),
      );
      expect(modelConfigurationStatus(dir, "bifrost")).toEqual({ kind: "ready" });
      expect(modelConfigurationStatus(dir, "other")).toEqual({ kind: "missing-provider" });

      rmSync(join(dir, "auth.json"));
      expect(modelConfigurationStatus(dir, "bifrost")).toEqual({ kind: "missing-credential" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to run first-run against a catalog it cannot parse", () => {
    // Overwriting a hand-written file with a generated one because we could
    // not read it is not repair — it is data loss with good intentions.
    const dir = mkdtempSync(join(tmpdir(), "squid-model-"));
    try {
      writeFileSync(join(dir, "models.json"), "{not json");
      expect(modelConfigurationStatus(dir, "bifrost")).toEqual({ kind: "malformed-models" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeModelConfiguration", () => {
  it("writes both halves in Pi's own shapes and preserves other providers", () => {
    const dir = mkdtempSync(join(tmpdir(), "squid-model-"));
    try {
      writeFileSync(
        join(dir, "models.json"),
        JSON.stringify({ providers: { other: { baseUrl: "https://y/v1" } } }),
      );
      writeFileSync(
        join(dir, "auth.json"),
        JSON.stringify({ other: { type: "api_key", key: "kept" } }),
      );

      writeModelConfiguration(dir, "bifrost", {
        baseUrl: "https://x/v1",
        modelId: "deepseek-v4-flash",
        apiKey: "secret",
      });

      const models = JSON.parse(readText(join(dir, "models.json"))) as {
        providers: Record<string, { baseUrl: string; models: { id: string }[] }>;
      };
      expect(models.providers.other?.baseUrl).toBe("https://y/v1");
      const bifrost = models.providers.bifrost;
      expect(bifrost?.baseUrl).toBe("https://x/v1");
      expect(bifrost?.models[0]?.id).toBe("deepseek-v4-flash");

      const auth = JSON.parse(readText(join(dir, "auth.json"))) as {
        other?: { key: string };
        bifrost: { type: string; key: string };
      };
      expect(auth.other?.key).toBe("kept");
      expect(auth.bifrost).toEqual({ type: "api_key", key: "secret" });

      expect(modelConfigurationStatus(dir, "bifrost")).toEqual({ kind: "ready" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

describe("askFirstRunAnswers", () => {
  it("keeps defaults the user accepts and asks the key last", async () => {
    const asked: string[] = [];
    const io: FirstRunIO = {
      prompt: async (message, defaultValue) => {
        asked.push(message);
        return message.startsWith("API base") ? "" : "glm-5.2";
      },
      secret: async (message) => {
        asked.push(message);
        return "k";
      },
      say: () => undefined,
    };

    const answers = await askFirstRunAnswers(io, { modelId: "deepseek-v4-flash" });
    expect(answers).toEqual({
      baseUrl: "https://shanghsin-bifrost.hf.space/v1",
      modelId: "glm-5.2",
      apiKey: "k",
    });
    expect(asked[asked.length - 1]).toBe("API key");
  });
});

/** An absolute directory in the host's own dialect, for the cases that only need one. */
const hostRoot = mkdtempSync(join(tmpdir(), "squid-root-"));

describe("prepareLaunch", () => {
  // A configured agent directory: without it every case below answers
  // needsFirstRun before any other resolution gets a turn. The config path is
  // pointed at a file that does not exist so the suite never reads whatever a
  // developer machine happens to keep at the platform default.
  // The host's own platform, deliberately. Every case below hands the resolver a
  // path that came from the host's `mkdtemp`, and declaring a different platform
  // would tell it to judge `C:\Users\...` by POSIX rules — which call it
  // relative, so the whole suite would fail on a Windows runner for a reason
  // that has nothing to do with what it is testing. The watch-root cases that
  // genuinely need a fixed platform name one themselves.
  const base = {
    platform: process.platform,
    agentDir: readyAgentDir(),
    provider: "bifrost",
    configPath: absentConfigPath(),
  };

  it("lets the panel-supervised child reach needs_config instead of opening readline", () => {
    // The panel child has stdin set to null. The old console-first-run branch
    // would therefore turn a missing model into an invisible blocked question;
    // Phase 2 made the watch session able to run sensors headless and tell the
    // panel `needs_config`, so this preparation path must reach `ready` there.
    const prepared = prepareLaunch({
      ...base,
      env: withConfig(base.configPath, {
        // The host's own temp dir: an absolute path by whatever rules this
        // platform uses, which is what `prepareLaunch` checks it against.
        SQUID_WATCH_ROOT: hostRoot,
        SQUID_SUPERVISED: "1",
      }),
      agentDir: join(mkdtempSync(join(tmpdir(), "squid-empty-agent-")), "agent"),
      allowNeedsConfig: true,
    });
    const ready = expectReady(prepared);
    expect(ready.root).toBe(hostRoot);
    expect(ready.env.SQUID_SUPERVISED).toBe("1");
  });

  it("keeps the ordinary packaged launch in console first-run mode", () => {
    // The escape hatch belongs only to the panel child. A direct `squid` launch
    // still owns an interactive console and should ask once, not silently start
    // a session with no model.
    const prepared = prepareLaunch({
      ...base,
      env: withConfig(base.configPath, { SQUID_WATCH_ROOT: hostRoot }),
      agentDir: join(mkdtempSync(join(tmpdir(), "squid-empty-agent-")), "agent"),
    });
    expect(prepared).toEqual({ needsFirstRun: true });
  });

  it("wires the default endpoint through the same resolver an explicit value takes", () => {
    // The assertion is not that a default exists — it is that the packaged run
    // and a CLI run agree on what the endpoint means for a platform. Pinned to
    // linux because the expectation is a POSIX socket path, so the config path
    // handed alongside it has to be a POSIX one too.
    const ready = expectReady(
      prepareLaunch({
        ...base,
        platform: "linux",
        env: withConfig("/tmp/squid-absent/config.json", { SQUID_WATCH_ROOT: "/tmp/demo" }),
      }),
    );
    expect(ready.panelSocket).toBe("/tmp/squid-panel.sock");
  });

  it("rejects a relative watch root before any sink opens", () => {
    const result = prepareLaunch({
      ...base,
      platform: "linux",
      env: withConfig("/tmp/squid-absent/config.json", { SQUID_WATCH_ROOT: "relative" }),
    });
    expect("configError" in result).toBe(true);
  });

  it("pre-fills settings from the config file the env does not set", () => {
    // The file names a relative watch root; the env names none. The failure to
    // start is the observable: it proves the file's string reached the same
    // variable the env would have carried, through the resolver prepareLaunch
    // actually checks — watch root, the one SQUID_ setting it validates itself.
    const dir = mkdtempSync(join(tmpdir(), "squid-config-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, JSON.stringify({ watchRoot: "relative" }));
      const result = prepareLaunch({
        ...base,
        env: withConfig(path, {}),
      });
      expect("configError" in result).toBe(true);
      if ("configError" in result) {
        expect(result.configError).toBe("SQUID_WATCH_ROOT must be an absolute path.");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on a broken config file before the model check runs", () => {
    // Order is the contract: a file the session cannot read is a cheaper
    // answer than first-run, and reporting it first keeps the diagnosis on
    // the thing that is actually wrong.
    const dir = mkdtempSync(join(tmpdir(), "squid-config-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, "{not json");
      const result = prepareLaunch({
        ...base,
        // An unconfigured agent dir would otherwise answer needsFirstRun.
        agentDir: join(dir, "absent-agent"),
        env: withConfig(path, {}),
      });
      expect("configError" in result).toBe(true);
      if ("configError" in result) {
        expect(result.configError).toContain("not valid JSON");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function withConfig(
  path: string,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return { ...env, SQUID_CONFIG: path };
}

/** A path in a fresh temp dir that nothing writes: the hermetic "no file". */
function absentConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), "squid-config-")), "config.json");
}

function readyAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "squid-ready-"));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({ providers: { bifrost: { baseUrl: "https://x/v1" } } }),
  );
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ bifrost: { type: "api_key", key: "k" } }),
  );
  return dir;
}

function expectReady(result: ReturnType<typeof prepareLaunch>): {
  env: Record<string, string | undefined>;
  root: string;
  panelSocket: string;
  configPath: string;
} {
  if (!("ready" in result)) throw new Error(`expected ready, got ${JSON.stringify(result)}`);
  return result.ready;
}

describe("ensureSupervisedConfig", () => {
  it("creates an empty settings file only for the panel-supervised child", () => {
    // CLI shape: no write. Absence already means resolver defaults, and a command
    // line tool that leaves files merely for having run would turn observation
    // into a side effect.
    const dir = mkdtempSync(join(tmpdir(), "squid-config-"));
    try {
      const path = join(dir, "nested", "config.json");
      expect(ensureSupervisedConfig({ env: {}, configPath: path })).toEqual({ ok: true });
      expect(exists(path)).toBe(false);

      expect(ensureSupervisedConfig({
        env: { SQUID_SUPERVISED: "1" },
        configPath: path,
      })).toEqual({ ok: true });
      expect(JSON.parse(readText(path))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never overwrites a malformed file while trying to make a default", () => {
    // An existing hand-written file is read first. A default writer that repaired
    // it into {} would erase the evidence and start the session under settings
    // the user never chose.
    const dir = mkdtempSync(join(tmpdir(), "squid-config-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, "{broken", "utf8");
      const result = ensureSupervisedConfig({
        env: { SQUID_SUPERVISED: "1" },
        configPath: path,
      });
      expect("configError" in result).toBe(true);
      expect(readText(path)).toBe("{broken");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// `existsSync` by another name keeps the assertion's purpose readable: it asks
// whether supervised first-run created the file, not whether some value resolved.
function exists(path: string): boolean {
  try {
    return readFileSync(path), true;
  } catch {
    return false;
  }
}

describe("spawnPanelProcess", () => {
  it("reports a missing panel binary as a diagnostic, not a crash", () => {
    const diagnostics: string[] = [];
    spawnPanelProcess({
      socketPath: "/tmp/squid-panel.sock",
      env: {},
      platform: "linux",
      execPath: "/opt/squid/squid",
      logError: (line) => diagnostics.push(line),
      exists: () => false,
    });
    expect(diagnostics).toHaveLength(1);
  });

  it("hands the child the same endpoint string the session listens on", () => {
    // The endpoint travels by env, the one variable every panel client reads.
    // The exe's separator spelling is the host's, so its name is the part
    // asserted here rather than the whole path.
    const seen = childEndpointOf({
      socketPath: "/tmp/squid-panel.sock",
      env: { SQUID_DB: "/tmp/x.db", OTHER: undefined },
      platform: "linux",
      execPath: "/opt/squid/squid",
      logError: () => undefined,
      exists: () => true,
    });
    expect(seen.env).toEqual({ SQUID_DB: "/tmp/x.db", SQUID_PANEL_SOCKET: "/tmp/squid-panel.sock" });
    expect(basename(seen.exe)).toBe("squid-ui");
  });

  it("does not spawn a panel when a panel is already supervising this run", () => {
    // The panel started this brain, so it is attached already. A second window
    // would share the endpoint, and this process would kill it on shutdown while
    // the supervisor's own panel stayed up waiting to respawn us — ownership has
    // to run one way, and this is the check that keeps it there.
    const diagnostics: string[] = [];
    const original = Bun.spawn;
    let spawned = 0;
    (Bun as { spawn: typeof Bun.spawn }).spawn = (() => {
      spawned += 1;
      return { kill: () => undefined } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    try {
      spawnPanelProcess({
        socketPath: "/tmp/squid-panel.sock",
        env: { SQUID_SUPERVISED: "1" },
        platform: "linux",
        execPath: "/opt/squid/squid",
        logError: (line) => diagnostics.push(line),
        exists: () => true,
      });
    } finally {
      (Bun as { spawn: typeof Bun.spawn }).spawn = original;
    }
    expect(spawned).toBe(0);
    // Silent, not a diagnostic: nothing went wrong. The panel is exactly where
    // it should be, so a warning would train the user to ignore warnings.
    expect(diagnostics).toEqual([]);
  });

  it("kills the panel on the shutdown signals, not on a Bun `exit` event", () => {
    // Bun never runs `exit` handlers — measured with a spawned sleeper that
    // outlived its parent on a natural exit. The cleanup has to ride the
    // signals the watch session treats as shutdown, and this asserts the
    // registered handler actually kills, invoked directly so no other suite's
    // SIGINT listeners fire with it.
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const before = process.listeners(signal);
      let killed = false;
      const original = Bun.spawn;
      (Bun as { spawn: typeof Bun.spawn }).spawn = (() => ({
        kill: () => {
          killed = true;
        },
      })) as unknown as typeof Bun.spawn;
      try {
        spawnPanelProcess({
          socketPath: "/tmp/squid-panel.sock",
          env: {},
          platform: "linux",
          execPath: "/opt/squid/squid",
          logError: () => undefined,
          exists: () => true,
        });
        const added = process.listeners(signal).filter((l) => !before.includes(l));
        expect(added).toHaveLength(1);
        added[0]!(signal);
        expect(killed).toBe(true);
      } finally {
        for (const listener of process.listeners(signal)) {
          if (before.includes(listener)) continue;
          // The union-typed signal defeats removeListener's overloads, so the
          // branch spells each name the overloads recognize.
          if (signal === "SIGINT") process.removeListener("SIGINT", listener);
          else process.removeListener("SIGTERM", listener);
        }
        (Bun as { spawn: typeof Bun.spawn }).spawn = original;
      }
    }
  });
});

/**
 * Extracts the spawn arguments without spawning: the real `Bun.spawn` call is
 * the one line this test cannot run, so everything leading up to it is
 * asserted through the seam below.
 */
function childEndpointOf(options: Parameters<typeof spawnPanelProcess>[0]): {
  exe: string;
  env: Record<string, string>;
} {
  const seen: { exe: string; env: Record<string, string> } = { exe: "", env: {} };
  // Re-derive by running the exported function with a stubbed Bun.spawn.
  const original = Bun.spawn;
  (Bun as { spawn: typeof Bun.spawn }).spawn = ((command: string[], opts: {
    env: Record<string, string>;
  }) => {
    seen.exe = command[0]!;
    seen.env = opts.env;
    return { kill: () => undefined } as unknown as ReturnType<typeof Bun.spawn>;
  }) as typeof Bun.spawn;
  try {
    spawnPanelProcess(options);
  } finally {
    (Bun as { spawn: typeof Bun.spawn }).spawn = original;
  }
  return seen;
}
