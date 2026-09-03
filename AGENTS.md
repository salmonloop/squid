# Notes for whoever works on this next

Platform-specific traps, written down because each one cost real time to find. The
repository ships to Windows and is developed on Linux, so the asymmetries below are
not trivia — they are the shape of the project.

This file is for the *traps*. What Squid is and how to run it belongs in
`README.md`; the wire between brain and panel belongs in `docs/panel-protocol.md`.

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

**The X11 smoke host is moved but unrun.** `src/ui-smoke.ts` was split into a
platform-free harness plus one host per platform (`ui-smoke-host-x11.ts`,
`ui-smoke-host-windows.ts`). The X11 implementation was moved *verbatim* — same
commands, same flags, same measured button coordinates — but it has not been
executed since the move, because the move happened on a Windows machine. You will be
the first to run it. If it fails, suspect the seam (`prepare`, `panelEnvironment`,
`awaitWindow`, `activate`, `screenshot`), not the X11 mechanics.

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
