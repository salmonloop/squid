import { describe, expect, it } from "bun:test";
import {
  balloonArguments,
  balloonScript,
  createWindowsDesktopNotifier,
  noticePayload,
} from "../src/desktop-notice-windows.js";

/**
 * The spawn line and the payload, which are the whole platform-specific part of
 * speaking up on Windows. No host is needed to check them, and none should be:
 * a suite that spawned `powershell.exe` would pass or fail on whether the
 * machine running it was Windows at all — and this one never is.
 */
describe("balloonScript", () => {
  /**
   * The regression this file exists for, in its Windows shape.
   *
   * The Linux file proves a leading dash stays text by asserting on the
   * terminator's position. Here the mechanism is stronger — no user text is
   * ever interpolated into the script at all — so the assertion is that the
   * script is a constant: a title carrying the characters a PowerShell parser
   * acts on must not appear in it, in any disguise. If the text ever moves from
   * stdin into the command line, this is the test that fails first.
   */
  it("is a constant: no part of the notice reaches the script", () => {
    const hostile = { title: "- '; $(calc) `x \"y\"", body: "'; Remove-Item C:\\ -Recurse; '" };
    expect(balloonScript).not.toContain(hostile.title);
    expect(balloonScript).not.toContain(hostile.body);
    for (const fragment of ["$(calc)", "Remove-Item"]) {
      expect(balloonScript).not.toContain(fragment);
    }
  });

  it("reads the notice from stdin and decodes it as UTF-8, not the console code page", () => {
    // `[Console]::In` would decode with the OEM code page of the system locale;
    // an agent reply is not written in the code page of whoever installed
    // Windows. The explicit decode is the fix, so it is asserted rather than
    // left to reading the script.
    expect(balloonScript).toContain("OpenStandardInput");
    expect(balloonScript).toContain("[System.Text.Encoding]::UTF8.GetString");
  });

  it("registers the icon before showing the balloon", () => {
    // `ShowBalloonTip` modifies an existing registration; with none it is a
    // silent no-op, and a balloon that never appears while reporting success is
    // the one failure this backend cannot afford to introduce. The registration
    // must precede the show, and the index asserts the order, not mere presence.
    expect(balloonScript.indexOf("Visible = $true")).toBeLessThan(
      balloonScript.indexOf("ShowBalloonTip"),
    );
  });

  it("stays alive past the balloon's floor, then removes the icon", () => {
    // The system enforces a minimum display of ten seconds, and removing the
    // icon — or exiting — takes the balloon with it. Outliving the floor is what
    // makes the delivery visible; disposing afterwards is what keeps a helper
    // from leaving a tray icon behind.
    expect(balloonScript).toContain("Start-Sleep -Seconds 11");
    expect(balloonScript.indexOf("Start-Sleep")).toBeLessThan(balloonScript.indexOf("Dispose"));
    expect(balloonScript).toContain("Dispose");
  });

  it("uses the info glyph and pins nothing about how long or how loudly it shows", () => {
    // `ToolTipIcon.Info` is the `NIIF_INFO` of the raw API. The timeout argument
    // is a request the system clamps and the user's notification settings
    // override, the same rule the Linux backend states about urgency: a program
    // that pins them has decided something it was not asked to decide.
    expect(balloonScript).toContain("[System.Windows.Forms.ToolTipIcon]::Info");
    expect(balloonScript).not.toContain("NeverExpire");
    expect(balloonScript).not.toContain("Realtime");
  });
});

describe("balloonArguments", () => {
  it("starts no profile and never prompts", () => {
    // `-NoProfile`, because a user profile can print, delay, or error — and the
    // delivery's stderr is a diagnostic stream, not a place to collect someone's
    // profile output. `-NonInteractive`, because a prompt on a helper nobody is
    // watching is a hang with a deadline around it.
    expect(balloonArguments).toContain("-NoProfile");
    expect(balloonArguments).toContain("-NonInteractive");
  });

  it("claims no execution policy, because none governs a -Command", () => {
    // Execution policy governs script *files*; a `-Command` string is not
    // subject to it. Passing `-ExecutionPolicy Bypass` here would claim a guard
    // the mechanism never consults — a flag that does nothing is documentation
    // that lies.
    expect(balloonArguments).not.toContain("-ExecutionPolicy");
  });
});

describe("noticePayload", () => {
  it("carries a hostile notice as data and back", () => {
    // The text the sanitizer hands over can start with a dash and carry any
    // quoting — a model summarising its work routinely writes all three. The
    // payload's only job is to survive the trip to `$notice.title` unchanged,
    // so the assertion is the round trip, not the encoding.
    const notice = { title: "- ran the tests", body: "'; $(calc) `x \"y\" — 中文" };
    const payload = noticePayload(notice);
    expect(payload).not.toContain("\n");
    const parsed = JSON.parse(payload) as typeof notice;
    expect(parsed).toEqual(notice);
  });

  it("passes an empty body as a body", () => {
    const parsed = JSON.parse(noticePayload({ title: "Squid replied", body: "" })) as {
      title: string;
      body: string;
    };
    expect(parsed.body).toBe("");
  });
});

describe("createWindowsDesktopNotifier", () => {
  it("refuses to be built off Windows", () => {
    // The same rule every real backend enforces: a factory asked for on the
    // wrong host fails loudly rather than producing something that quietly
    // never works.
    expect(() => createWindowsDesktopNotifier({ platform: "linux" })).toThrow(/requires win32/);
  });
});
