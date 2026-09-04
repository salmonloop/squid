import { commandDesktopNotifierFactory } from "./desktop-notice-command.js";
import type { DesktopNotice, DesktopNotifierFactory } from "./desktop-notice.js";
import { windowsPowerShellPath } from "./windows-powershell.js";

/**
 * Speaking up on Windows, through a `Shell_NotifyIcon` balloon.
 *
 * A modern toast is routed by an AppUserModelID, and for an unpackaged app that
 * AUMID must be carried by a Start Menu shortcut written at install time — which
 * Squid cannot write, because it ships as a zip with no installer. The balloon
 * is the pre-toast mechanism, and it needs no identity: the tray icon itself is
 * the identity, registered for the life of the delivery and removed after. On
 * Windows 10 and later the shell renders the balloon as a toast, which lands in
 * the Action Centre like any other.
 *
 * **The messenger is visible, and that is the honest cost of working without an
 * installer.** The shell attributes the toast to the process that sent it, so it
 * reads "Windows PowerShell" — a transient tray icon also appears while the
 * balloon is up. The title and body are Squid's words; what the attribution line
 * names is the messenger. The routes without that cost all need something Squid
 * does not have: an installer to write a shortcut, or the panel owning the icon,
 * which Slint 1.17 does not expose (`SystemTrayIcon` offers neither a handle nor
 * a balloon API, and 1.18 is touching that area). Whichever arrives first, this
 * file is what gets replaced.
 *
 * **No action buttons, and two independent reasons agree.** The seam forbids
 * them — a notice is not a decision; a consequential answer belongs on the
 * confirmation surface — and this mechanism could not carry them anyway:
 * balloons have no buttons, and toast actions require the WinRT routing this
 * backend deliberately avoids. A form whose value kills the brain empties
 * itself; a notice whose click does nothing would lie the same way.
 *
 * **The code travels by argv and the data travels by stdin.** The script is a
 * constant, so the argument list never quotes anything; the notice arrives as
 * one JSON line on stdin, read back as UTF-8 explicitly — `[Console]::In` would
 * decode with the OEM code page, and an agent reply is not written in the
 * code page of whoever installed Windows. No user text ever reaches the
 * PowerShell parser, which is the injection the design removes rather than
 * escapes.
 */

/**
 * The fixed script one delivery runs.
 *
 * Everything in it is constant. The notice itself is never interpolated here:
 * a title containing a quote, a `$(`, or a backtick would be a script the
 * author of the reply did not write, so it travels on stdin instead.
 *
 * What the script does, in order, and why each step is load-bearing:
 *
 * - **Read the payload before anything else can consume stdin**, and decode it
 *   as UTF-8 explicitly. JSON, because the shape is two strings and the
 *   sanitizer upstream has already stripped control characters — but JSON does
 *   not care whether that ever changes.
 * - **`Add-Type` both assemblies.** `System.Windows.Forms` for the balloon and
 *   `System.Drawing` for the icon; both are .NET Framework assemblies, which is
 *   why this must be Windows PowerShell rather than `pwsh`. The console host
 *   defaults to an STA thread, which Windows Forms wants.
 * - **Register the icon before showing the balloon.** `ShowBalloonTip` is a
 *   modify of an existing registration; with no registered icon it is a no-op
 *   that reports nothing, and a balloon that silently does not appear is worse
 *   than one that errors. The icon is the shell's `SystemIcons` information
 *   glyph — a blank square flashing in the tray is the alternative, and it
 *   reads as a broken program rather than a message.
 * - **`ToolTipIcon.Info`, the `NIIF_INFO` of the raw API.** The timeout passed
 *   to `ShowBalloonTip` is a request the system clamps to its own minimum and
 *   the user's own notification settings override — nothing here pins how long
 *   the popup lasts or how loudly it arrives, the same rule the Linux backend
 *   states about urgency.
 * - **Stay alive past the balloon's floor.** The system enforces a minimum
 *   display of ten seconds, and removing the icon — or exiting — takes the
 *   balloon with it, so a process that exits immediately delivers nothing
 *   visible. Eleven seconds outlives the floor; then the icon is removed and
 *   disposed, because a helper that left a tray icon behind would be a ghost
 *   nobody asked for and only a hover would clear.
 */
export const balloonScript =
  "$ErrorActionPreference = 'Stop'; " +
  "$ms = New-Object System.IO.MemoryStream; " +
  "[Console]::OpenStandardInput().CopyTo($ms); " +
  "$notice = [System.Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json; " +
  "Add-Type -AssemblyName System.Windows.Forms; " +
  "Add-Type -AssemblyName System.Drawing; " +
  "$icon = New-Object System.Windows.Forms.NotifyIcon; " +
  "$icon.Icon = [System.Drawing.SystemIcons]::Information; " +
  "$icon.Visible = $true; " +
  "$icon.ShowBalloonTip(10000, $notice.title, $notice.body, [System.Windows.Forms.ToolTipIcon]::Info); " +
  "Start-Sleep -Seconds 11; " +
  "$icon.Visible = $false; " +
  "$icon.Dispose();";

/** The interpreter's own flags, before the script. */
export const balloonArguments = ["-NoProfile", "-NonInteractive", "-Command"] as const;

/**
 * The one JSON line written to the script's stdin.
 *
 * Separate and exported because it is the part worth asserting: no host is
 * needed to check that a title full of quotes arrives as data, not as script.
 */
export function noticePayload(notice: DesktopNotice): string {
  return JSON.stringify({ title: notice.title, body: notice.body });
}

/**
 * How long one delivery may take before it is killed and reported.
 *
 * The Linux default of five seconds bounds handing two strings to a daemon that
 * is already running. This helper *is* the work: process startup alone is a
 * measured 700–1100ms, loading the two WinForms assemblies costs a few hundred
 * more, and the balloon's own floor is ten seconds the script must outlive.
 * Eleven seconds of residency plus roughly two of startup is what a *healthy*
 * delivery costs, so the deadline sits just above it — still far short of a
 * hung shell, which is the case a deadline exists to catch.
 */
const DELIVERY_DEADLINE_MS = 15_000;

export interface WindowsDesktopNotifierOptions {
  readonly platform?: NodeJS.Platform;
  /** Overridden in tests; the mechanism's own default is right in production. */
  readonly timeoutMs?: number;
}

export function createWindowsDesktopNotifier(
  options: WindowsDesktopNotifierOptions = {},
): DesktopNotifierFactory {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error(
      `The Windows desktop notifier requires win32; this process reports ${platform}.`,
    );
  }

  return commandDesktopNotifierFactory({
    program: "powershell",
    ...(options.timeoutMs === undefined
      ? { timeoutMs: DELIVERY_DEADLINE_MS }
      : { timeoutMs: options.timeoutMs }),
    send: async (notice, onSpawned) => {
      const child = Bun.spawn(
        [windowsPowerShellPath(), ...balloonArguments, balloonScript],
        {
          stdin: "pipe",
          // Nothing is read from stdout, and a pipe nobody reads is a buffer
          // that can fill — the same rule the Linux backend states.
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      onSpawned(child);
      // The payload is smaller than any pipe buffer, so one write and end is
      // the whole conversation; the script reads to end-of-file, which closing
      // stdin provides.
      child.stdin.write(noticePayload(notice));
      child.stdin.end();
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stderr, exitCode };
    },
  });
}
