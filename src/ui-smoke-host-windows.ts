import {
  eventually,
  run,
  smokeFailure,
  type SmokeControl,
  type SmokeHost,
  type SmokeWindow,
} from "./ui-smoke-host.js";
import { windowsPowerShellPath } from "./windows-powershell.js";

/**
 * The Windows smoke host: the interactive desktop, UI Automation for the window
 * and its controls, and GDI for the picture.
 *
 * No virtual display, because there is nothing to virtualise: Windows has no
 * Xvfb equivalent that a compiled winit window will draw into, and the honest
 * substitute is the desktop the person running this is already looking at. That
 * costs one prerequisite the X11 host does not have — the run must be on an
 * interactive desktop, not a service session — and gains one it cannot have: no
 * measured button positions.
 *
 * Controls are found by their accessible name and pressed by a real click at the
 * rectangle UI Automation reports for them. Both halves are deliberate. Finding
 * by name exercises the accessibility tree, which the panel takes seriously
 * enough to give every button an `accessible-description` and every card an
 * `accessible-role`; a run that could not find "Later" by name would be
 * reporting a real defect. Clicking the rectangle rather than calling
 * `InvokePattern.Invoke` keeps the hit-testing in the test: invoking a pattern
 * proves the callback is wired, while a click also proves the control is where a
 * person's mouse would find it. Invoke would pass on a button rendered under
 * another one.
 *
 * `powershell.exe` rather than `pwsh`: UI Automation's managed client lives in
 * the .NET Framework assemblies (`UIAutomationClient`, `UIAutomationTypes`),
 * which Windows PowerShell loads and PowerShell 7 does not. The same choice the
 * Windows screen reader makes for the same reason — the interpreter that is
 * already on every Windows host, with no native Node dependency taken.
 */

/** The accessible name of each control, exactly as the Slint source spells it. */
const CONTROL_NAME: Record<SmokeControl, string> = {
  decline: "Decline",
  later: "Later",
  allow: "Allow",
  review: "Review",
};

/**
 * Shared preamble: stop on the first error, make this process DPI-aware, and
 * load UI Automation.
 *
 * `SetProcessDPIAware` before anything measures: without it Windows reports every
 * rectangle in virtualised coordinates while `SetCursorPos` takes physical ones,
 * so on any display above 100% scaling the click lands short of the button it was
 * aimed at — and lands on something, which is how this would pass while testing
 * nothing.
 */
const PREAMBLE = `
$ErrorActionPreference = 'Stop'
Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.IntPtr extra);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int command);
[DllImport("user32.dll")] public static extern System.IntPtr WindowFromPoint(System.Drawing.Point point);
[DllImport("user32.dll")] public static extern System.IntPtr GetAncestor(System.IntPtr hWnd, uint flags);
[DllImport("user32.dll")] public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder text, int count);
'@ -Name Desktop -Namespace SquidSmoke -ReferencedAssemblies System.Drawing | Out-Null
[void][SquidSmoke.Desktop]::SetProcessDPIAware()
Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null

# Raises one window above every non-topmost window, restoring it first in case it
# is minimised.
#
# HWND_TOPMOST rather than SetForegroundWindow alone: Windows refuses a
# foreground change requested by a process that does not already own the
# foreground, which a test harness never does. SetWindowPos has no such rule, so
# this is the one call that reliably gets the panel out from under whatever the
# person left on screen. Foreground is still attempted afterwards, because it is
# what gives the window keyboard focus when the rules do allow it.
#
# It is a real intrusion on a desktop somebody is using, and there is no honest
# way around it: a click lands on whatever is topmost at those coordinates, and a
# screenshot photographs the same. The alternative is a harness that tests
# another application's buttons and says the panel passed.
function Raise-Window([System.IntPtr] $handle) {
  [void][SquidSmoke.Desktop]::ShowWindow($handle, 9)
  [void][SquidSmoke.Desktop]::SetWindowPos($handle, [System.IntPtr](-1), 0, 0, 0, 0, 0x0043)
  try { [void][SquidSmoke.Desktop]::SetForegroundWindow($handle) } catch {}
  Start-Sleep -Milliseconds 120
}

# Whether the window under a screen point belongs to the given top-level window.
#
# The guard that keeps this harness honest. Without it an occluded panel is
# clicked *through* — the input goes to a stranger's window, the panel never sees
# it, and the only assertion that notices is a later one whose failure names the
# wrong cause.
function Test-PointBelongsTo([System.IntPtr] $handle, [int] $x, [int] $y) {
  $point = New-Object System.Drawing.Point $x, $y
  $under = [SquidSmoke.Desktop]::WindowFromPoint($point)
  if ($under -eq [System.IntPtr]::Zero) { return $false }
  $root = [SquidSmoke.Desktop]::GetAncestor($under, 2)
  return ($root -eq $handle)
}

function Get-WindowTitle([System.IntPtr] $handle) {
  $builder = New-Object System.Text.StringBuilder 512
  [void][SquidSmoke.Desktop]::GetWindowText($handle, $builder, $builder.Capacity)
  return $builder.ToString()
}
`;

/**
 * Finds the panel's own top-level window and prints its rectangle.
 *
 * Three conditions, and each one is load-bearing. The title, because that is what
 * identifies the panel. The window control type, because the panel's own
 * accessible label is also text on screen and matching on name alone can return a
 * child element whose rectangle is not the window's. And the process id, because
 * this desktop is shared: a Squid window left behind by an earlier run answers to
 * the same title, and a run that tested that window would be reporting on a
 * process it did not start and cannot see the wire of.
 *
 * Prints nothing when there is no match, which the caller reads as "not yet" — the
 * window is spawned asynchronously and polling is the only honest way to wait for
 * it.
 */
function windowScript(title: string, processId: number): string {
  return `${PREAMBLE}
$byName = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, '${title}')
$byKind = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Window)
$byProcess = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${processId})
$condition = New-Object System.Windows.Automation.AndCondition($byName, $byKind, $byProcess)
$window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
  [System.Windows.Automation.TreeScope]::Children, $condition)
if ($null -eq $window) { exit 0 }
if ($window.Current.IsOffscreen) { exit 0 }
$r = $window.Current.BoundingRectangle
if ($r.Width -le 0 -or $r.Height -le 0) { exit 0 }
Write-Output ('{0} {1} {2} {3} {4}' -f $window.Current.NativeWindowHandle,
  [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
`;
}

/**
 * Clicks the named control inside the given window.
 *
 * Scoped to the window's own subtree rather than the desktop, so another
 * application with an "Allow" button cannot be the one that gets pressed.
 *
 * Three things happen in order, and the middle one is the point. The window is
 * raised, because a click goes to whatever is topmost at those coordinates. The
 * point is then checked to belong to the panel, because raising can fail — a
 * genuinely always-on-top window elsewhere stays above it — and clicking anyway
 * would deliver a stranger's window a click and this run a false pass. Only then
 * is the button pressed, at the centre of the rectangle UI Automation reports for
 * it.
 */
function clickScript(handle: string, name: string): string {
  return `${PREAMBLE}
$handle = [System.IntPtr]${handle}
$window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
if ($null -eq $window) { throw 'the panel window is gone' }
Raise-Window $handle
$button = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, '${name}')))
if ($null -eq $button) { throw 'no control named ${name} is on screen' }
if ($button.Current.IsOffscreen) { throw 'the control named ${name} is off screen' }
$r = $button.Current.BoundingRectangle
$x = [int]($r.X + $r.Width / 2)
$y = [int]($r.Y + $r.Height / 2)
if (-not (Test-PointBelongsTo $handle $x $y)) {
  $point = New-Object System.Drawing.Point $x, $y
  $intruder = [SquidSmoke.Desktop]::GetAncestor([SquidSmoke.Desktop]::WindowFromPoint($point), 2)
  throw ('${name} is covered at {0},{1} by "{2}"; the panel could not be raised above it' -f $x, $y, (Get-WindowTitle $intruder))
}
[void][SquidSmoke.Desktop]::SetCursorPos($x, $y)
Start-Sleep -Milliseconds 40
[SquidSmoke.Desktop]::mouse_event(0x0002, 0, 0, 0, [System.IntPtr]::Zero)
[SquidSmoke.Desktop]::mouse_event(0x0004, 0, 0, 0, [System.IntPtr]::Zero)
Write-Output ('clicked ${name} at {0},{1}' -f $x, $y)
`;
}

/**
 * Saves the window's pixels, cropped to exactly that window.
 *
 * Raised first, and then checked: `CopyFromScreen` reads the composited desktop,
 * so a covered panel produces a photograph of whatever covered it — which is
 * worse than no picture, because it is a file that looks like evidence. The
 * corner is probed rather than trusted, and a covered window fails the run at the
 * point where the cause is still obvious.
 */
function screenshotScript(window: SmokeWindow, path: string): string {
  return `${PREAMBLE}
$handle = [System.IntPtr]${window.id}
Raise-Window $handle
$probeX = ${window.x} + [int](${window.width} / 2)
$probeY = ${window.y} + 8
if (-not (Test-PointBelongsTo $handle $probeX $probeY)) {
  $point = New-Object System.Drawing.Point $probeX, $probeY
  $intruder = [SquidSmoke.Desktop]::GetAncestor([SquidSmoke.Desktop]::WindowFromPoint($point), 2)
  throw ('the panel is covered by "{0}"; a screenshot would photograph that instead' -f (Get-WindowTitle $intruder))
}
$bitmap = New-Object System.Drawing.Bitmap ${window.width}, ${window.height}
try {
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen(${window.x}, ${window.y}, 0, 0, $bitmap.Size)
  } finally { $graphics.Dispose() }
  $bitmap.Save('${path.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
} finally { $bitmap.Dispose() }
`;
}

/**
 * Everything the status card says, one line per line of it.
 *
 * Measured rather than assumed: Slint publishes `accessible-label` as the UI
 * Automation *Name* and does not publish `accessible-description` at all — every
 * element in the panel reports an empty `HelpText`. What it does publish is each
 * `Text` element's own string as that element's Name, and the status card's three
 * lines are its UIA descendants. So the card is found by its label and read
 * through its children, which is the tree the panel actually exposes rather than
 * the one its source reads like it should.
 *
 * That is also the assertion underneath: a screen reader hears these three
 * strings, so a header that reads honestly on screen and dishonestly here would
 * be a different defect worth failing on.
 *
 * Prints nothing when there is no such card, which the caller reads as "the panel
 * published no status" rather than as an empty one.
 */
function statusScript(handle: string, label: string): string {
  return `${PREAMBLE}
$window = [System.Windows.Automation.AutomationElement]::FromHandle([System.IntPtr]${handle})
if ($null -eq $window) { throw 'the panel window is gone' }
$card = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, '${label}')))
if ($null -eq $card) { exit 0 }
$lines = $card.FindAll([System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition)
for ($i = 0; $i -lt $lines.Count; $i++) {
  $name = $lines.Item($i).Current.Name
  if (-not [string]::IsNullOrWhiteSpace($name)) { Write-Output $name }
}
`;
}

/**
 * Windows PowerShell, by absolute path rather than by name — the one resolver
 * every PowerShell spawn in this repository answers to. The reasoning behind it
 * lives on the resolver, not here.
 */
const POWERSHELL = windowsPowerShellPath();

const POWERSHELL_ARGUMENTS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

async function powershell(script: string, description: string): Promise<string> {
  const result = await run(POWERSHELL, [...POWERSHELL_ARGUMENTS, script]);
  if (result.code !== 0) {
    smokeFailure(`${description}: ${result.stderr.trim() || `powershell exited ${String(result.code)}`}`);
  }
  return result.stdout.trim();
}

export function createWindowsSmokeHost(): SmokeHost {
  return {
    kind: "windows",

    /**
     * A named pipe, not a file in the smoke's temporary directory: the Windows
     * panel opens its endpoint with `CreateFileW` on `\\.\pipe\<name>`, which is
     * a namespace with no directories in it. The process id keeps two concurrent
     * runs from colliding on one name — a stale pipe from a crashed run would
     * otherwise be accepted as this run's fixture.
     */
    endpoint: (_directory: string) => `\\\\.\\pipe\\squid-ui-smoke-${process.pid}`,

    prepare: async () => {
      const probe = await run(POWERSHELL, [
        ...POWERSHELL_ARGUMENTS,
        "if ([System.Environment]::UserInteractive) { 'interactive' } else { 'headless' }",
      ]);
      if (probe.code !== 0) {
        smokeFailure(
          `${POWERSHELL} did not run (${probe.stderr.trim() || String(probe.code)}); this check needs Windows PowerShell, which UI Automation's client assemblies require.`,
        );
      }
      if (probe.stdout.trim() !== "interactive") {
        smokeFailure(
          "this session is not interactive, so no window can be drawn; run the smoke from a desktop session rather than a service.",
        );
      }
      await powershell(`${PREAMBLE}Write-Output 'ready'`, "UI Automation could not be loaded");
      return "the interactive desktop";
    },

    /**
     * Nothing. The panel finds the desktop by itself, and the endpoint is passed
     * by the caller like it is everywhere else — there is no `DISPLAY` equivalent
     * to hand it, and inventing an empty variable to look symmetrical with X11
     * would be a setting that does nothing.
     */
    panelEnvironment: () => ({}),

    awaitWindow: (title: string, processId: number) =>
      eventually("a visible Squid window", async () => {
        const line = await powershell(
          windowScript(title, processId),
          "could not search for the panel window",
        );
        if (line.length === 0) return null;
        const parts = line.split(/\s+/);
        if (parts.length !== 5) return null;
        const [id, x, y, width, height] = parts.map((part) => part.trim());
        const numbers = [x, y, width, height].map(Number);
        if (numbers.some((value) => !Number.isFinite(value))) return null;
        return {
          id: id ?? "",
          x: numbers[0] ?? 0,
          y: numbers[1] ?? 0,
          width: numbers[2] ?? 0,
          height: numbers[3] ?? 0,
        };
      }),

    activate: async (window: SmokeWindow, control: SmokeControl) => {
      const name = CONTROL_NAME[control];
      await powershell(clickScript(window.id, name), `could not click ${name}`);
    },

    screenshot: async (window: SmokeWindow, path: string) => {
      await powershell(screenshotScript(window, path), `could not save ${path}`);
    },

    readStatus: async (window: SmokeWindow) => {
      const text = await powershell(
        statusScript(window.id, "Squid status"),
        "could not read the status header",
      );
      // Rejoined with a separator rather than newlines: this ends up in one log
      // line and one failure message, where three lines would be read as three
      // findings.
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
      return lines.length === 0 ? null : lines.join(" | ");
    },

    /** Nothing was acquired, so nothing is released. */
    dispose: async () => {},
  };
}
