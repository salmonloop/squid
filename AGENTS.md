# Notes for whoever works on this next

Platform-specific traps, written down because each one cost real time to find. The
repository ships to Windows and is developed on Linux, so the asymmetries below are
not trivia — they are the shape of the project.

This file is for the *traps*, and for the standing rules the traps produced. What
Squid is and how to run it belongs in `README.md`; the wire between brain and panel
belongs in `docs/panel-protocol.md`.

## How a feature gets switched on

**Default on, switch in the panel.** A feature ships in the state most people want
most of the time, and the way to change that state is the panel's settings form —
every feature gets a control there. Whoever double-clicks the binary gets the whole
product without reading anything first.

**An environment variable is the fallback, not the front door.** Reach for a
`SQUID_*` variable only when something genuinely cannot wait for a switch — a value
the brain needs before any panel exists, or a feature the default would be unsafe
to sit inside (the browser reader observes, so its default-off is a consent
decision, not an oversight). And even then the panel control is still owed: the
variable is how a feature is rescued when the GUI cannot reach it, not how it is
shipped. When in doubt, the direction is on-by-default with a visible way to turn
it off.

## Read this first if you are picking up after Windows work

Two things changed under you, and one thing is unverified.

**The screen reader now defaults to the host's own backend.** It used to default to
`synthetic` — the built-in demo script. So a Linux dev run that previously replayed
scripted frames will now start the real AT-SPI/`xdotool` backend, and if that host
has no accessibility stack the source reports read errors instead of quietly
producing believable fake observations. That is the intended trade (a lie nobody can
see through is worse than an error someone can fix), but it means:

```bash
SQUID_SCREEN_READER=synthetic bun run watch:desktop -- /abs/path   # what you had before
```

Asking for `synthetic` by name still works everywhere and is what the tests use.

**`bun run start` is the app.** `bun run dev` runs a forty-line demo that ingests
three invented events and prints them; it is not Squid. `start` runs
`src/squid-app.ts`, which defaults the watch root, the panel endpoint, and the panel
binary path, and needs no environment.

**The X11 smoke host has now been run, and it passes.** First execution after the
split was on a headless aarch64 Ubuntu box with `Xvfb`, `xdotool`, `xwininfo`,
`ffmpeg` and Mesa's software rasterizer; the panel opened, the clicks landed, the
answers came back, and the screenshots show a correctly rendered window. No seam
needed repair. Two things worth knowing anyway:

- **It reads the header over AT-SPI now.** Reading text on screen is an optional
  `SmokeHost` capability — `readStatus?` — and the X11 host implements it: it
  starts a private session bus, flips `org.a11y.Status.IsEnabled` before the
  panel launches (the order does not matter — the switch is the latch, and the
  tree publishes either way), and reads the header's description from the
  panel's AT-SPI cache. Two measured facts: the a11y side of `dbus-run-session`
  arrives by D-Bus activation, so nothing extra has to be started; and
  `busctl --json=short` wraps the method's one out parameter in a `data` field —
  the node list is `reply.data[0]`, not `reply.data`, and missing that layer
  looks exactly like a panel that never published a tree.
- **The button coordinates are still the measured ones**, and they were measured
  elsewhere. They worked unchanged, so the layout has not moved — but a Slint change
  that moves a button will show up here as a wrong or missing answer, not as a
  layout diff.

## Windows: things that are not obvious

**`node:net` cannot bind a named pipe.** `createServer().listen('\\\\.\\pipe\\x')`
mangles the path and refuses. Use `Bun.listen({ unix })`, which inspects the string
and takes its named-pipe branch — the same call that binds a Unix socket. This is
already the production path (`src/panel-server.ts`); the smoke fixture rediscovered
it the hard way. If you write anything that listens on the panel endpoint, use the
same call.

**The Windows panel opens one connection per line it writes.** The reader
connection subscribes and is written to; every outgoing line is a fresh, write-only
connection that closes immediately. So a server must reply to the connection that
*subscribed*, not the one that asked — replying to the asker sends the dump into a
socket nobody will ever read. The symptom is a panel reporting it was never told
what it can watch, while the server's log says it answered.

**`new URL(import.meta.url).pathname` is POSIX-shaped on Windows.** It yields
`/C:/Users/...`, and `resolve(dirname(that))` reads it as a directory below the
current drive: `C:\C:\Users\...`. Use `fileURLToPath`.

**`powershell.exe` is not reliably on `PATH`.** A POSIX-flavoured parent (Git Bash,
MSYS) hands the child a `PATH` that often omits `System32`. Resolve it from
`%SystemRoot%`. It must be Windows PowerShell rather than `pwsh` whenever UI
Automation is involved: the client is a .NET Framework assembly and `pwsh` does not
load it.

**Process startup dominates every PowerShell-backed sensor.** Measured on a Windows
11 host: starting PowerShell costs 700–1100ms and loading the UIA client assemblies
a few hundred more, against about 40ms for the automation query itself. A per-sample
spawn therefore spends twenty times more work starting a process than reading the
screen. That is why the Windows screen reader streams from one long-lived child
(`streamingScreenTextReaderFactory`) instead of using the shared poll loop. If you
add a Windows sensor, do the arithmetic before choosing the shape.

**FIFO-backed capabilities do not work on Windows.** The capture gate, terminal
commands, and editor saves each need an absolute FIFO path, and `validateFifoPath`
judges by POSIX rules on every host — deliberately, because the config file is one
dialect everywhere. A Windows run therefore cannot enable pause control, terminal
observation, or editor saves at all. Making them work means named-pipe support in
`fifo-line-reader.ts`, not a looser validator.

**Browser page reading is macOS-only.** There is no Windows or Linux
implementation; the synthetic backend covers the code path anywhere.

## Linux: things that are not obvious

**A missing notification daemon does not fail fast — it hangs for two minutes.**
Measured: with nothing owning `org.freedesktop.Notifications`, `notify-send` asks
D-Bus to activate the service and waits out `service_start_timeout=120000ms` before
exiting 1. Anything that spawns a desktop helper therefore needs its own deadline,
which is why `desktop-notice-command.ts` owns one for every backend rather than
leaving it to the platform files. A headless dev box has no daemon at all, so this
is the *default* experience here, not an edge case.

**`notify-send` needs `--` before any text.** `notify-send "-weird" "x"` fails with
`Error parsing option -r`: the summary was read as the short flags `-w -e -i -r -d`.
An agent reply routinely starts with a dash, because a list is how a model
summarises what it did, so the notices most worth reading are exactly the ones that
fail without the terminator.

**Placement is not the client's decision.** The notification spec describes passive
popups and says nothing about position; the daemon decides, per desktop and per user
preference, and it is also what honours do-not-disturb and keeps a missed notice in a
history. Drawing our own window instead gives up all three, and under Wayland it is
not even possible: Slint's own `Window::set_position` documents that "on some
windowing systems, such as Wayland, this functionality is not available", and Slint
1.17 exposes no monitor geometry to compute a corner from anyway. A bottom-right
popup is a Windows convention, not a portable one.

**Seeing a real notification on a headless box** takes a display, a private bus, and
a daemon — all installable, none present by default:

```bash
sudo apt-get install -y libnotify-bin dunst   # notify-send, and something to render it
Xvfb :77 -screen 0 900x300x24 -nolisten tcp &
DISPLAY=:77 dbus-run-session -- bash -c 'dunst & sleep 1; <send a notice>; \
  ffmpeg -y -f x11grab -video_size 900x300 -i :77 -frames:v 1 /tmp/notice.png'
```

`dbus-run-session` rather than the login bus, so a test never claims a well-known
name on the developer's own session. Kill the `Xvfb` explicitly — a trap on the
outer shell does not always get there.

**Desktop notices speak on Linux and Windows by default; macOS is the one host
they stay quiet on.** Linux goes through `notify-send`; Windows through a
`Shell_NotifyIcon` balloon shown by a Windows PowerShell helper
(`src/desktop-notice-windows.ts`), which needs no installer and no
AppUserModelID — the transient tray icon is its own identity, and the toast is
attributed to the messenger. The helper must outlive the system's ten-second
balloon floor before removing its icon, which is why the Windows delivery
deadline is 15s against the shared loop's Linux 5s default. The default-on is
what splits the macOS behaviour in two: unset there starts the run silent,
because a default that exited every machine it never observed would be a trap —
while `SQUID_NOTIFY=desktop` asked for by name still refuses with the reason
named (Notification Center attributes a notice to the bundle that sent it, and
the panel ships no bundle), because a run that asked to be interrupted and
silently was not looks exactly like one whose daemon is asleep. `off` is the
explicit decline, and it wins on every host.

## The tray, and what Slint 1.17 will and will not tell you

**The feature is off by default in this repository, and on by default in Slint.**
`ui/Cargo.toml` uses `default-features = false`, and `system-tray` is one of the
features that drops out — enabling it is a line in that list. The cost is asymmetric
and worth knowing before arguing about it: on Windows it is zero new crates, because
i-slint-core already links `windows` with `Win32_UI_Shell`, where `Shell_NotifyIcon`
lives. On Linux it adds `ksni`, on top of a D-Bus stack the `accessibility` feature
already pulled in through AccessKit's AT-SPI backend.

**Inherited properties get no Rust setter.** Slint generates accessors only for what
the *exported* component declares, so `SystemTrayIcon`'s own `icon`, `tooltip` and
`clicked` are invisible from Rust on a component that merely inherits them. Declare a
property with a different name and bind the inherited one to it — a re-declaration
collides with the base rather than overriding it. The compile error is
`no method named set_icon found for struct SquidTray`, which reads like a missing
feature rather than a naming rule.

**A healthy run prints nothing, and the constructor never probes the host.**
`SquidTray::new()` on Linux always succeeds — building the component touches no
D-Bus — so the `Err` arm that reports "no system tray on this desktop" is dead code
here; the host is probed later, on the first event-loop iteration, when the icon
tracker calls `SystemTrayIconHandle::new` and ksni's spawn talks to the bus. The
icon image is assigned before `window.run()`, so by the time the tracker fires it is
already there and `image_to_argb_icon` succeeds. That means the line
`Slint: Failed to create system tray icon: 0` is the opposite of what it looks like
from the changelog: when it appears, something really failed — no tray host (ksni's
`RegisterStatusNotifierItem` returns `ServiceUnknown` immediately) or an unusable
icon. The real signal for "is the icon up" is whether a `StatusNotifierItem` shows
up on the session bus. Slint 1.18 adds "report an error when no system tray backend
is available"; 1.17.1 reports both failure shapes the same way.

**A headless box can host a tray well enough to verify one.** No desktop shell is
needed: `org.kde.StatusNotifierWatcher` is a handful of D-Bus methods, and `jeepney`
(pure Python, no build step) is enough to own the name, answer
`RegisterStatusNotifierItem`, and then read the registered item's own properties back.
That is a stronger check than a screenshot — it sees the tooltip string, the pixmap's
dimensions and byte count, the published `Title`, and the menu object path:

```
REGISTERED: org.kde.StatusNotifierItem-<pid>-1
Title: 'Squid'
ToolTip: ('', [], 'Squid — Nothing reported yet', '')
Menu: '/MenuBar'
IconPixmap: 1 variant(s); 64x64 16384 bytes
```

Run it under `Xvfb` and `dbus-run-session` the same way as the notification recipe
above. The empty `Title` in the first run of this is what made it worth writing: the
property is what accessibility tools read on Linux, and nothing else would have
noticed it was unset. **The host must answer before it reads.** While it is making
its own outbound `GetLayout` call, a jeepney blocking connection drops any inbound
message that is not the awaited reply — if the panel is still mid-handshake, the
swallowed `IsStatusNotifierHostRegistered` kills the tray's spawn and the readback
then reports a menu the readback itself destroyed. Gate the readback on the panel
being registered (and give it a beat), or you are measuring the stand-in, not the
panel.

**The tray menu exports on Linux; the "empty menu" was the stand-in host's own
doing.** The first measurement through the host above read
`GetLayout` as `(0, (0, {}, []))` with `AboutToShow` answering `false`, and Slint
got blamed. The stand-in was the culprit: while it was busy reading the menu back,
it swallowed ksni's `IsStatusNotifierHostRegistered` query (jeepney's blocking reply
wait drops non-matching inbound messages), so the tray's spawn failed and the menu
was never exported — and the same stand-in then reported the emptiness it had
caused. A fake host must answer like a real one first (register, respond to the
property query) and only then read back; with that ordering, the same measurement on
the same panel returns both menu entries.

**Closing is "put away", and the whole lifecycle is measured.** The window handles
close with `CloseRequestResponse::HideWindow` (`ui/src/main.rs`), and the tray's
keepalive takes over: i-slint-core acquires a keepalive for a tray that has a
platform handle and is visible (`items/system_tray.rs` `update_keepalive`), so
`Window::hide()` releasing the window's one does not zero the count and quit the
loop. Measured end-to-end on the stand-in host, with the app calling the same
`Window::hide()` a close delivers: the window unmaps, the process stays alive, a
dbusmenu `Event` for "Show Squid" re-maps it (`Window::show()` runs
`set_visible(true)` unconditionally, and winit re-maps because its own visibility
state moved), and an `Event` for "Quit Squid" ends the process.

**What this box cannot measure: close delivery itself.** Under `Xvfb` — with or
without a WM — `xdotool windowclose` destroys the X window without
`on_close_requested` ever firing, so the WM_DELETE_WINDOW → Slint link is verified
by reading `i-slint-backend-winit/event_loop.rs` (CloseRequested →
`try_dispatch_event`), not by running it. Related trap: `windowunmap` is not a hide
test — it bypasses Slint, whose state still says "visible", so a later
`Window::show()` dedupes in winit's `set_visibility` (`shown.get()` unchanged) and
no-ops. Only a Slint-side hide makes the show path real.

## Rust and the panel on Windows

**`cargo` needs an MSVC environment.** Run it from a shell that has sourced
`vcvars64.bat`, or the build script's link step fails. Watch out for a `link.exe`
earlier on `PATH` than MSVC's — GNU coreutils ships one, and the error it produces
does not say so.

**`cargo check` does compile the `.slint` files.** `ui/build.rs` calls
`slint_build::compile_with_config(...).expect(...)`, so a Slint error fails the
build script. If you want to be sure a Slint change was actually compiled rather
than served from cache, touch the file and confirm `Compiling squid-ui` appears.

**There is no in-repo test of Slint expression logic.** `ui/Cargo.toml` drops the
interpreter (`default-features = false`), so the only thing that exercises
`status.slint`'s state machine is the visual smoke harness. A defect in that
expression is invisible to `cargo test`.

## Testing on a real Windows desktop

The Windows smoke host works the desktop the person is sitting at, because there is
no Xvfb equivalent a compiled winit window will draw into. That has consequences the
X11 host does not have:

- **Match the window by process id, not just title.** A leaked window from an
  earlier run answers to the same title, and `FindFirst` may return either. Two
  consecutive searches can return different windows.
- **Raise the window, then verify the pixel under the cursor belongs to it.** A
  click goes to whatever is topmost; clicking through an occluded panel sends input
  to a stranger and fails a later assertion for the wrong reason. `SetForegroundWindow`
  is refused for a background process — `SetWindowPos` with `HWND_TOPMOST` is not.
- **Kill the panel with SIGKILL after a grace period, and `unref()` the listener.**
  A harness that hangs on success, or leaks a panel, poisons the next run through
  the title collision above.

Two UIA facts worth knowing before writing an assertion:

- **Slint publishes `accessible-label` as the UIA *Name*, and does not publish
  `accessible-description` at all** — `HelpText` is empty on every element. What it
  does publish is each `Text` element's own string as that element's Name, so the
  status card's three lines are readable as its UIA descendants.
- **Chromium exposes `TextPattern` on its document and ignores a programmatic
  `Select()`.** You cannot force a selection to verify selection reading. Windows 11
  Notepad is no help either: it is a packaged app, so the pid `Start-Process` returns
  is a launcher's, not the UI's, and a UIA search by that pid finds nothing.

## Working copy hygiene

Files are checked out **CRLF** (`core.autocrlf`), and committed LF. Editing tools
that match exact strings will fail against an `\n`-shaped expectation, and scripted
patching must preserve `\r\n` or it will corrupt every line it touches. Escape
sequences are the other half of the same trap: a script that rewrites TypeScript
source can turn `"\n"` into a literal newline inside a string literal, which fails
to parse in a way that points at the wrong line.

## What CI does and does not cover

The Windows job (`.github/workflows/ci.yml`) runs the whole `bun test` suite plus
`cargo clippy`/`cargo test` for the panel — clippy matters more there than the
shared lint suggests, because every lint inside a `#[cfg(windows)]` block is
invisible to the Linux job. It does **not** run `bun run ui:smoke`. The Windows host
now supports it, but nobody has confirmed a GitHub Windows runner gives a usable
interactive desktop, and the host refuses a non-interactive session by design. If
you try it, that refusal is where to look first.
