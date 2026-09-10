import { describe, expect, it } from "bun:test";
import { SourceDiagnosticLog } from "../src/source-diagnostics.js";

describe("SourceDiagnosticLog", () => {
  it("forwards every entry to the live sink as it happens", () => {
    const seen: string[] = [];
    const log = new SourceDiagnosticLog((diagnostic) => seen.push(diagnostic.message));
    log.record("watcher_error", new Error("first"));
    log.record("watcher_error", new Error("second"));
    expect(seen).toEqual(["first", "second"]);
  });

  it("keeps only the newest entries once the ring is full", () => {
    const log = new SourceDiagnosticLog();
    for (let i = 0; i < 30; i++) {
      log.record("probe_error", new Error(`failure ${i}`));
    }
    const kept = log.diagnostics;
    expect(kept).toHaveLength(20);
    expect(kept[0]!.message).toBe("failure 10");
    expect(kept[kept.length - 1]!.message).toBe("failure 29");
  });

  it("still reports every entry to the sink after the ring has wrapped", () => {
    const seen: string[] = [];
    const log = new SourceDiagnosticLog((diagnostic) => seen.push(diagnostic.message));
    for (let i = 0; i < 25; i++) {
      log.record("delivery_error", new Error(`failure ${i}`));
    }
    // The ring bounds what the source remembers, not what it says.
    expect(seen).toHaveLength(25);
    expect(log.diagnostics).toHaveLength(20);
  });

  it("hands out copies, so a reader cannot move the ring", () => {
    const log = new SourceDiagnosticLog();
    log.record("watcher_error", new Error("only"));
    const first = log.diagnostics;
    log.record("watcher_error", new Error("second"));
    expect(first).toHaveLength(1);
    expect(log.diagnostics).toHaveLength(2);
  });
});
