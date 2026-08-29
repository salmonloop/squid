import {
  parseIdentityFrame,
  pollingScreenTextReaderFactory,
} from "./screen-text-reader-subprocess.js";
import type { ScreenTextReaderFactory } from "./screen-text-source.js";

const DEFAULT_POLL_MS = 1_000;

/**
 * Queries the foreground window through the Win32 API via PowerShell, emitting
 * three separator-joined fields: process id, process name, window title.
 *
 * This reaches UI Automation's lowest common denominator — `GetForegroundWindow`
 * and friends — rather than the full UIA tree. The identity record is all it
 * can honestly produce: window-level queries expose no focused-element role and
 * no selection text, so those fields stay absent and the protocol's neutral
 * values stand in. Reading focus and text on Windows is full UIA work, and is a
 * different backend, not a richer script. No native Node dependency is taken:
 * PowerShell is on every Windows host, and the P/Invoke declarations are data,
 * not build inputs.
 */
const FOREGROUND_SCRIPT = `
$ErrorActionPreference = 'Stop'
$definition = @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint processId);
'@
Add-Type -MemberDefinition $definition -Name ForegroundWindow -Namespace SquidNative | Out-Null
$hwnd = [SquidNative.ForegroundWindow]::GetForegroundWindow()
# A secure desktop (lock screen, UAC prompt) returns a null handle: emit an
# empty record rather than a bogus pid-0 identity, so the parser reads quiet.
if ($hwnd -eq [System.IntPtr]::Zero) { Write-Output ''; exit 0 }
$builder = New-Object System.Text.StringBuilder 1024
[void][SquidNative.ForegroundWindow]::GetWindowText($hwnd, $builder, $builder.Capacity)
$procId = [uint32]0
[void][SquidNative.ForegroundWindow]::GetWindowThreadProcessId($hwnd, [ref]$procId)
$processName = ''
try { $processName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
$separator = [string][char]31
Write-Output ($procId.ToString() + $separator + $processName + $separator + $builder.ToString())
`;

export interface WindowsScreenTextReaderOptions {
  /** Poll interval. Default 1000ms. */
  readonly pollMs?: number;
}

/**
 * A `ScreenTextReaderFactory` backed by PowerShell on Windows.
 *
 * Throws immediately off Windows rather than degrading, because a caller that
 * reached this function on another platform chose the wrong backend and silence
 * would hide that. Like the macOS reader, this file needs a real host to be
 * verified end to end — CI exercises the seam and the parser, and the backend
 * itself is verified by hand with `SQUID_SCREEN_READER=windows` on Windows.
 */
export function createWindowsScreenTextReader(
  options: WindowsScreenTextReaderOptions = {},
): ScreenTextReaderFactory {
  if (process.platform !== "win32") {
    throw new Error(
      `The Windows screen text reader requires win32; this process reports ${process.platform}.`,
    );
  }

  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  return pollingScreenTextReaderFactory({
    program: "powershell",
    pollMs,
    parse: parseIdentityFrame,
    run: async (onSpawned) => {
      const child = Bun.spawn(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", FOREGROUND_SCRIPT],
        { stdout: "pipe", stderr: "pipe" },
      );
      onSpawned(child);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, exitCode };
    },
  });
}
