//! Keeps the floating suggestion card from taking the keyboard.
//!
//! A suggestion arrives while somebody is typing — that is the only moment it is
//! useful — so a window that takes focus to show it interrupts the very act it is
//! offering to help with. Measured on the development box: without this, the card
//! becomes the foreground window on every show, first and subsequent alike.
//!
//! Two things are needed, and the first measurement is why there are two.
//!
//! **The style bit, so the card is not the kind of window that takes focus.**
//! `WS_EX_NOACTIVATE` is a property of the *window* rather than of the call that
//! shows it, which is what makes it the right mechanism where
//! `ShowWindow(SW_SHOWNOACTIVATE)` is not: winit uses that flag only for a
//! window's first show and `SW_SHOW` — which activates — on every later one
//! (`winit-0.30.13/platform_impl/windows/window_state.rs`, `TextState::apply_diff`
//! and its `MARKER_ACTIVATE` latch). It is also what keeps a click on the card's
//! own buttons from pulling the keyboard away from the field they are about to
//! type into.
//!
//! **Giving the keyboard back after the show that created the window.** Measured:
//! the style alone is not enough, because it can only be applied to a window that
//! exists and the native window is created by that very show — and because
//! `ShowWindow` activates a window regardless of the style. The first version of
//! this module read the foreground window *after* the show and found the card,
//! so its restore did nothing; the holder has to be captured before. That
//! ordering is the whole content of [`keyboard_holder`] and [`apply`].
//!
//! **Why this is hand-declared rather than a crate.** The same reason
//! `workarea.rs` hand-declares `GetMonitorInfoW`: `ui/Cargo.toml` says the panel
//! has no dependencies beyond Slint on purpose, and a process whose whole job is
//! to turn a click into permission to run a command treats its own supply chain as
//! part of the threat model. A handful of function declarations is smaller than
//! that argument.
//!
//! **Why the window is found by title.** Slint exposes no handle, and reaching
//! winit's requires the `unstable-winit-030` feature. `suggestion.slint` gives the
//! card a title of its own — deliberately not "Squid", which the smoke harness
//! searches for — so the title identifies it. The process id is checked as well: a
//! title is not proof, and another copy of Squid running beside this one has a
//! card with exactly the same title. Acting on that one would make a stranger's
//! window uneditable and leave this run's card taking focus, which is the failure
//! this module exists to prevent.

/// The suggestion card's title, exactly as `suggestion.slint` spells it.
///
/// One constant, in one place: the window is found by this string, so a rename
/// that missed it would silently stop the card from keeping its hands off the
/// keyboard.
pub const WINDOW_TITLE: &str = "Squid suggestion";

/// A native window handle, as an opaque token.
///
/// An integer rather than a pointer type so that the one value a caller has to
/// carry across a `show()` is `Copy`, `Send`-free of any lifetime, and comparable
/// on every platform. Zero means "no such window", which every function here
/// treats as "nothing to do" rather than as an error — a desktop with no
/// foreground window is a legitimate state.
pub type Holder = isize;

/// No window. What a platform that cannot answer reports, and what a session with
/// nothing focused reports.
pub const NONE: Holder = 0;

#[cfg(windows)]
mod windows {
    use super::{Holder, NONE};
    use std::ffi::c_void;

    type Hwnd = *mut c_void;

    /// `GWL_EXSTYLE`: the extended window style.
    const GWL_EXSTYLE: std::ffi::c_int = -20;

    /// `WS_EX_NOACTIVATE`: the window never becomes the foreground window when
    /// the user clicks it, and never takes the keyboard.
    ///
    /// Its own documentation is worth quoting because the behaviour surprises
    /// people: such a window "does not appear on the taskbar by default", and
    /// that is why this is applied to the card and nothing else.
    const WS_EX_NOACTIVATE: isize = 0x0800_0000;

    unsafe extern "system" {
        /// Finds a top-level window by class name and window name.
        ///
        /// Null for either is a wildcard, and both null is meaningless — this is
        /// called with a title only.
        fn FindWindowW(class_name: *const u16, window_name: *const u16) -> Hwnd;
        /// Reads one of a window's style values.
        fn GetWindowLongPtrW(window: Hwnd, index: std::ffi::c_int) -> isize;
        /// Writes one of a window's style values.
        fn SetWindowLongPtrW(window: Hwnd, index: std::ffi::c_int, value: isize) -> isize;
        /// The process that owns a window.
        fn GetWindowThreadProcessId(window: Hwnd, process_id: *mut u32) -> u32;
        /// The process this code is running in.
        fn GetCurrentProcessId() -> u32;
        /// The window that currently has the keyboard, if any.
        fn GetForegroundWindow() -> Hwnd;
        /// Asks the window manager to give the keyboard to a window.
        ///
        /// A request, not a command: the foreground lock lets a background
        /// process through only when the window it asks for belongs to the
        /// foreground process, which the window this card interrupted does. When
        /// it is refused nothing breaks — the card keeps the keyboard for that one
        /// appearance, which is the pre-existing behaviour.
        fn SetForegroundWindow(window: Hwnd) -> std::ffi::c_int;
    }

    /// A null-terminated UTF-16 copy of `text`.
    ///
    /// The platform reads these strings and does not keep them, so a local `Vec`
    /// is enough; the trailing zero is the terminator.
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The window that currently has the keyboard, if any.
    pub fn keyboard_holder() -> Holder {
        // SAFETY: no arguments, no state; the result is an opaque handle the
        // platform only ever compares and passes back to itself.
        unsafe { GetForegroundWindow() as Holder }
    }

    /// This run's suggestion window, if it exists yet.
    ///
    /// `None` while the window is still being created, which is a legitimate
    /// answer rather than an error.
    fn find_own_window(title: &str) -> Option<Hwnd> {
        let name = wide(title);
        // SAFETY: `name` outlives the call, is null-terminated, and the platform
        // neither retains nor writes through it. A null class name is documented
        // as "any class".
        let window = unsafe { FindWindowW(std::ptr::null(), name.as_ptr()) };
        if window.is_null() {
            return None;
        }

        let mut owner: u32 = 0;
        // SAFETY: `window` came from `FindWindowW` and is only read; `owner` is a
        // local the call writes.
        unsafe { GetWindowThreadProcessId(window, &mut owner) };
        // SAFETY: no arguments, no state.
        let mine = unsafe { GetCurrentProcessId() };
        // A title match on a window of another process is the failure this guards
        // against, and doing nothing is the correct response: that window is not
        // this run's card and its styles are not this process's to change.
        if owner != mine {
            return None;
        }
        Some(window)
    }

    /// Marks this run's suggestion window as one that never takes the keyboard,
    /// then gives the keyboard back to whoever held it before the card appeared.
    ///
    /// `restore_to` must be a holder captured *before* the card was shown. Reading
    /// it here instead would find the card, because showing it is what took the
    /// keyboard — the first version of this did exactly that and restored nothing.
    ///
    /// Returns whether the window was found. Applying the style twice is a no-op,
    /// so every show can call this, which is what makes it safe against the window
    /// being recreated.
    pub fn apply(title: &str, restore_to: Holder) -> bool {
        let Some(window) = find_own_window(title) else {
            return false;
        };

        // SAFETY: `window` is a live top-level window of this process and both
        // calls read and write only its style word.
        let style = unsafe { GetWindowLongPtrW(window, GWL_EXSTYLE) };
        if style & WS_EX_NOACTIVATE == 0 {
            // SAFETY: same window; the value adds one documented style bit, and
            // the return value is the previous style, which is not needed.
            unsafe { SetWindowLongPtrW(window, GWL_EXSTYLE, style | WS_EX_NOACTIVATE) };
        }

        // Restored even when the style was already set: a window that was shown
        // once and hidden again comes back through `SW_SHOW` and activates
        // anyway, so the keyboard has to be handed back on every appearance.
        if restore_to != NONE && restore_to != window as Holder {
            // SAFETY: `restore_to` was the foreground window a moment before the
            // card was shown, and this call only asks the window manager to give
            // it the keyboard back.
            unsafe { SetForegroundWindow(restore_to as Hwnd) };
        }

        true
    }
}

/// The window that currently has the keyboard, if any.
///
/// Call this immediately before showing the card and hand the result to
/// [`apply`]: after the show it is the card, and the restore would be a no-op.
/// Returns [`NONE`] on a platform that cannot answer.
pub fn keyboard_holder() -> Holder {
    #[cfg(windows)]
    {
        windows::keyboard_holder()
    }
    #[cfg(not(windows))]
    {
        NONE
    }
}

/// Marks this run's suggestion window as one that never takes the keyboard, and
/// gives the keyboard back to `restore_to`.
///
/// Returns whether there was a window to mark, which is the same shape as
/// [`crate::workarea::work_area`]: a platform that cannot answer says so with
/// `false` and the caller keeps working. Everywhere but Windows this is `false`,
/// and that is honest rather than provisionally wrong — the platforms that can do
/// this expose it differently, and nothing here has been measured on them.
pub fn apply(title: &str, restore_to: Holder) -> bool {
    #[cfg(windows)]
    {
        windows::apply(title, restore_to)
    }
    #[cfg(not(windows))]
    {
        // Named so neither argument is reported as unused on these platforms; an
        // underscore would read as "these do not matter", and they do on the
        // platform this ships to.
        let _ = (title, restore_to);
        false
    }
}
