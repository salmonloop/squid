//! The floating surface an input suggestion is asked on.
//!
//! A suggestion is the one prompt whose value depends on *when* it is seen: it
//! names text for the field the person is typing in right now. The resident
//! panel is a window they put away hours ago, so a card inside it is a
//! suggestion nobody receives. This module owns the second top-level window
//! that answers such a prompt, and the arithmetic that puts it in the corner of
//! the screen.
//!
//! Three decisions are load-bearing, and each of them is a measurement rather
//! than a preference.
//!
//! **It does not take focus.** The suggestion arrives while the person is
//! typing, and a window that steals the keyboard mid-word is worse than no
//! suggestion at all. Measured on the development box: without `ui/src/keyboard.rs`
//! the card becomes the foreground window on *every* show, first and
//! subsequent alike, and the typing it was recommending text for goes to the
//! card's buttons. Slint declares no property for this, so the style bit
//! `WS_EX_NOACTIVATE` is applied to the native window by that module, which also
//! gives the keyboard back after the show that necessarily preceded it.
//!
//! **It is placed before it is shown, and corrected after it is measured.** The
//! corner depends on how tall the card turned out to be, and the card's height
//! depends on how long the suggestion is. The first placement therefore uses the
//! nominal size — so the window's first visible frame is already in the corner
//! rather than at whatever position the windowing system picked — and the
//! second uses the size the card actually reached. A card that appears in the
//! wrong place and then jumps is worse than a card that appears in the right
//! place.
//!
//! **It never becomes the only place a prompt is asked.** Every other kind of
//! prompt stays on the panel's own card, and a suggestion that cannot be placed
//! — no work area, a screen too small for the card — falls back to the panel
//! too. One answer per prompt is structural here: the pending id is taken when
//! the prompt is claimed, so a click on either surface settles the same
//! question, and the other surface's buttons go away.

use std::cell::RefCell;

use slint::{ComponentHandle, SharedString};

use crate::placement::{self, CARD_WIDTH};
use crate::protocol::Prompt;
use crate::SuggestionWindow;

/// The card's height in logical pixels, for the placement made before the card
/// has been measured.
///
/// The card's real height depends on its contents, so this is only the size used
/// to decide whether the card fits at all and where its first frame lands. The
/// second placement uses the height the card actually reached.
const NOMINAL_CARD_HEIGHT: i32 = 200;

/// How long after showing the card is measured again.
///
/// One frame's worth: the layout that turns the nominal height into the real one
/// happens on the first iteration of the event loop after `show`, and that is
/// what this waits out. Deliberately not zero — a zero-delay timer fires in the
/// same iteration, before anything has been measured — and deliberately not a
/// human-scale delay, because until it fires the card sits at an estimated
/// height rather than its own.
const MEASURE_DELAY: std::time::Duration = std::time::Duration::from_millis(16);

/// The state of the floating surface, held on the UI thread.
///
/// A thread-local for the same reason the rest of the panel's view state is
/// one: every reader and writer here is the Slint event loop, and the reader
/// thread cannot hold a reference to it. A mutex would have been a claim about
/// threads that never touch it.
#[derive(Default)]
pub struct Surface {
    /// The window, once it exists.
    ///
    /// Held strongly, which is the whole of the lifetime: the surface is hidden
    /// and shown for every suggestion, and a weak reference kept here would be a
    /// window that lived exactly as long as the `main` binding that created it.
    /// Hiding is what makes it go away, not dropping it.
    ///
    /// `None` on a desktop that could not make the window at all, which is the
    /// one case where a suggestion has nowhere of its own to go and the panel's
    /// card is the whole surface.
    window: RefCell<Option<SuggestionWindow>>,
    /// The timer of the pending post-show correction, if one is armed.
    ///
    /// A `slint::Timer` stops when it is dropped, and the correction has to run
    /// after the call that armed it — so the surface is what keeps it alive.
    /// Holding it here rather than leaking it means arming a second correction
    /// (a new suggestion arriving before the first settled) drops the first,
    /// which is exactly right: the old placement belongs to a card whose text
    /// is no longer on screen.
    correction: RefCell<Option<slint::Timer>>,
}

thread_local! {
    // Built field by field rather than with `Surface::default()`: the
    // `thread_local` initialiser runs in a const context, and a derived `Default`
    // is not a const fn.
    static SURFACE: RefCell<Surface> = const {
        RefCell::new(Surface {
            window: RefCell::new(None),
            correction: RefCell::new(None),
        })
    };
}

/// Runs `body` against the UI thread's suggestion surface.
pub fn with_surface<T>(body: impl FnOnce(&Surface) -> T) -> T {
    SURFACE.with(|surface| body(&surface.borrow()))
}

/// Whether a prompt of this kind belongs on the floating surface.
///
/// The discriminator is the wire's own `kind`, and this is the only place that
/// reads it. `input_suggestion` is the kind the brain sends for a proactive
/// suggestion (`src/input-suggestion.ts`); every other kind is a decision about
/// running something, and those belong on the resident panel where a
/// deliberate answer can be given.
///
/// The check is a prefix rather than an equality so that a future
/// `input_suggestion_with_history` or `input_suggestion.quick` lands on the same
/// surface without a second edit here — the vocabulary is the brain's, and this
/// should not need to know every word in it.
pub fn is_floating_kind(kind: &str) -> bool {
    kind == "input_suggestion" || kind.starts_with("input_suggestion.")
}

/// The card's measured size, in physical pixels, or `None` before it is known.
///
/// The window's own size is the measurement: it is the only one that accounts
/// for the text that is actually in the card.
fn measured_size(window: &slint::Window) -> Option<(i32, i32)> {
    let size = window.size();
    let width = i32::try_from(size.width).ok()?;
    let height = i32::try_from(size.height).ok()?;
    if width <= 0 || height <= 0 {
        return None;
    }
    Some((width, height))
}

/// The scale factor of the window's own display.
///
/// Slint reports this per window, which is what makes a card on a 150% display
/// the right size there and the right size on a 100% one. The work area is in
/// physical pixels, so the two have to be brought into the same space before
/// they are added.
fn scale_factor(window: &slint::Window) -> f32 {
    let factor = window.scale_factor();
    if factor.is_finite() && factor > 0.0 {
        factor
    } else {
        1.0
    }
}

/// Puts the card in the bottom-right corner of the usable area.
///
/// `width` and `height` are already in physical pixels — the unit the work area
/// is measured in and `set_position` takes. They are not scaled here, and that
/// is deliberate: the two callers hold different things. Before the window has
/// been laid out the only size known is the one `suggestion.slint` declares, in
/// logical pixels, so the caller converts it with [`placement::to_physical`];
/// after it, the window reports physical pixels already. Converting in this
/// function as well would apply the DPI twice to one of them, which is the
/// defect this seam was split to prevent.
///
/// Returns whether it could be placed. A card that cannot be placed is not put
/// somewhere approximate: the caller sends the prompt to the panel instead,
/// because a suggestion nobody can see is not a suggestion.
fn place(window: &slint::Window, width: i32, height: i32) -> bool {
    let Some(area) = crate::workarea::work_area() else {
        return false;
    };
    let inset = placement::to_physical(placement::CORNER_INSET, scale_factor(window));
    let Some((x, y)) = placement::bottom_right(area, width, height, inset) else {
        return false;
    };
    window.set_position(slint::WindowPosition::Physical(
        slint::PhysicalPosition::new(x, y),
    ));
    true
}

/// Shows a suggestion on the floating surface.
///
/// Returns whether it was shown. The caller falls back to the panel's own card
/// when this returns false, so every prompt still has a surface — which is why
/// this reports rather than panics.
///
/// Runs on the UI thread, and must: it touches the window and the thread-local
/// that holds it.
pub fn show(prompt: &Prompt) -> bool {
    with_surface(|surface| {
        // A strong clone taken through the `Ref`, which is dropped at the end of
        // this statement. Holding the borrow across the body would be a
        // `RefCell` borrow alive while the window lays itself out and can call
        // back into this module.
        let window = surface
            .window
            .borrow()
            .as_ref()
            .map(ComponentHandle::clone_strong);
        let Some(window) = window else {
            // No floating window in this run — a desktop that could not make
            // one. The panel's card is the whole surface then.
            return false;
        };

        window.set_summary(prompt.summary.as_str().into());
        window.set_why(prompt.why.clone().unwrap_or_default().into());
        window.set_deny_consequence(prompt.deny_consequence.clone().unwrap_or_default().into());
        window.set_expires_at(prompt.expires_at.as_str().into());

        // The first placement, before the window is visible: the nominal size is
        // enough to know whether the card fits, and placing here is what stops
        // the window's first frame from appearing where the windowing system
        // left it. A card that does not fit at its nominal size will not fit at
        // its real one either, so this is also the placeability test.
        let handle = window.window();
        let scale = scale_factor(handle);
        // The one conversion: this size comes from the `.slint` file and is
        // logical; everything `place` touches afterwards is physical.
        let nominal_width = placement::to_physical(CARD_WIDTH, scale);
        let nominal_height = placement::to_physical(NOMINAL_CARD_HEIGHT, scale);
        if !place(handle, nominal_width, nominal_height) {
            return false;
        }

        // Captured *before* the show, and that ordering is the whole point: the
        // show is what takes the keyboard, so reading the holder afterwards finds
        // the card itself and the restore below becomes a no-op. Measured on the
        // development box — that was this module's first version, and the card
        // kept the keyboard.
        let keyboard_holder = crate::keyboard::keyboard_holder();

        if handle.show().is_err() {
            return false;
        }

        // The window exists from here on, so the style can be applied to it. Done
        // after `show` rather than before because a window that has not been
        // created has no native handle to change, and Slint creates it on that
        // call.
        crate::keyboard::apply(crate::keyboard::WINDOW_TITLE, keyboard_holder);

        // The second placement, once the card has a size.
        //
        // The nominal height above is only ever an estimate — laying the text
        // out is what turns it into the answer — so the position the person
        // actually sees settled is this one. It cannot be done inline: a window
        // that has just been shown has not been laid out yet, so
        // `measured_size` would read zero. A posted timer is the wait without
        // blocking, and the event loop is exactly what does the layout.
        //
        // The card shows at the nominal placement for that one frame and then
        // moves by however much the real height differs, which is a fraction of
        // the card moving, not a card appearing in the wrong corner.
        let correction = slint::Timer::default();
        correction.start(slint::TimerMode::SingleShot, MEASURE_DELAY, move || {
            // The closure holds the same strong reference the caller had, so
            // the window is alive whatever the event loop did to the
            // component in between.
            // Measured, so physical already: no conversion, and that is the
            // whole reason `place` takes pixels rather than a scale.
            let handle = window.window();
            if let Some((width, height)) = measured_size(handle) {
                place(handle, width, height);
            }
        });
        // Parked in the surface rather than dropped: `Timer` stops when it is
        // dropped, and this is the one timer that has to outlive the call that
        // armed it. Replacing a previous one is intentional — the card whose
        // text the old correction was measured against is gone.
        *surface.correction.borrow_mut() = Some(correction);

        true
    })
}

/// Hides the floating surface and empties it.
///
/// Also cancels a pending correction: a placement armed for a card that is no
/// longer showing would move the next suggestion's window before that card had
/// text of its own.
///
/// Emptied as well as hidden: a summary left behind is a piece of text the
/// person is about to be asked to type, waiting to reappear in front of buttons
/// that belong to a different suggestion.
pub fn hide() {
    with_surface(|surface| {
        // Dropped rather than only stopped: the placement it was going to make
        // belongs to the text that is about to be cleared.
        *surface.correction.borrow_mut() = None;

        let window = surface
            .window
            .borrow()
            .as_ref()
            .map(ComponentHandle::clone_strong);
        let Some(window) = window else {
            return;
        };
        let _ = window.window().hide();
        window.set_summary(SharedString::new());
        window.set_why(SharedString::new());
        window.set_deny_consequence(SharedString::new());
        window.set_expires_at(SharedString::new());
    });
}

/// Records the floating window this run owns, taking it off the caller.
///
/// Takes the component rather than a reference because the surface is its only
/// long-lived owner: after the first `Later` hides the card, a handle owned by a
/// binding in `main` would be the thing deciding whether it can come back.
pub fn adopt(window: SuggestionWindow) {
    with_surface(|surface| *surface.window.borrow_mut() = Some(window));
}

#[cfg(test)]
mod tests {
    use super::{is_floating_kind, CARD_WIDTH};

    /// The brain's own kind is the floating one.
    #[test]
    fn a_suggestion_is_the_floating_kind() {
        assert!(is_floating_kind("input_suggestion"));
    }

    /// A decision about running something is not.
    ///
    /// This is the whole discrimination: the panel's card is where a
    /// deliberate answer belongs, and a twenty-five-second suggestion is not
    /// one.
    #[test]
    fn other_kinds_stay_on_the_panel() {
        assert!(!is_floating_kind("run_tests"));
        assert!(!is_floating_kind(""));
        assert!(!is_floating_kind("input_suggestion_extra"));
    }

    /// A kind that refines the suggestion stays on the floating surface.
    ///
    /// The vocabulary is the brain's, and this side should not need a second
    /// edit every time the brain grows a word.
    #[test]
    fn a_refined_suggestion_kind_is_still_floating() {
        assert!(is_floating_kind("input_suggestion.quick"));
    }

    /// The width Rust places the card at is the width the card asks for.
    ///
    /// These are two numbers in two files — one in the Slint component, one
    /// here — and a drift between them is a card that is placed as if it were
    /// narrower than it is, which puts its right edge in the middle of the
    /// screen.
    #[test]
    fn the_placed_width_matches_the_card() {
        assert_eq!(CARD_WIDTH, 360);
    }
}
