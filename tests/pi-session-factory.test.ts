import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfiguredModel, resolvePiModel } from "../src/pi-session-factory.js";

/**
 * Which model a session opens, and where that answer comes from.
 *
 * These two resolutions were one function, and the settings form is what
 * exposed the conflation: saving a model id rewrites Pi's `models.json` entry,
 * while a session resolved its model from the env default and then looked up an
 * id the write had just replaced. The field reported a successful save and the
 * agent refused to start. So `resolvePiModel` is the *default* -- what a write
 * falls back to -- and `resolveConfiguredModel` is the *answer*: whatever is
 * stored for the provider.
 */

function agentDirWith(models: unknown): { dir: string; agentDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "squid-model-"));
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  if (models !== undefined) {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(models), "utf8");
  }
  return { dir, agentDir };
}

describe("resolveConfiguredModel", () => {
  it("reports the id stored for the provider, not the env default", () => {
    const { dir, agentDir } = agentDirWith({
      providers: { bifrost: { baseUrl: "https://example/v1", models: [{ id: "saved-model" }] } },
    });
    try {
      // The regression in one line: the default is still `deepseek-v4-flash`,
      // and a session that used it would look up a model the form replaced.
      expect(resolvePiModel({}).modelId).toBe("deepseek-v4-flash");
      expect(resolveConfiguredModel(agentDir)).toEqual({
        provider: "bifrost",
        modelId: "saved-model",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the default when nothing is stored yet", () => {
    // A fresh machine: first-run needs a suggestion to offer, and a write needs
    // something to write. The fallback is what makes both possible.
    const { dir, agentDir } = agentDirWith(undefined);
    try {
      expect(resolveConfiguredModel(agentDir)).toEqual({
        provider: "bifrost",
        modelId: "deepseek-v4-flash",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back when the provider is absent or the file is malformed", () => {
    const other = agentDirWith({ providers: { openai: { models: [{ id: "gpt" }] } } });
    try {
      // Another provider's catalog says nothing about ours.
      expect(resolveConfiguredModel(other.agentDir).modelId).toBe("deepseek-v4-flash");
    } finally {
      rmSync(other.dir, { recursive: true, force: true });
    }

    const broken = mkdtempSync(join(tmpdir(), "squid-model-bad-"));
    const brokenAgent = join(broken, "agent");
    mkdirSync(brokenAgent, { recursive: true });
    writeFileSync(join(brokenAgent, "models.json"), "{ not json", "utf8");
    try {
      // A file the user broke by hand is not ours to interpret; the startup
      // status check is what refuses it loudly.
      expect(resolveConfiguredModel(brokenAgent).modelId).toBe("deepseek-v4-flash");
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it("lets an explicit option outrank both the store and the default", () => {
    const { dir, agentDir } = agentDirWith({
      providers: { bifrost: { models: [{ id: "saved-model" }] } },
    });
    try {
      // Callers that already know which model they mean (a test, an eval run)
      // still say so, and are not second-guessed by a file.
      expect(resolveConfiguredModel(agentDir, { modelId: "explicit" }).modelId).toBe("explicit");
      expect(resolveConfiguredModel(agentDir, { provider: "openai" }).provider).toBe("openai");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
