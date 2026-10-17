/**
 * Cross-platform desktop text typing service.
 *
 * Types text into the active focused field on behalf of the user when an
 * action confirmation is approved.
 *
 * Handles target window focus restoration (since clicking "Allow" on the Slint
 * panel window moves window manager focus to the panel), argument escaping,
 * and fail-closed error handling.
 */

import { windowsPowerShellPath } from "./windows-powershell.js";

export interface TextTypingTarget {
  readonly text: string;
  readonly targetWindowId?: string;
  readonly targetWindowTitle?: string;
  readonly targetApplicationId?: string;
}

export interface TextTypingResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface SubprocessExecutionResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export type SubprocessRunner = (
  command: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<SubprocessExecutionResult>;

export interface TextTypingServiceOptions {
  readonly platform?: NodeJS.Platform;
  readonly runner?: SubprocessRunner;
  readonly timeoutMs?: number;
  readonly settleDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly env?: Record<string, string | undefined>;
}

async function defaultSubprocessRunner(
  command: readonly string[],
  options?: { timeoutMs?: number },
): Promise<SubprocessExecutionResult> {
  const proc = Bun.spawn(command as string[], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let killed = false;
  const timer = options?.timeoutMs
    ? setTimeout(() => {
        killed = true;
        try {
          proc.kill();
        } catch {
          // ignore process kill failure
        }
      }, options.timeoutMs)
    : undefined;

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (killed) {
      return { exitCode: 124, stderr: `Subprocess timed out after ${options?.timeoutMs}ms.` };
    }
    return { exitCode, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Escapes characters that have special syntactic meaning in Windows Forms SendKeys:
 * +, ^, %, ~, (, ), [, ], {, }, and converts newlines to {ENTER}.
 * Each special character is enclosed in braces (e.g. `+` -> `{+}`).
 */
export function escapeSendKeys(text: string): string {
  return text
    .replace(/[{}+^%~()[\]]/g, (match) => `{${match}}`)
    .replace(/\r?\n/g, "{ENTER}");
}

export class TextTypingService {
  private readonly platform: NodeJS.Platform;
  private readonly runner: SubprocessRunner;
  private readonly timeoutMs: number;
  private readonly settleDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly env: Record<string, string | undefined>;

  constructor(options: TextTypingServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? defaultSubprocessRunner;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.settleDelayMs = options.settleDelayMs ?? 60;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.env = options.env ?? process.env;
  }

  /**
   * Types the specified text into the focused target input.
   */
  async typeText(target: TextTypingTarget): Promise<TextTypingResult> {
    const { text, targetWindowId, targetWindowTitle, targetApplicationId } = target;
    if (text.length === 0) {
      return { ok: true };
    }

    try {
      if (this.platform === "linux") {
        return await this.typeLinux(text, targetWindowId, targetWindowTitle);
      }
      if (this.platform === "darwin") {
        return await this.typeDarwin(text, targetApplicationId);
      }
      if (this.platform === "win32") {
        return await this.typeWindows(text, targetWindowTitle);
      }
      return {
        ok: false,
        error: `Unsupported platform for desktop typing: ${this.platform}`,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Typing injection error: ${errorMsg}` };
    }
  }

  private async typeLinux(
    text: string,
    targetWindowId?: string,
    targetWindowTitle?: string,
  ): Promise<TextTypingResult> {
    // 1. If target window ID or title is provided, reactivate the target window
    // so keystrokes go to the application rather than the Slint confirmation card.
    if (targetWindowId !== undefined && targetWindowId !== "") {
      const activateResult = await this.runner(
        ["xdotool", "windowactivate", "--sync", targetWindowId],
        { timeoutMs: this.timeoutMs },
      );
      if (activateResult.exitCode !== 0) {
        return {
          ok: false,
          error: activateResult.stderr?.trim() || `Failed to activate window ID ${targetWindowId}`,
        };
      }
      if (this.settleDelayMs > 0) {
        await this.sleep(this.settleDelayMs);
      }
    } else if (targetWindowTitle !== undefined && targetWindowTitle.trim() !== "") {
      const searchResult = await this.runner(
        ["xdotool", "search", "--name", "--onlyvisible", targetWindowTitle.trim(), "windowactivate", "--sync"],
        { timeoutMs: this.timeoutMs },
      );
      if (searchResult.exitCode !== 0) {
        return {
          ok: false,
          error: searchResult.stderr?.trim() || `Failed to activate window with title "${targetWindowTitle}"`,
        };
      }
      if (this.settleDelayMs > 0) {
        await this.sleep(this.settleDelayMs);
      }
    }

    // 2. Type text using xdotool. Use "--" to prevent interpreting leading hyphens as flags.
    const result = await this.runner(
      ["xdotool", "type", "--delay", "12", "--clearmodifiers", "--", text],
      { timeoutMs: this.timeoutMs },
    );

    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: result.stderr?.trim() || `xdotool failed with exit code ${result.exitCode}`,
      };
    }
    return { ok: true };
  }

  private async typeDarwin(
    text: string,
    targetApplicationId?: string,
  ): Promise<TextTypingResult> {
    // Pass text and targetApplicationId as argv parameters to osascript to prevent script injection.
    const script = `on run argv
  set txt to item 1 of argv
  if (count of argv) > 1 then
    set appName to item 2 of argv
    if appName is not "" then
      try
        tell application appName to activate
      end try
      delay 0.05
    end if
  end if
  tell application "System Events"
    keystroke txt
  end tell
end run`;

    const args = ["osascript", "-e", script, "--", text];
    if (targetApplicationId !== undefined && targetApplicationId !== "") {
      args.push(targetApplicationId);
    }

    const result = await this.runner(args, { timeoutMs: this.timeoutMs });

    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: result.stderr?.trim() || `osascript failed with exit code ${result.exitCode}`,
      };
    }
    return { ok: true };
  }

  private async typeWindows(
    text: string,
    targetWindowTitle?: string,
  ): Promise<TextTypingResult> {
    const pwshPath = windowsPowerShellPath(this.env);
    const escapedText = escapeSendKeys(text).replace(/'/g, "''");
    const escapedTitle = targetWindowTitle ? targetWindowTitle.replace(/'/g, "''") : "";

    const command = [
      pwshPath,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      escapedTitle
        ? `$wshell = New-Object -ComObject WScript.Shell; if (-not $wshell.AppActivate('${escapedTitle}')) { exit 1 }; Start-Sleep -Milliseconds 60; [System.Windows.Forms.SendKeys]::SendWait('${escapedText}')`
        : `[System.Windows.Forms.SendKeys]::SendWait('${escapedText}')`,
    ];

    const result = await this.runner(command, { timeoutMs: this.timeoutMs });

    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: result.stderr?.trim() || `PowerShell typing failed with exit code ${result.exitCode}`,
      };
    }
    return { ok: true };
  }
}
