import { describe, expect, it } from "bun:test";
import { resolveEditorSaveReader } from "../src/resolve-editor-save-reader.js";

describe("resolveEditorSaveReader", () => {
  it("is off when the variable is unset", () => {
    expect(resolveEditorSaveReader({ env: {} })).toEqual({ enabled: false });
    // Off means off: an unrelated variable must not enable anything either.
    expect(resolveEditorSaveReader({ env: { SQUID_EDITOR_FIFO: "/tmp/f" } })).toEqual({
      enabled: false,
    });
  });

  it("enables the fifo backend on the exact value", () => {
    const resolved = resolveEditorSaveReader({
      env: { SQUID_EDITOR_SAVES: "fifo", SQUID_EDITOR_FIFO: "/tmp/saves.fifo" },
    });
    expect(resolved).toMatchObject({ enabled: true, readerKind: "fifo" });
  });

  it("rejects a near-miss value as a config error rather than defaulting", () => {
    // The three-outcome rule: unset, exact value, or error. "true" would look
    // like success while silently reading nothing.
    const resolved = resolveEditorSaveReader({ env: { SQUID_EDITOR_SAVES: "true" } });
    expect("configError" in resolved && resolved.configError).toContain(
      'SQUID_EDITOR_SAVES must be unset (off) or exactly "fifo"',
    );
  });

  it("requires an absolute fifo path", () => {
    for (const path of [undefined, "", "relative/fifo"]) {
      const resolved = resolveEditorSaveReader({
        env: { SQUID_EDITOR_SAVES: "fifo", ...(path === undefined ? {} : { SQUID_EDITOR_FIFO: path }) },
      });
      expect("configError" in resolved).toBe(true);
    }
  });

  it("rejects a poll interval that is not a positive integer", () => {
    for (const poll of ["0", "-5", "1.5", "abc"]) {
      const resolved = resolveEditorSaveReader({
        env: {
          SQUID_EDITOR_SAVES: "fifo",
          SQUID_EDITOR_FIFO: "/tmp/saves.fifo",
          SQUID_EDITOR_POLL_MS: poll,
        },
      });
      expect("configError" in resolved).toBe(true);
    }
  });

  it("ignores a poll interval when the source is off", () => {
    const resolved = resolveEditorSaveReader({ env: { SQUID_EDITOR_POLL_MS: "bogus" } });
    expect(resolved).toEqual({ enabled: false });
  });
});
