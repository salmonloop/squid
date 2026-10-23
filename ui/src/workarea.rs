//! The platform half of placement: where the screen's usable area is.
//!
//! [`placement::bottom_right`] decides *where in* the usable area the card goes;
//! this module finds the usable area. The two are separated because only the
//! second one is a platform question, and only the first one is arithmetic worth
//! testing.
//!
//! Why the work area and not the monitor. A monitor is the screen. The work
//! area is the screen minus the taskbar, the docks, and whatever else the
//! desktop has decided to reserve. A card placed against the bottom of the
//! *monitor* on a machine with a taskbar is a card under the taskbar: visible in
//! a screenshot, unreachable in life.
//!
//! Why the platform at all. Neither Slint nor winit exposes a work area. Slint
//! exposes a window's own position and size; winit exposes monitors, which are
//! screens. The one rectangle that means "a window may go here" is the platform's
//! to answer, and on Windows that is `GetMonitorInfoW`.
//!
//! The lookup here is hand-declared Win32 rather than a crate dependency, for
//! the same reason `startup.rs` declares `MessageBoxW` by hand: `windows-sys` is
//! already in the dependency graph underneath Slint, so taking it directly would
//! compile no new code, but it would add a dependency line to a `Cargo.toml`
//! that argues, at length, for having none beyond the renderer. Two `extern`
//! declarations are a smaller thing than that.

use crate::placement::Rect;

/// The work area of the monitor a window is on, in physical pixels.
///
/// Returns `None` when the platform cannot say — which is the honest answer on
/// a headless session, and the answer that makes the caller fall back to the
/// panel's own card rather than guessing at a corner.
#[cfg(windows)]
pub fn work_area() -> Option<Rect> {
    windows::work_area()
}

/// The work area, off Windows: unknown, and said so.
///
/// `None` rather than the whole screen, and the difference matters. Returning the
/// screen would be a guess that a desktop has no panels — true on a bare Xvfb,
/// false on every real Linux desktop, where the card would then open under the
/// GNOME dash or the KDE panel and be unreachable. `None` means "this platform
/// cannot be asked", which the caller turns into the panel's own card: a
/// suggestion a person can find, rather than a plausible number that puts it
/// somewhere they cannot.
///
/// Implementing it is a real piece of work on X11 (read `_NET_WORKAREA` off the
/// root window) and on Wayland it is not permitted at all, so this is honest for
/// now rather than provisionally wrong.
#[cfg(not(windows))]
pub fn work_area() -> Option<Rect> {
    None
}

/// The Win32 calls that answer the question.
#[cfg(windows)]
mod windows {
    use std::ffi::c_void;

    use crate::placement::Rect;

    // Both live in `user32.dll`, which every Windows GUI process already links.
    unsafe extern "system" {
        /// The rectangle of a display, and the rectangle within it that a window
        /// is allowed to occupy.
        ///
        /// `rcMonitor` is the whole display; `rcWork` is the display minus the
        /// taskbar and any other reserved area. `rcWork` is the one this needs:
        /// it is the rectangle a floating card belongs in.
        fn GetMonitorInfoW(monitor: *mut c_void, info: *mut MonitorInfo) -> std::ffi::c_int;
        /// The monitor nearest a point, or the primary one.
        fn MonitorFromPoint(point: Point, flags: u32) -> *mut c_void;
    }

    /// A point in physical screen coordinates.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: std::ffi::c_long,
        y: std::ffi::c_long,
    }

    /// A rectangle in physical screen coordinates.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Rect32 {
        left: std::ffi::c_long,
        top: std::ffi::c_long,
        right: std::ffi::c_long,
        bottom: std::ffi::c_long,
    }

    /// What `GetMonitorInfoW` fills in. The size must be set by the caller, and
    /// the layout must match the platform's exactly — it is a struct, not a
    /// sequence of fields.
    #[repr(C)]
    struct MonitorInfo {
        cb_size: u32,
        rc_monitor: Rect32,
        rc_work: Rect32,
        dw_flags: u32,
    }

    /// `MONITOR_DEFAULTTOPRIMARY`: fall back to the primary monitor when no
    /// monitor contains the point.
    const MONITOR_DEFAULTTOPRIMARY: u32 = 1;

    /// The work area of the primary monitor.
    ///
    /// The origin is the top-left of the virtual screen, so a monitor to the
    /// left of the primary has a negative `left` — and the rectangle is
    /// returned in that same coordinate space, which is what `set_position`
    /// expects.
    pub fn work_area() -> Option<Rect> {
        let mut info = MonitorInfo {
            cb_size: std::mem::size_of::<MonitorInfo>() as u32,
            rc_monitor: Rect32::default(),
            rc_work: Rect32::default(),
            dw_flags: 0,
        };

        // SAFETY: the monitor handle comes from `MonitorFromPoint` and is used
        // only as the opaque handle the platform documented; `info` is a local
        // of exactly the size and layout the call fills in, and `cb_size` tells
        // it so. The call cannot retain either pointer.
        let ok = unsafe {
            let monitor = MonitorFromPoint(Point { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
            GetMonitorInfoW(monitor, &mut info)
        };
        if ok == 0 {
            return None;
        }

        let work = info.rc_work;
        let width = work.right.saturating_sub(work.left);
        let height = work.bottom.saturating_sub(work.top);
        if width <= 0 || height <= 0 {
            return None;
        }

        Some(Rect {
            x: work.left as i32,
            y: work.top as i32,
            width: width as u32,
            height: height as u32,
        })
    }
}
