import { describe, expect, it } from "bun:test";
import { createLinuxDesktopNotifier, notifySendArguments } from "../src/desktop-notice-linux.js";

/**
 * The argument list, which is the whole platform-specific part of speaking up on
 * Linux. No host is needed to check it, and none should be: a suite that spawned
 * `notify-send` would pass or fail on whether the machine running it had a
 * notification daemon awake.
 */
describe("notifySendArguments", () => {
  it("names Squid as the app and passes the notice positionally", () => {
    expect(notifySendArguments({ title: "Squid replied", body: "the tests pass" })).toEqual([
      "--app-name=Squid",
      "--",
      "Squid replied",
      "the tests pass",
    ]);
  });

  /**
   * The regression this file exists for.
   *
   * Measured: `notify-send "-weird" "x"` fails with `Error parsing option -r` —
   * the summary was read as the short flags `-w -e -i -r -d`. A model summarising
   * what it did routinely starts with a dash, because a list is how it writes,
   * so without the terminator the notices most worth reading are exactly the ones
   * that would silently fail. The assertion is on the terminator's *position*:
   * one that drifted after the text would parse the text again.
   */
  it("terminates the options before any text, so a leading dash stays text", () => {
    const args = notifySendArguments({ title: "- ran the tests", body: "-w means nothing here" });
    expect(args.indexOf("--")).toBeLessThan(args.indexOf("- ran the tests"));
    expect(args.indexOf("--")).toBeLessThan(args.indexOf("-w means nothing here"));
  });

  /**
   * No `--urgency` and no `--expire-time`, because how long a popup lingers and
   * how loudly it arrives are the user's own notification preferences. A program
   * that pins them has overruled a decision it was never asked to make.
   */
  it("claims nothing about urgency or how long the popup lasts", () => {
    const args = notifySendArguments({ title: "t", body: "b" });
    for (const flag of args) {
      expect(flag).not.toContain("urgency");
      expect(flag).not.toContain("expire-time");
    }
  });

  it("still passes an empty body as a body", () => {
    // `notify-send SUMMARY BODY` is positional, so dropping an empty body would
    // shift nothing here — but a caller reading the array should see the shape it
    // will get, not a conditional one.
    expect(notifySendArguments({ title: "Squid replied", body: "" })).toHaveLength(4);
  });
});

describe("createLinuxDesktopNotifier", () => {
  it("refuses to be built off Linux", () => {
    // The same rule every real backend enforces: a factory asked for on the wrong
    // host fails loudly rather than producing something that quietly never works.
    expect(() => createLinuxDesktopNotifier({ platform: "win32" })).toThrow(/requires linux/);
  });
});
