import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { prepareLaunch, spawnPanelProcess } from "../src/squid-app.js";

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
    expect(panelExecutablePath("windows", "/opt/squid/squid")).toBe("/opt/squid/squid-ui.exe");
    expect(panelExecutablePath("other", "/opt/squid/squid")).toBe("/opt/squid/squid-ui");
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

describe("prepareLaunch", () => {
  // A configured agent directory: without it every case below answers
  // needsFirstRun before any other resolution gets a turn.
  const base = {
    platform: "linux" as const,
    agentDir: readyAgentDir(),
    provider: "bifrost",
  };

  it("wires the default endpoint through the same resolver an explicit value takes", () => {
    // The assertion is not that a default exists — it is that the packaged run
    // and a CLI run agree on what the endpoint means for a platform.
    const ready = expectReady(
      prepareLaunch({ ...base, env: { SQUID_WATCH_ROOT: "/tmp/demo" } }),
    );
    expect(ready.panelSocket).toBe("/tmp/squid-panel.sock");
  });

  it("rejects a relative watch root before any sink opens", () => {
    const result = prepareLaunch({ ...base, env: { SQUID_WATCH_ROOT: "relative" } });
    expect("configError" in result).toBe(true);
  });
});

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
} {
  if (!("ready" in result)) throw new Error(`expected ready, got ${JSON.stringify(result)}`);
  return result.ready;
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
    expect(
      childEndpointOf({
        socketPath: "/tmp/squid-panel.sock",
        env: { SQUID_DB: "/tmp/x.db", OTHER: undefined },
        platform: "linux",
        execPath: "/opt/squid/squid",
        logError: () => undefined,
        exists: () => true,
      }),
    ).toEqual({
      exe: "/opt/squid/squid-ui",
      env: { SQUID_DB: "/tmp/x.db", SQUID_PANEL_SOCKET: "/tmp/squid-panel.sock" },
    });
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
