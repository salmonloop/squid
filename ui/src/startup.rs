//! What the panel says when it cannot start, and how it gets said.
//!
//! Two startup failures end this process before there is a window: the endpoint
//! variable is unset, and Slint cannot bring up a window at all. Both used to
//! write one line to stderr and exit, which is the right thing when a daemon
//! launched the panel and the wrong thing when a person double-clicked it: a
//! double-clicked console binary owns its console window, so the console dies
//! with the process and takes the explanation with it. The observed symptom is a
//! black box that flashes and vanishes, which names no cause at all.
//!
//! So a fatal startup message goes to stderr *and*, on Windows, to a message box
//! — but only when this process owns the console it is attached to. That
//! condition is the whole reason a box is safe to show: a panel started from a
//! shell already has a readable stderr, and one started by a daemon with no
//! console must never block on a dialog nobody is there to dismiss. The box is
//! for the one case where it is the only surface that survives.
//!
//! Nothing here is on the running path. It is reached once, at startup, on the
//! way out.

/// The variable a user has to set, taken from the module that reads it.
///
/// Not a second copy of the string. The entire value of this message is that the
/// name it prints is the name `transport` actually looks up, so a rename that
/// touched one spelling and not the other would produce a confidently wrong
/// instruction — the worst possible outcome for the one text a stuck user reads.
use crate::transport::SOCKET_ENV;

/// Why the panel could not start.
///
/// Both variants are terminal by construction — there is no `Recoverable` — which
/// is what keeps [`abort`] able to promise `!` and keeps every caller from having
/// to decide whether a startup failure is worth continuing past.
pub enum Startup {
    /// `SQUID_PANEL_SOCKET` is unset or empty, so there is no endpoint to reach.
    ///
    /// No longer produced by the ordinary path: an unset variable now means "the
    /// user double-clicked me", and the panel computes the endpoint and starts a
    /// brain itself. The variant stays because the exit code is published in
    /// `docs/panel-protocol.md` and a launcher may still read it, and because
    /// "unset" and "set to empty" are different mistakes — the second is a shell
    /// that lost the value on the way.
    Unconfigured,
    /// Nothing is listening and there is no `squid` binary beside this one to
    /// start. Carries the path that was looked for, because the fix is to unpack
    /// the other half of the zip and the user needs to know where it goes.
    NoBrain(String),
    /// Slint could not create the window or run its event loop. Carries the
    /// platform's own text, because the useful part (no display, no OpenGL, a
    /// missing library) is in there and this file cannot improve on it.
    Platform(String),
}

/// A working value for this platform, in the spelling its transport accepts.
///
/// Windows connects to a named pipe and Unix to a filesystem socket, so a
/// single example would be wrong on one of them — and a wrong example in the
/// message that exists to unblock someone is worse than no example.
#[cfg(windows)]
const ENDPOINT_EXAMPLE: &str = "\\\\.\\pipe\\squid-panel";
#[cfg(not(windows))]
const ENDPOINT_EXAMPLE: &str = "/tmp/squid-panel.sock";

/// The shell syntax that sets a variable, for the shell this platform's user is
/// likely holding. The name and the value are interpolated rather than written
/// out, so the command cannot name a variable the transport does not read.
#[cfg(windows)]
const EXPORT_SYNTAX: &str = "$env:{name} = \"{value}\"";
#[cfg(not(windows))]
const EXPORT_SYNTAX: &str = "export {name}={value}";

/// The one command that changes the outcome, built from the live variable name.
fn export_example() -> String {
    EXPORT_SYNTAX
        .replace("{name}", SOCKET_ENV)
        .replace("{value}", ENDPOINT_EXAMPLE)
}

impl Startup {
    /// The process exit code.
    ///
    /// Distinct per variant, and neither is `1`: a script that launches the panel
    /// can tell "you did not configure me" from "this machine cannot draw a
    /// window" from the generic failure of everything else.
    pub fn code(&self) -> i32 {
        match self {
            Self::Unconfigured | Self::NoBrain(_) => 2,
            Self::Platform(_) => 3,
        }
    }

    /// The text a user reads, on stderr or in a dialog.
    ///
    /// Says what happened, then why this binary is not something to run on its
    /// own, then the one command that changes the outcome. The middle part is the
    /// part that was missing: someone who double-clicks this has no reason to
    /// suspect it is a client of a session that has to already be running.
    pub fn message(&self) -> String {
        match self {
            Self::Unconfigured => format!(
                "squid-ui: {SOCKET_ENV} is set but empty, so there is no endpoint to \
                 connect to.\n\
                 \n\
                 An *unset* variable is fine — the panel then computes the default \
                 endpoint for this platform ({ENDPOINT_EXAMPLE}) and starts the \
                 session itself. An empty one is different: it reads as a value that \
                 was lost on the way, so it stops here rather than guessing which was \
                 meant.\n\
                 \n\
                 Either unset it, or point it at the endpoint a running session \
                 listens on:\n\
                 \n\
                 \x20   {command}\n\
                 \n\
                 See docs/panel-protocol.md for the endpoint spelling each platform accepts.",
                command = export_example()
            ),
            Self::NoBrain(detail) => format!(
                "squid-ui: no Squid session is running, and this panel could not find \
                 one to start.\n\
                 \n\
                 {detail}\n\
                 \n\
                 The release zip ships the panel and the session (`squid`) side by \
                 side, and double-clicking the panel is meant to start both — so a \
                 panel on its own has a window to draw and nothing to draw in it. \
                 Unpack the whole zip and run this again, or start `squid` yourself \
                 and the panel will attach to it."
            ),
            Self::Platform(detail) => format!(
                "squid-ui: this machine could not open the panel window.\n\
                 \n\
                 {detail}\n\
                 \n\
                 The panel renders natively and has no software or browser fallback, so a \
                 display it cannot reach is a panel that cannot start. On a virtual \
                 machine or a remote session this is usually a missing or unaccelerated \
                 OpenGL driver."
            ),
        }
    }
}

/// Reports a startup failure everywhere it can be seen, then exits.
///
/// stderr unconditionally: it is where a shell, a log file, and a parent process
/// all look, and it costs nothing when nobody is reading. The dialog only on
/// Windows and only when this process owns its console — see the module comment
/// for why that condition is load-bearing rather than a nicety.
pub fn abort(reason: Startup) -> ! {
    let message = reason.message();
    eprintln!("{message}");
    #[cfg(windows)]
    windows_dialog::show_if_console_is_ours(&message);
    std::process::exit(reason.code());
}

/// The two Win32 calls that make a vanished console window recoverable.
///
/// Hand-declared rather than pulled from a crate. `windows-sys` is already in the
/// dependency graph underneath Slint, so taking it directly would compile no new
/// code — but it would add a dependency line to a `Cargo.toml` that argues, at
/// length, for having none beyond the renderer. `protocol.rs` hand-writes a JSON
/// parser on exactly that reasoning; two `extern` declarations are a smaller
/// thing than that, and this is the same trade.
///
/// These are also the only `unsafe` in the crate. They are here, in the module
/// that runs once on the way out, rather than anywhere near the code that turns a
/// click into permission to run a command.
#[cfg(windows)]
mod windows_dialog {
    use std::ffi::c_void;

    // Both live in `user32.dll`, which every Windows GUI process already links.
    unsafe extern "system" {
        /// Fills `list` with the process ids attached to this console and returns
        /// how many there are — or the count it would have needed, if `count` was
        /// too small. Returns 0 when there is no console.
        fn GetConsoleProcessList(list: *mut u32, count: u32) -> u32;
        /// Blocks until dismissed. That is the reason the caller checks who owns
        /// the console first: an unattended process must not stop here.
        fn MessageBoxW(
            window: *mut c_void,
            text: *const u16,
            caption: *const u16,
            style: u32,
        ) -> i32;
    }

    /// `MB_OK`, a single dismiss button, is the default and its value is zero —
    /// named here so the style below reads as a complete description rather than
    /// as two flags that happen to be the ones we set.
    const MB_OK: u32 = 0x0000_0000;
    const MB_ICONERROR: u32 = 0x0000_0010;
    /// Foreground because the console this replaces was about to disappear from
    /// under the user's cursor, and a box that opens behind the window they were
    /// looking at is the same failure in a new shape.
    const MB_SETFOREGROUND: u32 = 0x0001_0000;

    const STYLE: u32 = MB_OK | MB_ICONERROR | MB_SETFOREGROUND;

    /// Shows the message, but only when this process is the sole owner of its
    /// console.
    ///
    /// The count is the signal, and it is exact rather than heuristic. Launched
    /// from a shell, the shell is attached too, so the count is at least two and
    /// stderr has somewhere to go. Double-clicked, this process is alone in a
    /// console created for it that will close when it exits — count one, and the
    /// box is the only thing that outlives the process. Started by a daemon with
    /// no console at all, the call returns zero and no dialog is shown, which is
    /// what keeps an unattended launch from blocking forever on a click.
    pub fn show_if_console_is_ours(message: &str) {
        if !console_is_ours() {
            return;
        }
        let text = wide(message);
        let caption = wide("Squid panel");
        // SAFETY: both pointers are to NUL-terminated UTF-16 buffers that outlive
        // the call, the window handle is null for an ownerless box, and the style
        // bits are the documented constants above. `MessageBoxW` reads the
        // strings and does not retain them.
        unsafe {
            MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), STYLE);
        }
    }

    /// Whether exactly one process — this one — is attached to the console.
    fn console_is_ours() -> bool {
        // Room for two ids is all the question needs: the answer is "one" or
        // "more than one", and a console with fifty processes still returns its
        // true count rather than writing past this buffer.
        let mut ids = [0u32; 2];
        // SAFETY: the pointer is to a local array of exactly the length passed,
        // which is the contract this call is documented under.
        let count = unsafe {
            GetConsoleProcessList(
                ids.as_mut_ptr(),
                u32::try_from(ids.len()).expect("2 fits in a u32"),
            )
        };
        count == 1
    }

    /// A NUL-terminated UTF-16 copy, as the `W` entry points require.
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The codes are part of the interface a launcher scripts against, so they
    /// are asserted rather than left to whatever the match arms happen to say.
    #[test]
    fn each_failure_has_its_own_exit_code() {
        assert_eq!(Startup::Unconfigured.code(), 2);
        // A missing sibling binary shares 2 with the endpoint refusal, and that is
        // deliberate: both are "this launch was not set up right", which is what a
        // launcher scripts against. 3 stays the machine-cannot-draw code, because
        // that is the one a retry on the same box will not fix either but for an
        // entirely different reason.
        assert_eq!(Startup::NoBrain("looked in /opt".to_owned()).code(), 2);
        assert_eq!(Startup::Platform("no display".to_owned()).code(), 3);
        assert_ne!(
            Startup::Unconfigured.code(),
            Startup::Platform(String::new()).code()
        );
        // None of them is the code a panic or an uncaught error would produce.
        assert_ne!(Startup::Unconfigured.code(), 1);
        assert_ne!(Startup::NoBrain(String::new()).code(), 1);
        assert_ne!(Startup::Platform(String::new()).code(), 1);
    }

    /// The empty-endpoint message has to say why *empty* is a refusal when
    /// *unset* is not, since that asymmetry is the surprising part now that the
    /// panel is an entry point. It names the variable, both outcomes, and the
    /// command for this platform.
    #[test]
    fn the_unconfigured_message_distinguishes_empty_from_unset() {
        let message = Startup::Unconfigured.message();
        assert!(message.contains(SOCKET_ENV), "{message}");
        // The distinction itself, in the user's words rather than ours.
        assert!(message.contains("empty"), "{message}");
        assert!(message.contains("unset"), "{message}");
        assert!(message.contains(ENDPOINT_EXAMPLE), "{message}");
        assert!(message.contains(&export_example()), "{message}");
        // And no longer claims the panel is only ever a client: a double-clicked
        // panel starts the session itself, and a message saying otherwise would
        // send the user looking for a CLI they do not need.
        assert!(!message.contains("This panel is a client"), "{message}");
    }

    /// The no-brain message is the one a user actually meets when they copy the
    /// panel out of the zip alone, so it has to carry the path that was searched
    /// and the fix — unpack both halves — rather than just reporting absence.
    #[test]
    fn the_no_brain_message_names_where_it_looked_and_what_to_do() {
        let message = Startup::NoBrain("looked for /opt/squid/squid".to_owned()).message();
        assert!(message.contains("/opt/squid/squid"), "{message}");
        assert!(message.contains("side by"), "{message}");
        assert!(message.contains("squid"), "{message}");
    }

    /// The platform's own text is the useful part of a render failure, so it is
    /// carried through verbatim instead of being replaced by a summary.
    #[test]
    fn a_platform_failure_keeps_the_platform_s_own_words() {
        let message = Startup::Platform("winit: no suitable OpenGL context".to_owned()).message();
        assert!(
            message.contains("winit: no suitable OpenGL context"),
            "{message}"
        );
        // And explains why there is no fallback, which is the question the
        // platform text leaves open.
        assert!(message.contains("fallback"), "{message}");
    }

    /// Every placeholder in the per-platform syntax gets substituted.
    ///
    /// The command is assembled by name, so a `cfg` branch whose spelling drifts
    /// — `{val}` for `{value}`, or a brace left in — would ship a literal
    /// placeholder inside the one instruction a stuck user is meant to paste.
    /// That is the failure this checks; the endpoint and variable being right is
    /// already guaranteed by their being interpolated rather than retyped.
    #[test]
    fn the_example_command_has_no_placeholder_left_in_it() {
        let command = export_example();
        assert!(command.contains(SOCKET_ENV), "{command}");
        assert!(command.contains(ENDPOINT_EXAMPLE), "{command}");
        assert!(!command.contains('{'), "{command}");
        assert!(!command.contains('}'), "{command}");
    }
}
