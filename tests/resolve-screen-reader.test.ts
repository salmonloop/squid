import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveScreenReader } from "../src/resolve-screen-reader.js";

/**
 * Backend selection is validated here rather than inside the source, because the
 * adapter must not import a backend. Every failure has to be a startup config
 * error: a run that asked for the real accessibility reader and quietly replayed
 * demo frames instead is indistinguishable from one that works.
 */
describe("resolveScreenReader", () => {
  it("defaults to the synthetic demo reader with no environment set", async () => {
    const resolved = await resolveScreenReader({ env: {}, platform: "linux" });
    if ("configError" in resolved) throw new Error(resolved.configError);
    expect(resolved.readerKind).toBe("synthetic");
  });

  it("rejects an unrecognized reader instead of falling back", async () => {
    for (const value of ["Darwin", "macos", "xdotool", ""]) {
      const resolved = await resolveScreenReader({
        env: { SQUID_SCREEN_READER: value },
        platform: "darwin",
      });
      expect("configError" in resolved).toBe(true);
    }
  });

  it("refuses each real backend off its own platform", async () => {
    const cases: ReadonlyArray<readonly [string, NodeJS.Platform, string]> = [
      ["darwin", "linux", "requires macOS"],
      ["linux", "win32", "requires Linux"],
      ["windows", "linux", "requires Windows"],
    ];
    for (const [reader, host, expected] of cases) {
      const resolved = await resolveScreenReader({
        env: { SQUID_SCREEN_READER: reader },
        platform: host,
      });
      expect("configError" in resolved && resolved.configError).toContain(expected);
    }
  });

  /**
   * Only the refusal path is exercised off macOS. `createMacosScreenTextReader`
   * carries its own `process.platform` assertion and throws when constructed on
   * another host, so the accept path cannot be faked by injecting `platform` —
   * and faking it would test a factory this machine can never run. The darwin
   * backend is verified by hand with `SQUID_SCREEN_READER=darwin`, the same
   * posture the README states for the accessibility reader.
   */
  it.skipIf(process.platform !== "darwin")("accepts the darwin backend on macOS", async () => {
    const resolved = await resolveScreenReader({
      env: { SQUID_SCREEN_READER: "darwin" },
      platform: "darwin",
    });
    if ("configError" in resolved) throw new Error(resolved.configError);
    expect(resolved.readerKind).toBe("darwin");
  });

  it.skipIf(process.platform !== "linux")("accepts the linux backend on Linux", async () => {
    const resolved = await resolveScreenReader({
      env: { SQUID_SCREEN_READER: "linux" },
      platform: "linux",
    });
    if ("configError" in resolved) throw new Error(resolved.configError);
    expect(resolved.readerKind).toBe("linux");
  });

  it("rejects a poll interval that is not a positive integer", async () => {
    for (const value of ["0", "-1", "1.5", "abc", ""]) {
      const resolved = await resolveScreenReader({
        env: { SQUID_SCREEN_POLL_MS: value },
        platform: "linux",
      });
      expect("configError" in resolved).toBe(true);
    }
  });

  it("rejects a bad poll interval before choosing a backend", async () => {
    // Ordering matters: an invalid interval must be reported as itself, not
    // masked by a platform refusal that happens to come from the same call.
    const resolved = await resolveScreenReader({
      env: { SQUID_SCREEN_READER: "darwin", SQUID_SCREEN_POLL_MS: "0" },
      platform: "darwin",
    });
    expect("configError" in resolved && resolved.configError).toContain("SQUID_SCREEN_POLL_MS");
  });

  it("accepts a valid poll interval for the synthetic backend", async () => {
    const resolved = await resolveScreenReader({
      env: { SQUID_SCREEN_POLL_MS: "500" },
      platform: "linux",
    });
    expect("configError" in resolved).toBe(false);
  });

  it("reads a scripted frame file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "squid-frames-"));
    const path = join(directory, "frames.json");
    await writeFile(path, JSON.stringify([{ applicationId: "vscode" }]), "utf8");

    const resolved = await resolveScreenReader({ framesPath: path, env: {}, platform: "linux" });
    if ("configError" in resolved) throw new Error(resolved.configError);
    expect(resolved.readerKind).toBe("synthetic");
  });

  it("reports an unreadable or non-array frame file as a config error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "squid-frames-"));
    const missing = await resolveScreenReader({
      framesPath: join(directory, "absent.json"),
      env: {},
      platform: "linux",
    });
    expect("configError" in missing && missing.configError).toContain("Could not read frames");

    const notArray = join(directory, "object.json");
    await writeFile(notArray, JSON.stringify({ applicationId: "vscode" }), "utf8");
    const wrongShape = await resolveScreenReader({
      framesPath: notArray,
      env: {},
      platform: "linux",
    });
    expect("configError" in wrongShape && wrongShape.configError).toContain("JSON array");
  });

  it.skipIf(process.platform !== "darwin")(
    "ignores a frames file when the darwin backend is selected",
    async () => {
      // The real reader samples the live desktop, so a scripted file is not
      // merely unused — reading it would suggest the frames influence a run.
      const resolved = await resolveScreenReader({
        framesPath: "/definitely/absent/frames.json",
        env: { SQUID_SCREEN_READER: "darwin" },
        platform: "darwin",
      });
      expect("configError" in resolved).toBe(false);
    },
  );
});
