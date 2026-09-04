import { describe, expect, it } from "bun:test";
import { windowsPowerShellPath } from "../src/windows-powershell.js";

/**
 * The one answer every PowerShell spawn in this repository must agree on.
 *
 * Unlike a joined path, this is deliberately the *same Windows-shaped string on
 * every host*, which is the whole reason it is built from literal separators
 * rather than `node:path`. So the full literal is exactly what to assert here —
 * the host-dialect rule (assert basename, not the joined whole) applies to paths
 * whose shape varies by host, and this one's contract is that its shape does not.
 */
describe("windowsPowerShellPath", () => {
  it("names the fixed location under the SystemRoot the environment declares", () => {
    expect(windowsPowerShellPath({ SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("answers the broken-environment case with the overwhelmingly common root", () => {
    // A Windows host with no SystemRoot is not an unusual configuration to
    // accommodate, it is a broken environment — but guessing the fixed location
    // gives the spawn a chance of working instead of a certainty of not.
    expect(windowsPowerShellPath({})).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("reads the upper-case spelling a built env may carry, and prefers the canonical one", () => {
    // A Windows environment block is case-insensitive while the object
    // modelling it here is not; a caller building env from a config file may
    // well have written SYSTEMROOT. Between both spellings the canonical
    // capitalisation wins, matching what Windows itself sets.
    expect(windowsPowerShellPath({ SYSTEMROOT: "E:\\Win" })).toBe(
      "E:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(windowsPowerShellPath({ SystemRoot: "D:\\Win", SYSTEMROOT: "E:\\Win" })).toBe(
      "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });
});
