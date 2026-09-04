import {
  FIELD_SEPARATOR,
  streamingScreenTextReaderFactory,
  type StreamingChild,
} from "./screen-text-reader-subprocess.js";
import type { ScreenTextFocusRole, ScreenTextFrame, ScreenTextReaderFactory } from "./screen-text-source.js";
import { windowsPowerShellPath } from "./windows-powershell.js";

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_RESTART_MS = 2_000;

/**
 * A selection long enough to matter is long enough to hurt: an accidental
 * select-all in an editor would otherwise be persisted verbatim. Same cap and
 * same reasoning as the macOS reader — the heuristics that read selections need
 * the head, not the document.
 */
const MAX_SELECTION_LENGTH = 4_096;

/** The six fields one record carries, in the order the script writes them. */
const FIELD_COUNT = 6;

/**
 * Reads the focused element through Windows UI Automation, in a process that
 * stays alive.
 *
 * This backend used to spawn one PowerShell per sample and ask three Win32
 * functions for the foreground window's process and title — no focused element,
 * no selection, because a full UIA query per spawn was not affordable. The
 * arithmetic is why: measured on a Windows 11 host, starting PowerShell costs
 * most of a second and loading the UIA client assemblies costs a few hundred
 * milliseconds more, while the automation query itself costs about forty. Paid
 * once per sample at a one-second interval, the reader would never be idle and
 * would still only know the window title.
 *
 * So the interval lives inside the child. It loads the client once, then prints
 * one record per line for as long as it runs, and this file's job is a script and
 * a parser rather than a loop — `streamingScreenTextReaderFactory` owns the child.
 *
 * What it can honestly report is now most of the frame: the focused element's
 * control type and name, and its selected text where the element supports a text
 * pattern. `AutomationElement.FocusedElement` is a static property, which is also
 * what let the P/Invoke go: no `GetForegroundWindow`, so no `Add-Type
 * -MemberDefinition` and no C# compile on startup.
 *
 * Selection is the one field whose yield depends on the application rather than on
 * this file. UIA's text pattern is optional, and implementations differ in how much
 * of it they honour: a native edit control answers fully, while Chromium exposes
 * the pattern on its document and ignores a programmatic selection — measured, not
 * assumed. So an absent `textContext` means "nothing selected, or nothing this
 * application will tell us", and the frame says so by omitting it rather than by
 * reporting an empty selection.
 */
export interface WindowsScreenTextReaderOptions {
  /** Sample interval inside the child. Default 1000ms. */
  readonly pollMs?: number;
  /** How long to wait before restarting a child that exited. Default 2000ms. */
  readonly restartMs?: number;
  /** The host to judge against. Defaults to this process; see the macOS reader. */
  readonly platform?: NodeJS.Platform;
  /** Injected in tests so no suite starts a real interpreter. */
  readonly spawn?: () => StreamingChild;
}

/**
 * The sampling loop, in PowerShell.
 *
 * Every field is squeezed onto one line before it is written, because the framing
 * is newline-delimited and a selection is the one field that routinely contains
 * newlines — a multi-line selection written verbatim would arrive as several
 * records, each a fragment of a sample nobody took. Carriage returns and line
 * feeds become spaces via `Replace` on character codes rather than a regex, so
 * this script carries no backslash escapes for the TypeScript template literal
 * around it to swallow.
 *
 * Nothing here throws upward. A focused element can vanish between the property
 * read and the pattern query, a process can exit before `Get-Process` sees its
 * id, and the lock screen answers nothing at all — each of those is a sample not
 * taken, and the loop's next tick is the recovery. A script that died on the
 * first of them would take the capability down with it.
 */
function samplingScript(pollMs: number, maxSelection: number): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null
$separator = [string][char]31
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$root = [System.Windows.Automation.AutomationElement]::RootElement

function Flatten([string] $value) {
  if ($null -eq $value) { return '' }
  return $value.Replace([char]13, ' ').Replace([char]10, ' ')
}

while ($true) {
  try {
    $element = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -ne $element) {
      $current = $element.Current

      # The top-level window, walked rather than asked for: an element's own Name
      # is the control's label, and the window's is one ancestor hop away at
      # least. The walk stops below the desktop, whose Name is not a window title.
      $top = $element
      while ($true) {
        $parent = $walker.GetParent($top)
        if ($null -eq $parent -or $parent -eq $root) { break }
        $top = $parent
      }

      $processName = ''
      try { $processName = (Get-Process -Id $current.ProcessId).ProcessName } catch {}

      $selection = ''
      try {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
        if ($null -ne $pattern) {
          foreach ($range in $pattern.GetSelection()) {
            $selection += $range.GetText(${maxSelection})
          }
        }
      } catch {}

      $fields = @(
        (Flatten $processName),
        ([string]$current.ProcessId),
        (Flatten $top.Current.Name),
        (Flatten $current.ControlType.ProgrammaticName),
        (Flatten $current.Name),
        (Flatten $selection)
      )
      Write-Output ($fields -join $separator)
    }
  } catch {}
  Start-Sleep -Milliseconds ${pollMs}
}
`;
}

/**
 * Maps a UIA control type onto the protocol's role union.
 *
 * `Document` is deliberately not `editor`, and that is the interesting one. UIA
 * gives a browser's rendered page and a word processor's canvas the same control
 * type, so the name says "a body of text" and nothing about whether the user can
 * type into it. Calling a read-only web page an editor would be a claim this
 * reader cannot support, and `unknown` is what it actually knows — the same
 * restraint the macOS reader shows by never synthesizing `editor` from an
 * `AXTextArea`.
 *
 * `ProgrammaticName` rather than the enum, because that is what crosses the wire
 * from the script: a stable string like `ControlType.Edit`, matched on its tail so
 * a future UIA that changes the prefix does not silently turn every role into
 * `unknown`.
 */
export function mapWindowsRole(programmaticName: string): ScreenTextFocusRole {
  const name = programmaticName.split(".").pop() ?? "";
  switch (name) {
    case "Edit":
      return "text_input";
    case "Button":
    case "SplitButton":
      return "button";
    case "Hyperlink":
      return "link";
    default:
      return "unknown";
  }
}

/**
 * Parses one record: process name, process id, window title, control type,
 * element name, selection.
 *
 * The id is the process id, as this backend has always reported it — a Windows
 * process has no bundle identifier for the macOS reader's sense of the field, and
 * changing what `applicationId` means here would move the projection's idea of
 * "the same application" without saying so.
 *
 * The selection is the tail rather than one field, so a selection containing the
 * separator survives intact instead of costing the whole sample. A record with no
 * process id describes nothing addressable — a secure desktop answers exactly that
 * — and is a quiet observation rather than an error.
 */
export function parseWindowsFocusFrame(line: string, occurredAt: string): ScreenTextFrame | null {
  const parts = line.split(FIELD_SEPARATOR);

  const applicationName = parts[0] ?? "";
  const applicationId = parts[1] ?? "";
  if (applicationId.length === 0) return null;

  const windowTitle = parts[2] ?? "";
  const controlType = parts[3] ?? "";
  const label = parts[4] ?? "";
  const selection = parts
    .slice(FIELD_COUNT - 1)
    .join(FIELD_SEPARATOR)
    .slice(0, MAX_SELECTION_LENGTH);

  return {
    applicationId,
    occurredAt,
    ...(applicationName.length > 0 ? { applicationName } : {}),
    ...(windowTitle.length > 0 ? { windowTitle } : {}),
    ...(controlType.length > 0 ? { focusedRole: mapWindowsRole(controlType) } : {}),
    // Present-but-empty is a real reading here: an element that exposes no name is
    // not the same as a backend that cannot read names, and `projectFrame` tells
    // those apart. Only a record with no control type at all omits the pair.
    ...(controlType.length > 0 ? { focusedLabel: label.length > 0 ? label : null } : {}),
    // Honest scope, matching macOS: UIA exposes a caret through the same text
    // pattern, but nothing here reads it, so prefix and suffix stay empty and the
    // field is present only to say that something is selected — which is what the
    // selection heuristics actually ask.
    ...(selection.length > 0
      ? { textContext: { prefix: "", suffix: "", selection, language: null } }
      : {}),
  };
}

/** Adapts one `Bun.spawn` child to the streaming loop's view of it. */
function spawnSampler(script: string): StreamingChild {
  const child = Bun.spawn([windowsPowerShellPath(), "-NoProfile", "-NonInteractive", "-Command", script], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  // Each stream is drained by exactly one reader, started when a handler is
  // attached. Draining is not optional: an unread pipe fills, and a child blocked
  // writing a record is a reader that reports nothing while looking alive.
  const pump = (stream: ReadableStream<Uint8Array>, handler: (chunk: string) => void): void => {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) handler(decoder.decode(chunk, { stream: true }));
    })();
  };

  return {
    kill: () => child.kill(),
    exited: child.exited,
    onStdout: (handler) => pump(child.stdout, handler),
    onStderr: (handler) => pump(child.stderr, handler),
  };
}

/**
 * A `ScreenTextReaderFactory` backed by UI Automation on Windows.
 *
 * Throws immediately off Windows rather than degrading, because a caller that
 * reached this function on another platform chose the wrong backend and silence
 * would hide that. Like the macOS reader, the backend itself needs a real host to
 * be verified end to end: CI exercises the parser, the role mapping, and the
 * streaming loop through the injected `spawn` seam, and the script is verified by
 * hand with `SQUID_SCREEN_READER=windows` on Windows.
 */
export function createWindowsScreenTextReader(
  options: WindowsScreenTextReaderOptions = {},
): ScreenTextReaderFactory {
  const platform = options.platform ?? process.platform;
  if (options.spawn === undefined && platform !== "win32") {
    throw new Error(
      `The Windows screen text reader requires win32; this process reports ${platform}.`,
    );
  }

  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const script = samplingScript(pollMs, MAX_SELECTION_LENGTH);

  return streamingScreenTextReaderFactory({
    program: "powershell",
    restartMs: options.restartMs ?? DEFAULT_RESTART_MS,
    parse: parseWindowsFocusFrame,
    spawn: options.spawn ?? (() => spawnSampler(script)),
  });
}
