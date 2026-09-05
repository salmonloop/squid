import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { FOREGROUND_SCRIPT } from "../src/screen-text-reader-linux.js";
import { parseIdentityFrame } from "../src/screen-text-reader-subprocess.js";

const AT = "2026-09-05T12:00:00.000Z";

/**
 * The X11 backend's script, run by the shell that will actually run it.
 *
 * Not a unit test of a string: `/bin/sh` is `dash` on Debian and Ubuntu, and the
 * bug this file exists for was a `printf` escape `bash` understands and `dash`
 * does not. Asserting on the script's text would have passed against the broken
 * spelling, because the text was exactly what it was meant to be — the shell was
 * the part nobody asked.
 *
 * No X server is needed, and that is the point of stubbing the two commands the
 * script shells out to: what is under test is the script's framing, and `xdotool`
 * answering from a stub is indistinguishable from it answering from a display.
 */
async function runForegroundScript(
  answers: { pid: string; name: string; title: string },
): Promise<{ stdout: string; exitCode: number }> {
  const dir = await mkdtemp(join(tmpdir(), "squid-xdotool-stub-"));
  try {
    await writeFile(join(dir, "xdotool"), [
      "#!/bin/sh",
      "case \"$1\" in",
      "  getactivewindow) echo 0x1400007 ;;",
      `  getwindowpid) printf '%s\\n' '${answers.pid}' ;;`,
      `  getwindowname) printf '%s\\n' '${answers.title}' ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"), "utf8");
    await writeFile(join(dir, "ps"), [
      "#!/bin/sh",
      `printf '%s\\n' '${answers.name}'`,
      "",
    ].join("\n"), "utf8");
    await chmod(join(dir, "xdotool"), 0o755);
    await chmod(join(dir, "ps"), 0o755);

    const child = Bun.spawn(["/bin/sh", "-c", FOREGROUND_SCRIPT], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    return { stdout, exitCode };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== "linux")("the X11 foreground script", () => {
  it("separates its fields with a byte the parser recognizes", async () => {
    const { stdout, exitCode } = await runForegroundScript({
      pid: "4242",
      name: "editor",
      title: "draft.md — Editor",
    });

    expect(exitCode).toBe(0);
    // The whole bug, in one assertion: `dash`'s printf does not implement `\x1f`,
    // so the broken spelling wrote a literal backslash and the parser saw one
    // field. A frame still came out — with the entire record as its application id.
    expect(stdout).not.toContain("\\x1f");
    expect(parseIdentityFrame(stdout, AT)).toEqual({
      applicationId: "4242",
      applicationName: "editor",
      windowTitle: "draft.md — Editor",
      occurredAt: AT,
    });
  });

  it("is quiet rather than wrong when the window has no process", async () => {
    // `xdotool getwindowpid` fails on some override-redirect windows. The record
    // is still written, and a record with no addressable process is a quiet
    // observation — not a frame whose id is an empty string.
    const { stdout } = await runForegroundScript({ pid: "", name: "", title: "" });

    expect(parseIdentityFrame(stdout, AT)).toBeNull();
  });
});
