import { describe, expect, it } from "bun:test";
import {
  escapeSendKeys,
  TextTypingService,
  type SubprocessExecutionResult,
} from "../src/text-typing-service.js";

describe("escapeSendKeys", () => {
  it("escapes special SendKeys characters in braces", () => {
    expect(escapeSendKeys("hello world")).toBe("hello world");
    expect(escapeSendKeys("a+b")).toBe("a{+}b");
    expect(escapeSendKeys("{test}")).toBe("{{}test{}}");
    expect(escapeSendKeys("func()")).toBe("func{(}{)}");
    expect(escapeSendKeys("arr[0]")).toBe("arr{[}0{]}");
    expect(escapeSendKeys("100% ~home ^key")).toBe("100{%} {~}home {^}key");
  });

  it("converts newlines to {ENTER}", () => {
    expect(escapeSendKeys("line1\nline2")).toBe("line1{ENTER}line2");
    expect(escapeSendKeys("line1\r\nline2")).toBe("line1{ENTER}line2");
  });
});

describe("TextTypingService on Linux", () => {
  it("reactivates target window before typing", async () => {
    const executedCommands: (readonly string[])[] = [];
    const sleptMs: number[] = [];

    const service = new TextTypingService({
      platform: "linux",
      runner: async (cmd): Promise<SubprocessExecutionResult> => {
        executedCommands.push(cmd);
        return { exitCode: 0, stdout: "" };
      },
      sleep: async (ms) => {
        sleptMs.push(ms);
      },
    });

    const result = await service.typeText({
      text: "git status",
      targetWindowId: "0x123456",
    });

    expect(result.ok).toBe(true);
    expect(executedCommands.length).toBe(2);
    expect(executedCommands[0]).toEqual(["xdotool", "windowactivate", "--sync", "0x123456"]);
    expect(sleptMs).toEqual([60]);
    expect(executedCommands[1]).toEqual([
      "xdotool",
      "type",
      "--delay",
      "12",
      "--clearmodifiers",
      "--",
      "git status",
    ]);
  });

  it("fails closed without typing if window activation fails", async () => {
    const executedCommands: (readonly string[])[] = [];

    const service = new TextTypingService({
      platform: "linux",
      runner: async (cmd): Promise<SubprocessExecutionResult> => {
        executedCommands.push(cmd);
        return { exitCode: 1, stderr: "window not found" };
      },
    });

    const result = await service.typeText({
      text: "secret input",
      targetWindowId: "0xdeadbeef",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("window not found");
    // Crucial: keystrokes were NOT typed because window activation failed!
    expect(executedCommands.length).toBe(1);
    expect(executedCommands[0]?.[0]).toBe("xdotool");
    expect(executedCommands[0]?.[1]).toBe("windowactivate");
  });

  it("searches and activates by targetWindowTitle if no windowId is given", async () => {
    const executedCommands: (readonly string[])[] = [];

    const service = new TextTypingService({
      platform: "linux",
      runner: async (cmd): Promise<SubprocessExecutionResult> => {
        executedCommands.push(cmd);
        return { exitCode: 0, stdout: "" };
      },
      sleep: async () => {},
    });

    const result = await service.typeText({
      text: "--all",
      targetWindowTitle: "Terminal - bash",
    });

    expect(result.ok).toBe(true);
    expect(executedCommands[0]).toEqual([
      "xdotool",
      "search",
      "--name",
      "--onlyvisible",
      "Terminal - bash",
      "windowactivate",
      "--sync",
    ]);
    expect(executedCommands[1]).toEqual([
      "xdotool",
      "type",
      "--delay",
      "12",
      "--clearmodifiers",
      "--",
      "--all",
    ]);
  });

  it("types directly when no target window identifier is specified", async () => {
    const executedCommands: (readonly string[])[] = [];

    const service = new TextTypingService({
      platform: "linux",
      runner: async (cmd): Promise<SubprocessExecutionResult> => {
        executedCommands.push(cmd);
        return { exitCode: 0, stdout: "" };
      },
    });

    const result = await service.typeText({
      text: "bun test",
    });

    expect(result.ok).toBe(true);
    expect(executedCommands.length).toBe(1);
    expect(executedCommands[0]).toEqual([
      "xdotool",
      "type",
      "--delay",
      "12",
      "--clearmodifiers",
      "--",
      "bun test",
    ]);
  });

  it("reports failure when xdotool exits with non-zero code", async () => {
    const service = new TextTypingService({
      platform: "linux",
      runner: async (): Promise<SubprocessExecutionResult> => {
        return { exitCode: 1, stderr: "xdotool: command not found" };
      },
    });

    const result = await service.typeText({
      text: "echo test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("xdotool: command not found");
  });
});

describe("TextTypingService on Darwin", () => {
  it("invokes osascript passing text and target app as argv arguments", async () => {
    const executedCommands: (readonly string[])[] = [];

    const service = new TextTypingService({
      platform: "darwin",
      runner: async (cmd): Promise<SubprocessExecutionResult> => {
        executedCommands.push(cmd);
        return { exitCode: 0, stdout: "" };
      },
    });

    const result = await service.typeText({
      text: "hello world",
      targetApplicationId: "com.apple.Terminal",
    });

    expect(result.ok).toBe(true);
    expect(executedCommands.length).toBe(1);
    const cmd = executedCommands[0]!;
    expect(cmd[0]).toBe("osascript");
    expect(cmd[1]).toBe("-e");
    expect(cmd[3]).toBe("--");
    expect(cmd[4]).toBe("hello world");
    expect(cmd[5]).toBe("com.apple.Terminal");
  });
});

describe("TextTypingService on Windows", () => {
  it("invokes PowerShell with SendKeys and escapes quotes properly", async () => {
    const executedCommands: (readonly string[])[] = [];

    const service = new TextTypingService({
      platform: "win32",
      runner: async (cmd): Promise<SubprocessExecutionResult> => {
        executedCommands.push(cmd);
        return { exitCode: 0, stdout: "" };
      },
    });

    const result = await service.typeText({
      text: "don't fail",
      targetWindowTitle: "Bob's Terminal",
    });

    expect(result.ok).toBe(true);
    expect(executedCommands.length).toBe(1);
    const cmd = executedCommands[0]!;
    expect(cmd[0]).toContain("powershell");
    expect(cmd[4]).toContain("AppActivate('Bob''s Terminal')");
    expect(cmd[4]).toContain("[System.Windows.Forms.SendKeys]::SendWait('don''t fail')");
  });
});

describe("TextTypingService general behavior", () => {
  it("returns ok immediately for empty text without invoking subprocess", async () => {
    let invoked = false;
    const service = new TextTypingService({
      runner: async () => {
        invoked = true;
        return { exitCode: 0 };
      },
    });

    const result = await service.typeText({ text: "" });
    expect(result.ok).toBe(true);
    expect(invoked).toBe(false);
  });

  it("handles unsupported platforms cleanly", async () => {
    const service = new TextTypingService({
      platform: "aix" as NodeJS.Platform,
      runner: async () => ({ exitCode: 0 }),
    });

    const result = await service.typeText({ text: "some text" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unsupported platform");
  });
});
