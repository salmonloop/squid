import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDesktopWatch } from "../src/watch-desktop.js";
import type { ResidentSession } from "../src/resident-agent.js";

/**
 * The desktop entry's one job before it starts anything: resolve every capability
 * against the environment the config file has already been merged into.
 *
 * `loadConfiguredEnvironment` returns a merged object and deliberately does not
 * touch `process.env`, so a resolver called without that object reads the raw
 * environment, sees nothing, and quietly takes its default. Four of them used to
 * be called that way, which made `screenReader`, `browser`, `terminal`, and
 * `editorSaves` settings that saved, reported "takes effect on restart", and then
 * did nothing.
 *
 * The banner is the assertion because it is the one place the run states which
 * backend each capability actually got. An invalid value would not do: the config
 * file is validated as it is read, so a bad value is refused at step zero and
 * never reaches a resolver — the refusal would pass whether or not the merge was
 * wired through.
 *
 * `synthetic` is the value under test for both readers with a choice, because it
 * is the one backend that needs no particular host: a real screen or browser
 * backend is per-platform, and a test that asserted one would only be asserting
 * which machine ran it.
 */

/** Enough of a session to satisfy the watch loop; no model is reached. */
function silentAgent(): ResidentSession {
  return {
    async prompt(): Promise<void> {},
    async waitForIdle(): Promise<void> {},
    async abort(): Promise<void> {},
    getLastAssistantText(): string | undefined {
      return undefined;
    },
    async observe(): Promise<void> {},
    dispose(): void {},
  };
}

describe("startDesktopWatch capability resolution", () => {
  it("resolves every reader against the merged config file, not the raw environment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "squid-desktop-env-"));
    const configPath = join(directory, "config.json");
    // Two capabilities the file alone turns on, and one it leaves off. The third
    // matters as much as the first two: it proves the banner is reporting the
    // file's answers rather than reporting "on" for everything.
    writeFileSync(
      configPath,
      JSON.stringify({ screenReader: "synthetic", browser: "synthetic" }),
      "utf8",
    );

    const started = await startDesktopWatch({
      root: directory,
      env: { SQUID_CONFIG: configPath },
      log: () => {},
      logError: () => {},
      createAgentSession: async () => silentAgent(),
    });

    if ("configError" in started) {
      throw new Error(`startup refused: ${started.configError}`);
    }
    try {
      expect(started.session.banner.reader).toBe("synthetic");
      expect(started.session.banner.browser).toBe("synthetic");
      expect(started.session.banner.terminal).toBe("off");
      expect(started.session.banner.editorSaves).toBe("off");
    } finally {
      await started.session.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
