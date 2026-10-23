//! Where the floating suggestion window goes, and whether it can go there at all.
//!
//! The suggestion is the one prompt whose value depends on *when* it is seen: it
//! names text for the field the person is typing in right now. A card inside the
//! resident panel is a suggestion somebody has to go and fetch, so this module
//! answers the only question that matters for such a prompt — the corner of the
//! screen it should appear in — and answers it in arithmetic that can be tested
//! without a display.
//!
//! Two things make this its own module rather than a few lines in `main.rs`.
//!
//! **The geometry is not Slint's to give.** Slint exposes a window's own
//! position and size and nothing else; winit exposes monitors, but a monitor is
//! the *screen*, not the area a window is allowed to occupy once the taskbar
//! and the docks have taken their share. Only the work area is the rectangle a
//! floating card belongs in, and on Windows only the platform knows it. The
//! lookup is therefore platform code, and the arithmetic that consumes it is
//! not: [`bottom_right`] is a pure function of a rectangle and a size, and that
//! is where the tests live.
//!
//! **Placement is a decision, not a coordinate.** A card whose corner is off the
//! screen is worse than a card that never appeared, and a card that appeared
//! without the person being able to reach it is worse still. So the fallback is
//! not "somewhere else on the screen" — it is *not at all*, and the caller sends
//! the prompt to the panel's own card instead. That keeps the panel a complete
//! surface: every prompt has somewhere to be asked, whatever the display can do.

/// A rectangle in physical screen pixels.
///
/// Physical, not logical, because this is what the platform reports and what
/// `Window::set_position` takes. A monitor rectangle scaled by a factor that was
/// applied twice is off by exactly the DPI ratio, which on a 150% display is
/// half the screen — a card in the wrong corner, or off it entirely.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    /// The left edge, in physical pixels from the left of the virtual screen.
    pub x: i32,
    /// The top edge, in physical pixels from the top of the virtual screen.
    pub y: i32,
    /// The width, in physical pixels.
    pub width: u32,
    /// The height, in physical pixels.
    pub height: u32,
}

impl Rect {
    /// The right edge, exclusive.
    ///
    /// Saturating rather than wrapping: a rectangle whose width overflows its
    /// `i32` is a rectangle the platform cannot describe, and a wrapped
    /// coordinate would put the card at the far left of the screen instead of
    /// nowhere.
    pub fn right(self) -> i32 {
        self.x
            .saturating_add(i32::try_from(self.width).unwrap_or(i32::MAX))
    }

    /// The bottom edge, exclusive.
    pub fn bottom(self) -> i32 {
        self.y
            .saturating_add(i32::try_from(self.height).unwrap_or(i32::MAX))
    }

    /// Whether this rectangle describes an area at all.
    ///
    /// A zero-sized or negative-sized work area is not a place a card can be
    /// put, and treating it as one is how a card ends up at `x = 0, y = 0` with
    /// its own body hanging off the left and top edges of the screen.
    pub fn has_area(self) -> bool {
        self.width > 0 && self.height > 0
    }
}

/// How far from the corner the card sits, in logical pixels.
///
/// Not zero: a card flush against the corner of the work area has its own
/// shadow and border half-clipped by the screen edge, which reads as a
/// rendering fault rather than a deliberate position. Sixteen logical pixels is
/// the same inset the panel uses around its own content, so the floating card
/// and the resident panel agree about what "near the edge" means.
///
/// Logical, and therefore scaled before it is subtracted from a rectangle
/// measured in physical pixels. Nothing else here is: leaving it unscaled made
/// the gap *narrower* the higher the DPI, so the card sat tighter to the corner
/// on the 125% display it was measured on than on the 100% one it was designed
/// for — the opposite of what a fixed design distance should do.
pub const CORNER_INSET: i32 = 16;

/// The size of the floating card, in logical pixels.
///
/// Fixed rather than measured, because the card's contents vary with the
/// suggestion it carries and a card that changes width as its text changes
/// would visibly twitch in the corner every time a new suggestion arrives. The
/// width is the one `suggestion.slint` asks for; the height is the card's
/// natural height, which the platform measures.
pub const CARD_WIDTH: i32 = 360;

/// Turns a distance in logical pixels into the physical pixels the work area is
/// measured in.
///
/// One function, called by every place that mixes the two units, because the
/// defect this file kept producing was a scale applied to one number and not to
/// its neighbour: a card scaled but not the inset, an inset scaled but not the
/// measured size. Both are the same arithmetic, so both go through here.
///
/// A scale the platform cannot mean is treated as 1.0 rather than trusted: a zero
/// would size everything to nothing, and a NaN would produce a position that is
/// not a number.
pub fn to_physical(logical: i32, scale: f32) -> i32 {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    (logical as f32 * scale).round() as i32
}

/// Where a card of the given size goes, in the bottom-right corner of `area`.
///
/// Every argument is in physical pixels, and that is the whole contract: the
/// conversions happen once, at the call site that knows whether it is holding a
/// logical size from the `.slint` file or a physical one from a laid-out window.
/// Keeping a `scale` parameter here instead was how the scale came to be applied
/// to the card and not to its inset.
///
/// Returns `None` when the card does not fit, and that is the point of the
/// function: a suggestion that cannot be placed where the person can see it has
/// to be asked somewhere else, not squeezed onto a screen that has no room.
pub fn bottom_right(
    area: Rect,
    card_width: i32,
    card_height: i32,
    inset: i32,
) -> Option<(i32, i32)> {
    if !area.has_area() {
        return None;
    }
    if card_width <= 0 || card_height <= 0 || inset < 0 {
        return None;
    }

    // The card is placed by its top-left corner, which is what
    // `Window::set_position` takes. The bottom-right corner of the card is
    // therefore `right - inset - width`, and the same for the vertical axis.
    let right = area.right() - inset - card_width;
    let bottom = area.bottom() - inset - card_height;

    // Off the work area is off the screen as far as the person is concerned.
    // Returning a position anyway is how a card ends up behind the taskbar or
    // half off the right edge, where it looks like a rendering fault.
    if right < area.x || bottom < area.y {
        return None;
    }

    Some((right, bottom))
}

#[cfg(test)]
mod tests {
    use super::{bottom_right, to_physical, Rect, CARD_WIDTH, CORNER_INSET};

    /// A work area with room to spare, at 100% scaling.
    const ROOMY: Rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };

    /// The card's height in these tests, in logical pixels.
    const CARD_HEIGHT: i32 = 200;

    /// Places the card the way a caller does: both distances converted once.
    ///
    /// Written as a helper rather than repeated in every test because it is the
    /// call shape under test — a card scaled and its inset not is exactly the
    /// defect these tests exist for, and a test that scaled by hand could make
    /// the same mistake the caller did.
    fn place(area: Rect, scale: f32) -> Option<(i32, i32)> {
        bottom_right(
            area,
            to_physical(CARD_WIDTH, scale),
            to_physical(CARD_HEIGHT, scale),
            to_physical(CORNER_INSET, scale),
        )
    }

    /// The card goes in the corner, inset from the work area's edges.
    ///
    /// The exact numbers matter more than the shape: a card at the very corner
    /// is half-clipped by the screen edge, and a card whose bottom edge is
    /// above the bottom of the work area by an unknown amount is a card whose
    /// position nobody can check.
    #[test]
    fn the_card_sits_in_the_bottom_right_corner_inset_from_the_edges() {
        let (x, y) = place(ROOMY, 1.0).expect("the card fits");
        assert_eq!(x, 1920 - CORNER_INSET - CARD_WIDTH);
        assert_eq!(y, 1080 - CORNER_INSET - CARD_HEIGHT);
    }

    /// The card's right and bottom edges clear the work area's own edges.
    ///
    /// Stated as edges rather than as the top-left coordinate, because that is
    /// the thing a person sees: the card must not hang over the right or the
    /// bottom of the screen.
    #[test]
    fn the_card_never_hangs_over_the_right_or_bottom_edge() {
        let (x, y) = place(ROOMY, 1.0).expect("the card fits");
        assert!(x + CARD_WIDTH <= ROOMY.right(), "{x}");
        assert!(y + CARD_HEIGHT <= ROOMY.bottom(), "{y}");
    }

    /// A work area that does not start at the origin is offset by the same
    /// amount.
    ///
    /// A second monitor to the left of the primary is the case this exists for:
    /// its coordinates are negative, and a placement that ignored the offset
    /// would put the card on the other monitor entirely.
    #[test]
    fn a_work_area_that_does_not_start_at_the_origin_is_honoured() {
        let left_monitor = Rect {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let (x, y) = place(left_monitor, 1.0).expect("the card fits");
        assert_eq!(x, left_monitor.x + 1920 - CORNER_INSET - CARD_WIDTH);
        assert_eq!(y, 1080 - CORNER_INSET - CARD_HEIGHT);
        // And it is still on that monitor, not on the one to the right.
        assert!(x >= left_monitor.x, "{x}");
        assert!(x + CARD_WIDTH <= left_monitor.right(), "{x}");
    }

    /// The work area is the *usable* area, so the card clears the taskbar.
    ///
    /// Measured on the development machine: a 2048×1152 display whose work area
    /// is 2048×1104, because the taskbar takes 48 pixels. A card placed against
    /// the bottom of the *screen* rather than the bottom of the work area would
    /// be under the taskbar, where it cannot be seen and cannot be clicked.
    #[test]
    fn the_card_clears_the_taskbar_because_the_work_area_excludes_it() {
        let work = Rect {
            x: 0,
            y: 0,
            width: 2048,
            height: 1104,
        };
        let (_, y) = place(work, 1.0).expect("the card fits");
        assert!(y + CARD_HEIGHT <= work.bottom(), "{y}");
        // 48 pixels of taskbar are below the work area's bottom edge.
        assert!(1152 - (y + CARD_HEIGHT) >= 48, "{y}");
    }

    /// A display that is too small for the card produces no position at all.
    ///
    /// The fallback is the panel's own card, and that only works if this
    /// function refuses rather than guessing.
    #[test]
    fn a_card_that_does_not_fit_has_no_position() {
        let tiny = Rect {
            x: 0,
            y: 0,
            width: 300,
            height: 200,
        };
        assert!(place(tiny, 1.0).is_none());
    }

    /// A work area with no area in it is refused, not treated as the origin.
    ///
    /// The failure this guards against is a platform that reports a zero-sized
    /// work area on a headless session: placing the card at `0, 0` would put it
    /// on top of whatever is there, which is the opposite of helpful.
    #[test]
    fn an_empty_work_area_is_refused() {
        let empty = Rect {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        };
        assert!(place(empty, 1.0).is_none());
    }

    /// Both the card and its inset are distances in logical pixels, so both are
    /// converted.
    ///
    /// A 150% display is the case: the card is 360 logical pixels wide, so it
    /// occupies 540 physical pixels, and a placement that used the logical
    /// number would leave it 180 pixels short of the corner. The inset is 24
    /// physical pixels rather than 16 for the same reason.
    #[test]
    fn the_card_and_its_inset_are_both_scaled() {
        let (x, y) = place(ROOMY, 1.5).expect("the card fits");
        assert_eq!(x, 1920 - 24 - 540);
        assert_eq!(y, 1080 - 24 - 300);
    }

    /// The gap from the corner is the same *visual* distance at every DPI.
    ///
    /// Measured on this repository's development box, a 125% display: an
    /// unscaled inset put the card twelve-and-a-bit logical pixels from the
    /// corner instead of sixteen. Close enough to look deliberate and wrong
    /// enough to be a defect nobody reports, which is why it is a test rather
    /// than a remembered number.
    #[test]
    fn the_corner_gap_is_the_same_visual_distance_at_any_scale() {
        for scale in [1.0f32, 1.25, 1.5, 2.0] {
            let (x, y) = place(ROOMY, scale).expect("the card fits");
            let width = to_physical(CARD_WIDTH, scale);
            let height = to_physical(CARD_HEIGHT, scale);
            let gap_x = (ROOMY.right() - (x + width)) as f32 / scale;
            let gap_y = (ROOMY.bottom() - (y + height)) as f32 / scale;
            assert_eq!(gap_x.round() as i32, CORNER_INSET, "at {scale}");
            assert_eq!(gap_y.round() as i32, CORNER_INSET, "at {scale}");
        }
    }

    /// A scale factor that is not a number does not produce a position that is
    /// not a number.
    ///
    /// The scale comes from the platform, and a zero or negative one means the
    /// card would be sized to nothing. Everything is then sized as if the scale
    /// were one, which is at least a card on the screen.
    #[test]
    fn an_impossible_scale_falls_back_to_one() {
        assert_eq!(to_physical(CARD_WIDTH, 0.0), CARD_WIDTH);
        assert_eq!(to_physical(CARD_WIDTH, -1.0), CARD_WIDTH);
        assert_eq!(to_physical(CARD_WIDTH, f32::NAN), CARD_WIDTH);
        let (x, _) = place(ROOMY, 0.0).expect("the card fits");
        assert_eq!(x, 1920 - CORNER_INSET - CARD_WIDTH);
    }

    /// A size that is not a size is refused rather than placed.
    ///
    /// A card measured before it has been laid out reports zero, and placing
    /// that would put the card's top-left corner at the corner of the screen
    /// with nothing drawn inside it.
    #[test]
    fn a_size_of_nothing_is_refused() {
        assert!(bottom_right(ROOMY, 0, CARD_HEIGHT, CORNER_INSET).is_none());
        assert!(bottom_right(ROOMY, CARD_WIDTH, 0, CORNER_INSET).is_none());
        assert!(bottom_right(ROOMY, -CARD_WIDTH, CARD_HEIGHT, CORNER_INSET).is_none());
        assert!(bottom_right(ROOMY, CARD_WIDTH, CARD_HEIGHT, -CORNER_INSET).is_none());
    }

    /// The inset is a real distance, not a comment.
    ///
    /// A card flush against the boundary of the work area has been placed by a
    /// computer; the point of the inset is that a person recognises the position
    /// as deliberate.
    #[test]
    fn the_card_keeps_its_distance_from_the_work_area_edge() {
        let (x, y) = place(ROOMY, 1.0).expect("the card fits");
        assert_eq!(ROOMY.bottom() - (y + CARD_HEIGHT), CORNER_INSET);
        assert_eq!(ROOMY.right() - (x + CARD_WIDTH), CORNER_INSET);
    }
}
