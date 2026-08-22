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
    expect(resolved.enabled).toBe(true);
  });

  it("rejects near-miss values as config errors rather than defaulting", async () => {
    // Same three-outcome rule as SQUID_SEARCH_EGRESS: a typo must fail startup,
    // not silently leave browser observation off and look like a working setup.
    for (const value of ["Synthetic", "SYNTHETIC", "on", "true", "", "synthetic "]) {
      const resolved = await resolveBrowserReader({ env: { SQUID_BROWSER: value } });
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
