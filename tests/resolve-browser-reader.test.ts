import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBrowserReader } from "../src/resolve-browser-reader.js";

/**
 * Browser observation defaults to off, unlike the screen reader. It is the
 * capability that makes `search_selection` reachable, and search is the one
 * action that sends user text off the machine, so a run gets it by asking.
 */
describe("resolveBrowserReader", () => {
  it("is off when the variable is unset", async () => {
    const resolved = await resolveBrowserReader({ env: {} });
    expect(resolved).toEqual({ enabled: false });
  });

  it("enables the synthetic backend on the exact value", async () => {
    const resolved = await resolveBrowserReader({ env: { SQUID_BROWSER: "synthetic" } });
    if ("configError" in resolved) throw new Error(resolved.configError);
    expect(resolved.readerKind).toBe("synthetic");
  });

  it("refuses the darwin backend off macOS", async () => {
    // The screen reader's rule applies here too: asking for real observation on
    // a host that cannot provide it must fail startup, because a run that got
    // quiet nothing would look identical to one that works.
    for (const platform of ["linux", "win32"] as const) {
      const resolved = await resolveBrowserReader({
        env: { SQUID_BROWSER: "darwin" },
        platform,
      });
      expect("configError" in resolved && resolved.configError).toContain("requires macOS");
    }
  });

  /**
   * Only the refusal path is exercised off macOS. `createMacosBrowserPageReader`
   * carries its own `process.platform` assertion and throws when constructed on
   * another host, so the accept path cannot be faked by injecting `platform` —
   * and mocking the module would test a factory this machine can never run.
   * The darwin backend is verified by hand with `SQUID_BROWSER=darwin`, the
   * same posture the README states for the accessibility screen reader.
   */
  it.skipIf(process.platform !== "darwin")("accepts the darwin backend on macOS", async () => {
    const resolved = await resolveBrowserReader({
      env: { SQUID_BROWSER: "darwin" },
      platform: "darwin",
    });
    if ("configError" in resolved) throw new Error(resolved.configError);
    expect(resolved.readerKind).toBe("darwin");
  });

  it("rejects a bad poll interval before choosing a backend", async () => {
    // Ordering matters: an invalid interval must be reported as itself, not
    // masked by a platform refusal that happens to come from the same call.
    const resolved = await resolveBrowserReader({
      env: { SQUID_BROWSER: "darwin", SQUID_BROWSER_POLL_MS: "0" },
      platform: "darwin",
    });
    expect("configError" in resolved && resolved.configError).toContain("SQUID_BROWSER_POLL_MS");
  });

  it("rejects near-miss values as config errors rather than defaulting", async () => {
    // Same three-outcome rule as SQUID_SEARCH_EGRESS: a typo must fail startup,
    // not silently leave browser observation off and look like a working setup.
    for (const value of ["Synthetic", "SYNTHETIC", "Darwin", "on", "true", "", "synthetic ", "chrome"]) {
      const resolved = await resolveBrowserReader({
        env: { SQUID_BROWSER: value },
        ...(value === "Darwin" ? { platform: "darwin" as const } : {}),
      });
      expect("configError" in resolved).toBe(true);
    }
  });

  it("rejects a poll interval that is not a positive integer", async () => {
    for (const value of ["0", "-1", "1.5", "abc", ""]) {
      const resolved = await resolveBrowserReader({
        env: { SQUID_BROWSER: "synthetic", SQUID_BROWSER_POLL_MS: value },
      });
      expect("configError" in resolved && resolved.configError).toContain("SQUID_BROWSER_POLL_MS");
    }
  });

  it("ignores a poll interval when the browser source is off", async () => {
    // Nothing is being configured, so an unused value is not an error. Reporting
    // one would block a run over a variable that has no effect.
    const resolved = await resolveBrowserReader({ env: { SQUID_BROWSER_POLL_MS: "0" } });
    expect(resolved).toEqual({ enabled: false });
  });

  it("reads a scripted frame file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "squid-pages-"));
    const path = join(directory, "pages.json");
    await writeFile(path, JSON.stringify([{ url: "https://example.com/" }]), "utf8");

    const resolved = await resolveBrowserReader({
      framesPath: path,
      env: { SQUID_BROWSER: "synthetic" },
    });
    expect("configError" in resolved).toBe(false);
  });

  it("reports an unreadable or non-array frame file as a config error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "squid-pages-"));
    const missing = await resolveBrowserReader({
      framesPath: join(directory, "absent.json"),
      env: { SQUID_BROWSER: "synthetic" },
    });
    expect("configError" in missing && missing.configError).toContain("Could not read browser frames");

    const notArray = join(directory, "object.json");
    await writeFile(notArray, JSON.stringify({ url: "https://example.com/" }), "utf8");
    const wrongShape = await resolveBrowserReader({
      framesPath: notArray,
      env: { SQUID_BROWSER: "synthetic" },
    });
    expect("configError" in wrongShape && wrongShape.configError).toContain("JSON array");
  });

  it("does not read a frame file when the browser source is off", async () => {
    // An absent path must not be an error for a run that never asked for browser
    // observation, or supplying frames would become mandatory.
    const resolved = await resolveBrowserReader({
      framesPath: "/definitely/absent/pages.json",
      env: {},
    });
    expect(resolved).toEqual({ enabled: false });
  });
});
