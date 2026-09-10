import { describe, expect, it } from "bun:test";
import {
  createMacosDesktopNotifier,
  noticeArgumentList,
  noticeScript,
} from "../src/desktop-notice-macos.js";

/**
 * The argument list, which is the whole platform-specific part of speaking up
 * on macOS. No host is needed to check it, and none should be: a suite that
 * spawned `osascript` would pass or fail on whether the machine running it was
 * a Mac, and the payload's safety is a property of the list, not of the host
 * that eventually reads it.
 */
describe("noticeArgumentList", () => {
  it("passes the script once and the notice as data after the terminator", () => {
    const args = noticeArgumentList({ title: "Squid replied", body: "the tests pass" });
    expect(args).toEqual([
      "osascript",
      "-e",
      noticeScript,
      "--",
      "Squid replied",
      "the tests pass",
    ]);
  });

  /**
   * The regression the `--` exists for, and the same one the Linux backend
   * measured: osascript uses getopt, so a title beginning with a dash would be
   * read as a flag — and a model summarising its work routinely starts with a
   * dash, because a list is how it writes. The assertion is on the
   * terminator's *position*: one that drifted after the text would parse the
   * text again.
   */
  it("terminates the options before any text, so a leading dash stays text", () => {
    const args = noticeArgumentList({ title: "- ran the tests", body: "-w means nothing here" });
    expect(args.indexOf("--")).toBeLessThan(args.indexOf("- ran the tests"));
    expect(args.indexOf("--")).toBeLessThan(args.indexOf("-w means nothing here"));
  });

  /**
   * The script is a constant, and that is the injection boundary: a title full
   * of quotes, backslashes, and AppleScript operators must never reach the
   * AppleScript *parser*, and argv values after `--` never do. The assertion
   * the other way — that the payload does not appear inside the script — is
   * what pins the boundary to the mechanism rather than to the caller's
   * discipline.
   */
  it("keeps user text out of the AppleScript source", () => {
    const hostile = { title: `\" & (do shell script \"rm -rf ~\") & \"`, body: "quote\" back\\slash" };
    const args = noticeArgumentList(hostile);
    const script = args[args.indexOf("--") - 1] ?? "";
    expect(script).toBe(noticeScript);
    expect(script).not.toContain("rm -rf");
    // The hostile text arrives as *data* — present in the list, untouched.
    expect(args).toContain(hostile.title);
    expect(args).toContain(hostile.body);
  });

  /**
   * No `with sound`, no `critical alert`, no subtitle — how loudly a notice
   * arrives and how it behaves in Focus are the user's own settings to make in
   * System Settings, the same rule the Linux backend states about urgency.
   */
  it("claims nothing about sound or how the notice behaves in Focus", () => {
    const script = noticeArgumentList({ title: "t", body: "b" }).join(" ");
    expect(script).not.toContain("sound");
    expect(script).not.toContain("critical");
  });
});

describe("createMacosDesktopNotifier", () => {
  it("refuses to be built off macOS", () => {
    // The same rule every real backend enforces: a factory asked for on the wrong
    // host fails loudly rather than producing something that quietly never works.
    expect(() => createMacosDesktopNotifier({ platform: "linux" })).toThrow(/requires darwin/);
  });
});
