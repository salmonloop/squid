import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasDecisionKey,
  resolveDecisionKey,
  writeDecisionKey,
} from "../src/decision-keystore.js";

/**
 * The decision key never lands in the Squid config file — it lives in its own
 * 0600 file, or comes straight from the env. These tests pin both the
 * resolution order (env wins) and the file's mode, because a credential file
 * that is world-readable is the one regression worth failing loudly on.
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "squid-decision-key-"));
}

describe("resolveDecisionKey", () => {
  it("prefers a non-empty SQUID_DECISION_KEY over the file", () => {
    const dir = tempDir();
    const file = join(dir, "squid-decision.json");
    writeDecisionKey("from-file", file);
    expect(resolveDecisionKey({ env: { SQUID_DECISION_KEY: "from-env" }, file })).toBe("from-env");
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the persisted file when the env is unset or empty", () => {
    const dir = tempDir();
    const file = join(dir, "squid-decision.json");
    writeDecisionKey("from-file", file);
    expect(resolveDecisionKey({ env: {}, file })).toBe("from-file");
    // An empty env var is not a key — it must not shadow the stored one, or a
    // shell that exported `SQUID_DECISION_KEY=` would silently disable the key.
    expect(resolveDecisionKey({ env: { SQUID_DECISION_KEY: "" }, file })).toBe("from-file");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined when nothing is set anywhere", () => {
    const dir = tempDir();
    const file = join(dir, "squid-decision.json");
    expect(resolveDecisionKey({ env: {}, file })).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("treats a malformed file as no key rather than throwing", () => {
    const dir = tempDir();
    const file = join(dir, "squid-decision.json");
    writeFileSync(file, "{not json", "utf8");
    expect(resolveDecisionKey({ env: {}, file })).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("writeDecisionKey", () => {
  it("writes the key 0600 and reads back through resolve", () => {
    const dir = tempDir();
    const file = join(dir, "squid-decision.json");
    writeDecisionKey("  sk-decision-123  ", file);
    // Trimmed on write, so a pasted trailing newline is not part of the bearer.
    expect(resolveDecisionKey({ env: {}, file })).toBe("sk-decision-123");
    // 0600: owner-only. A decision credential is no more exposed than Pi's own.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  it("clears the key when given an empty string", () => {
    const dir = tempDir();
    const file = join(dir, "squid-decision.json");
    writeDecisionKey("sk-x", file);
    expect(hasDecisionKey({ env: {}, file })).toBe(true);
    writeDecisionKey("   ", file);
    // A keyless local replica is a supported deployment: clearing must leave a
    // readable "no key", not a broken file.
    expect(hasDecisionKey({ env: {}, file })).toBe(false);
    expect(existsSync(file)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("hasDecisionKey", () => {
  it("answers yes for env, yes for file, no for neither — never the value", () => {
    const dir = tempDir();
    const file = join(dir, "squid-decision.json");
    expect(hasDecisionKey({ env: {}, file })).toBe(false);
    expect(hasDecisionKey({ env: { SQUID_DECISION_KEY: "k" }, file })).toBe(true);
    writeDecisionKey("k2", file);
    expect(hasDecisionKey({ env: {}, file })).toBe(true);
    // Guard against a chmod-less filesystem silently leaving a wider mode: the
    // write still succeeds and the key still reads.
    chmodSync(file, 0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});
