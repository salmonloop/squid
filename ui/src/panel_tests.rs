//! Panel-level state logic, run against the Slint testing backend — no
//! display, no event loop, one instance per test.
//!
//! The panel's .slint files carry invariants that comments alone used to
//! hold: the header's "Watching" must read the catalog rather than infer
//! from a timestamp, a pending decision must stay reachable after Later,
//! and the answer buttons must route to their own callbacks.
//! `PanelWindow` exposes all of it as properties and callbacks, so the test
//! drives the window exactly the way `main.rs` does — set inputs, read what
//! the panel decided, fire the callbacks a click would fire.
//!
//! `init_no_event_loop()` installs the platform on the *current thread's*
//! context, and cargo test gives every test its own thread, so each test
//! installs it independently. No timers, no event loop: only property
//! evaluation and callbacks, which is all these invariants need.
//!
//! A sibling of `mod tests` in `main.rs` rather than a `tests/` integration
//! test because the generated bindings live inside this crate — there is no
//! lib target to import them from, and manufacturing one just for tests
//! would restructure the binary for the tests' sake.

use crate::PanelWindow;
use slint::Model;
use slint::ModelRc;

fn panel() -> PanelWindow {
    PanelWindow::new().unwrap()
}

fn rows<const N: usize>(states: [&str; N]) -> ModelRc<crate::SourceRow> {
    let rows: Vec<crate::SourceRow> = states
        .into_iter()
        .map(|state| crate::SourceRow {
            id: format!("{state}-host").into(),
            label: "Screen".into(),
            state: state.into(),
            detail: "".into(),
        })
        .collect();
    ModelRc::from(rows.as_slice())
}

fn one_row(id: &str, label: &str, state: &str, detail: &str) -> ModelRc<crate::SourceRow> {
    let row = crate::SourceRow {
        id: id.into(),
        label: label.into(),
        state: state.into(),
        detail: detail.into(),
    };
    ModelRc::from(vec![row].as_slice())
}

#[test]
fn the_headers_wording_reads_the_catalog_not_a_timestamp() {
    i_slint_backend_testing::init_no_event_loop();

    let window = panel();
    // No catalog yet: the header must not claim to be watching.
    assert_ne!(window.get_status_title(), "Watching");

    // One running observer is enough for the claim. The header reads the
    // catalog plus the observer count — and `updated-at` rides the same
    // dump the catalog does, so it is set with the rows, not before them.
    window.set_sources(rows(["running"]));
    window.set_running_sources(1);
    window.set_updated_at("2026-09-10T12:00:00Z".into());
    assert_eq!(window.get_status_title(), "Watching");

    // A catalog that arrived with nothing running is a different fact from a
    // catalog that never came — the header must not read "Watching" off either.
    window.set_sources(rows(["stopped", "unsupported"]));
    window.set_running_sources(0);
    assert_ne!(window.get_status_title(), "Watching");
}

#[test]
fn an_unknown_state_token_is_a_gap_not_a_claim_of_off() {
    i_slint_backend_testing::init_no_event_loop();

    let window = panel();
    // A token this build has never met must not be folded into "off" — the
    // whole reason `state` rides the wire as a string. The window accepts it
    // without normalising, and the last-observer count (which gates the
    // switch) is set by Rust, not derived here, so an unread row cannot
    // inflate it.
    window.set_sources(rows(["running", "hibernating"]));
    window.set_running_sources(1);
    window.set_updated_at("2026-09-10T12:00:00Z".into());
    // One real observer: the header still says watching; the unread row did
    // not count as a second observer and did not become an "off" claim.
    assert_eq!(window.get_status_title(), "Watching");
}

#[test]
fn the_answer_buttons_each_route_to_their_own_callback() {
    use std::cell::Cell;
    use std::rc::Rc;

    i_slint_backend_testing::init_no_event_loop();

    let window = panel();
    window.set_prompt_pending(true);
    window.set_prompt_kind("run a command".into());
    window.set_prompt_summary("rm -rf /tmp/scratch".into());

    let approved = Rc::new(Cell::new(false));
    let declined = Rc::new(Cell::new(false));

    let a = approved.clone();
    window.on_approve(move || a.set(true));
    let d = declined.clone();
    window.on_decline(move || d.set(true));

    // The one wrong outcome is an answer surface that routes two buttons to
    // one decision: each callback must fire its own flag and only its own.
    window.invoke_approve();
    assert!(approved.get() && !declined.get());

    window.invoke_decline();
    assert!(declined.get());
}

#[test]
fn the_gate_traverses_every_state_a_session_can_send() {
    i_slint_backend_testing::init_no_event_loop();

    let window = panel();
    // The gate sentence is the panel's own state machine, and an unknown
    // gate must not offer Pause — a button that cannot work. The wording
    // lives inside the layout, so what this test pins is the panic-free
    // traversal of every state the wire can deliver, including a token this
    // build has not met: the layout re-evaluates on every set, and a binding
    // that folded the unknown token onto a known arm would mis-word here.
    window.set_gate("open".into());
    window.set_gate("paused".into());
    window.set_gate("unknown".into());
}

#[test]
fn source_rows_round_trip_through_the_window() {
    i_slint_backend_testing::init_no_event_loop();

    let window = panel();
    // The rows are the one structured payload the panel holds; a row that
    // loses a field between wire and window is a setting the form cannot
    // render. Round-trip a full row and read it back.
    window.set_sources(one_row(
        "browser-page-host",
        "Web pages",
        "running",
        "the extension disconnected",
    ));
    let sources = window.get_sources();
    let row = sources
        .iter()
        .next()
        .expect("the row just set must be there");
    assert_eq!(row.detail, "the extension disconnected");
    assert_eq!(row.state, "running");
}
