//! Squid's resident control panel: one native window that shows what the sensors
//! observed, what the agent last did, and the one capture setting the user can
//! change from here.
//!
//! Fed by the watch session over the Unix socket in `docs/panel-protocol.md`.
//! This process is deliberately dumb about policy: it renders the projection it
//! was pushed, reports a click, and computes nothing of its own. A panel that
//! derived its own view of the world would be a second projection to keep in
//! sync with the real one.
//!
//! This replaces the confirmation window, and the window model is inverted. That
//! window was `always-on-top`, existed only while a question was pending, and
//! hid itself on answer — its presence *was* the message, so it ran an event loop
//! with no window in it and showed one on demand. A resident panel that behaved
//! that way would fight every other window all day for a foreground it does not
//! need, so this one is not on top and is visible from launch.
//!
//! There is now a tray icon beside it (`ui/tray.slint`), which answers what the
//! window cannot while it is buried: whether Squid is running, and what it is
//! doing. It does *not* change what closing means. A visible `SystemTrayIcon`
//! keeps the event loop alive by itself, so the close request ends the loop
//! explicitly — the reasoning, and the measurement behind it, is in that file.
//! Closing still declines anything pending either way: that rule is about refusing
//! to leave a live-looking question behind.
//!
//! The two threads and why they exist: connecting and reading block, and
//! blocking the Slint event loop would freeze the window. So a reader thread owns
//! the socket and hands work to the UI thread through `upgrade_in_event_loop`,
//! which is Slint's only sanctioned cross-thread entry point. Slint properties
//! are touched from nowhere else.
//!
//! Nothing here ever writes a line that was not caused by a click. Silence is a
//! refusal — the TypeScript side has its own deadline and treats a missing answer
//! as `timed_out`, never as consent — so every error path in this file is allowed
//! to simply do nothing.

mod protocol;
mod startup;
mod supervisor;
mod transport;

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use protocol::{
    answer_line, config_get_line, config_set_line, control_line, source_get_line,
    source_toggle_line, AgentLine, Answer, ConfigLine, ConfigResultLine, Control, Incoming, Prompt,
    SourceLine, SourceResultLine, WorldState,
};
use slint::{ComponentHandle, ModelRc, Rgba8Pixel, SharedPixelBuffer, SharedString, VecModel};
use startup::Startup;
use transport::Outgoing;

slint::include_modules!();

/// The id of the prompt currently on screen, or `None` when nothing is pending.
///
/// This is the whole correlation mechanism on this side. A click answers *this*
/// id or no id at all, which is what makes it impossible for a stale window to
/// authorize the plan that replaced it. Taking the value out on answer also
/// makes "one answer per prompt" structural rather than a rule to remember.
type Pending = Arc<Mutex<Option<i64>>>;

/// A poisoned lock means another thread panicked while holding this slot, so the
/// pending id can no longer be trusted to name the plan on screen. Answering
/// anyway is the one outcome worse than not answering.
const POISONED: &str = "pending prompt lock poisoned; refusing to answer";

/// How long a session gets to shut itself down before the panel kills it.
///
/// Two seconds is what an ordinary stop needs — closing sources, draining a turn,
/// closing the store — and it is short enough that a user who clicked "Quit Squid"
/// does not conclude nothing happened. The bound matters more than the number: a
/// session that will not stop must not be able to keep the panel open, because the
/// alternative is a window that refuses to close and a user reaching for the task
/// manager, which is where an orphaned brain comes from in the first place.
const STOP_GRACE: Duration = Duration::from_secs(2);

/// Rows collected between a dump's first line and its terminator.
///
/// Lives on the reader thread and holds *protocol* types, not Slint ones: the
/// buffer crosses to the UI thread inside a posted closure, and building the
/// window's own row structs happens there, where the event loop owns them.
///
/// A dump is swapped in whole. Patching rows in place would mean this window
/// keeping its own copy of the catalog and the settings — a second projection to
/// drift out of step with the brain's, which is the one thing the panel has
/// never done.
#[derive(Default)]
struct Dumps {
    settings: Vec<ConfigLine>,
    sources: Vec<SourceLine>,
}

/// The last dump of each kind, kept on the UI thread so a disclosure is local.
///
/// The window shows one capability's settings at a time, and it decides which
/// rows those are by matching the brain's own `group` against the source's own
/// label. Both halves of that match live here rather than in Slint: Slint cannot
/// take a subset of a model, and a filter written there would have needed the
/// panel to recognise setting ids — the one thing the wire's `group` field exists
/// to prevent.
///
/// A thread-local rather than a lock, and that is the load-bearing part: every
/// reader and writer here is the Slint event loop. The reader thread cannot hold
/// a reference to it — `upgrade_in_event_loop` takes a `Send` closure, and this
/// deliberately is not — so the only way to reach it is from inside a closure the
/// event loop is already running. A mutex would have been a claim about threads
/// that never touch it.
#[derive(Default)]
struct ViewState {
    settings: RefCell<Vec<ConfigLine>>,
    sources: RefCell<Vec<SourceLine>>,
    /// The tray icon, once it exists.
    ///
    /// Here rather than passed around because the reader thread is spawned before
    /// the icon is created, so no parameter could reach it, and because everything
    /// that touches the tray already runs on this thread: the window's callbacks,
    /// and the closures `apply` posts. Empty until the tray is built, and empty
    /// forever on a desktop that has no tray host — both of which make every
    /// update below a no-op rather than a branch at each call site.
    tray: RefCell<Option<slint::Weak<SquidTray>>>,
}

thread_local! {
    static VIEW: Rc<ViewState> = Rc::new(ViewState::default());
}

/// Runs `body` against the UI thread's view state.
fn with_view<T>(body: impl FnOnce(&ViewState) -> T) -> T {
    VIEW.with(|state| body(state))
}

/// Puts the status line's own words on the tray icon.
///
/// Read from the window rather than recomputed. `status-title` is published by
/// `panel.slint` from the one expression in `status.slint` that decides what Squid
/// is doing, so the hover text cannot come to a different conclusion than the card
/// four pixels away — which is exactly the failure that expression was last
/// repaired for.
fn refresh_tray(window: &PanelWindow) {
    with_view(|state| {
        if let Some(icon) = state.tray.borrow().as_ref().and_then(slint::Weak::upgrade) {
            icon.set_hover_text(tray_tooltip(&window.get_status_title()).into());
        }
    });
}

/// The hover text: who this is, then what it is doing.
///
/// The name alone when there is no state to report, rather than a dash with
/// nothing after it. An empty title is only reachable before the first binding
/// evaluates, but a tooltip reading "Squid — " would be the window admitting it
/// had lost its own sentence.
fn tray_tooltip(title: &str) -> String {
    if title.is_empty() {
        "Squid".to_string()
    } else {
        format!("Squid — {title}")
    }
}

/// The mark's ink, and the one colour in this binary chosen without asking the
/// theme.
///
/// `theme.slint` answers `Palette.color-scheme` for every other colour, because a
/// panel that stayed light on a dark desktop would be the only window that did. A
/// tray icon cannot: it has no window, so it has no scheme to read, and the
/// taskbar it lands on is light on some systems and dark on others. A single
/// mid-luminance fill is the only value that survives both, so this is picked for
/// luminance rather than for taste.
const TRAY_INK: (u8, u8, u8) = (0x3f, 0xa0, 0x7a);

/// Rendered at 64px and left to the platform to scale down.
///
/// Every host asks for a different size — 16 and 32 on Windows depending on DPI,
/// 22-ish on Linux, a menu-bar height on macOS — and Slint's own documentation
/// says the image is scaled by the platform. One buffer larger than any of them
/// scales down cleanly; the reverse does not.
const TRAY_ICON_SIZE: u32 = 64;

/// The tray mark, drawn rather than shipped.
///
/// No image file, for two reasons. The repository has no asset pipeline and no
/// binary in it, so a PNG would be a blob whose source lived nowhere. And the
/// shape is small enough that code *is* the source: a dome and three tapering
/// tentacles, which is what a squid reduces to at sixteen pixels.
///
/// Supersampled rather than hard-edged, because the platform scales this down and
/// an aliased 64px mark resamples into a smudge.
fn tray_mark(size: u32) -> SharedPixelBuffer<Rgba8Pixel> {
    const SAMPLES: u32 = 4;
    let mut buffer = SharedPixelBuffer::<Rgba8Pixel>::new(size, size);
    let pixels = buffer.make_mut_slice();
    for y in 0..size {
        for x in 0..size {
            let mut covered = 0_u32;
            for sub_y in 0..SAMPLES {
                for sub_x in 0..SAMPLES {
                    let fx = tray_sample(x, sub_x, size, SAMPLES);
                    let fy = tray_sample(y, sub_y, size, SAMPLES);
                    if in_tray_mark(fx, fy) {
                        covered += 1;
                    }
                }
            }
            pixels[(y * size + x) as usize] = Rgba8Pixel {
                r: TRAY_INK.0,
                g: TRAY_INK.1,
                b: TRAY_INK.2,
                a: (covered * 255 / (SAMPLES * SAMPLES)) as u8,
            };
        }
    }
    buffer
}

/// One subsample's position, in a square that runs -1 to 1 in both directions.
fn tray_sample(pixel: u32, sub: u32, size: u32, samples: u32) -> f32 {
    ((pixel * samples + sub) as f32 + 0.5) / (size * samples) as f32 * 2.0 - 1.0
}

/// Whether a point is inside the mark.
fn in_tray_mark(x: f32, y: f32) -> bool {
    // The dome, wider than tall so it reads as a head rather than a ball.
    if (x / 0.60).powi(2) + ((y + 0.22) / 0.52).powi(2) <= 1.0 {
        return true;
    }
    // Three tentacles, starting inside the dome so they join it rather than
    // hanging under it, and tapering so the silhouette is not a comb.
    if !(0.10..=0.86).contains(&y) {
        return false;
    }
    let half_width = 0.115 * (1.0 - (y - 0.10) / 0.76 * 0.75);
    [-0.34_f32, 0.0, 0.34]
        .into_iter()
        .any(|centre| (x - centre).abs() <= half_width)
}

fn tray_icon() -> slint::Image {
    slint::Image::from_rgba8(tray_mark(TRAY_ICON_SIZE))
}

/// The one line `--version` prints, and the only place the binary names itself.
///
/// `env!` is compile-time: the string is baked in from `ui/Cargo.toml` at the
/// moment this binary was built — exactly the value the release pipeline's
/// `version` job reconciled against the tag. A binary that reports a version
/// can therefore only report the one it was actually built from; there is no
/// runtime copy that could drift away from the release it shipped in.
fn version_line() -> String {
    format!("squid-ui {}", env!("CARGO_PKG_VERSION"))
}

/// How this run got its endpoint, which decides whether the panel supervises.
///
/// Two shapes rather than a bool plus a path, so a caller cannot ask for the
/// brain's executable in attached mode: there is no brain to name there, because
/// this process did not start the session and has no business claiming a state
/// for it.
enum Launch {
    /// `SQUID_PANEL_SOCKET` named an endpoint; a session owns it.
    Attached(PathBuf),
    /// This panel is the entry point. It computed the endpoint and either found a
    /// session already there (`brain: None`) or is about to start one.
    Supervising {
        endpoint: PathBuf,
        /// `None` when the probe found a live session: the panel attaches to it
        /// and supervises nothing, because a brain somebody else started is not
        /// this process's to restart or to report a state for.
        brain: Option<PathBuf>,
    },
}

impl Launch {
    fn endpoint(&self) -> &Path {
        match self {
            Self::Attached(endpoint) => endpoint,
            Self::Supervising { endpoint, .. } => endpoint,
        }
    }

    /// The brain this run is responsible for, if any. Drives the window's
    /// `supervised` flag, which is what puts the Restart button on screen — the
    /// brain refuses a restart it is not supervised for, so the button appears
    /// exactly where it can work.
    fn brain(&self) -> Option<&Path> {
        match self {
            Self::Attached(_) => None,
            Self::Supervising { brain, .. } => brain.as_deref(),
        }
    }
}

/// Works out how a double-clicked panel should proceed.
///
/// Order matters and is the double-start guard: probe first, spawn second. A
/// session already listening — started by hand, by a previous panel, or by the
/// packaged `squid` — is attached to rather than duplicated, because
/// `Bun.listen({ unix })` does not reliably report `EADDRINUSE` and two brains on
/// one endpoint split connections unpredictably.
///
/// The error case is a missing sibling binary, which is the one failure a user
/// can act on: it means the zip was unpacked incompletely or the panel was
/// copied out of it alone.
fn supervising_launch() -> Result<Launch, String> {
    let endpoint = supervisor::default_endpoint(std::env::var("XDG_RUNTIME_DIR").ok().as_deref());
    let endpoint = PathBuf::from(endpoint);

    // Probe before looking for the binary: if a session is already up, a missing
    // `squid` beside this panel is not a problem worth reporting — there is
    // nothing to start.
    if supervisor::session_is_listening(&endpoint) {
        return Ok(Launch::Supervising {
            endpoint,
            brain: None,
        });
    }

    let panel_exe = std::env::current_exe()
        .map_err(|error| format!("could not locate this binary: {error}"))?;
    let brain = supervisor::brain_executable_path(&panel_exe);
    if !brain.is_file() {
        return Err(format!(
            "no session is running, and the `squid` binary is not next to this one \
             (looked for {}). The release zip ships them side by side; unpack both.",
            brain.display()
        ));
    }
    Ok(Launch::Supervising {
        endpoint,
        brain: Some(brain),
    })
}

/// Returns `()` rather than `Result`, because there is no failure here worth/// Returns `()` rather than `Result`, because there is no failure here worth
/// printing the way `Result` from `main` prints one: `Err` out of `main` reaches
/// the user as a one-line `Debug` rendering on a stderr that a double-clicked
/// console binary is about to close. Every exit path goes through
/// `startup::abort`, which is the only thing that gets seen in that case.
fn main() {
    // Before anything else, including the socket check: a binary asked what it
    // is must answer even with no environment to speak of. `--version` is also
    // the only argument this process has ever read; the rest stay ignored, as
    // they always were.
    if std::env::args()
        .skip(1)
        .any(|argument| argument == "--version")
    {
        println!("{}", version_line());
        return;
    }

    // The startup fork, and the inversion issue #23 asked for.
    //
    // `SQUID_PANEL_SOCKET` set is the shape the panel has always had: a session
    // exists and this is its second display. Unset used to be a refusal — the
    // panel exited 2 and explained it was a client. Now it means "the user
    // double-clicked me", which is the ordinary way in: compute the endpoint the
    // brain would listen on, and take over starting it.
    let launch = match transport::endpoint_setting() {
        transport::EndpointSetting::Named(path) => Launch::Attached(path),
        // Set but empty: a launcher that lost the value. Refused rather than
        // treated as a double-click, because guessing which was meant is how a
        // broken script comes to look like an intentional entry point.
        transport::EndpointSetting::Empty => startup::abort(Startup::Unconfigured),
        transport::EndpointSetting::Unset => match supervising_launch() {
            Ok(launch) => launch,
            Err(reason) => startup::abort(Startup::NoBrain(reason)),
        },
    };
    let socket_path = launch.endpoint().to_path_buf();
    // The endpoint as the brain's environment will spell it, taken before the
    // reader thread takes ownership of the path itself.
    let endpoint_text = socket_path.to_string_lossy().into_owned();

    // Not `?`: a window that cannot be created is the other startup failure a
    // user meets as a vanishing black box, and it is the one whose cause —
    // no display, no OpenGL — is least guessable from the outside.
    let window = match PanelWindow::new() {
        Ok(window) => window,
        Err(error) => startup::abort(Startup::Platform(error.to_string())),
    };
    let pending: Pending = Arc::new(Mutex::new(None));
    // One outgoing half, shared. The reader thread hands it a socket on connect
    // and takes it back on disconnect; the callbacks below only ever write.
    let outgoing = Outgoing::new();

    // Only a run that started its own brain offers to restart it. The brain
    // refuses `op:"restart"` unless it is supervised, so showing the button in
    // attached mode would be selling a switch that does nothing.
    window.set_supervised(launch.brain().is_some());

    {
        let outgoing = outgoing.clone();
        window.on_pause(move || outgoing.send(&control_line(Control::Pause)));
    }
    {
        let outgoing = outgoing.clone();
        window.on_resume(move || outgoing.send(&control_line(Control::Resume)));
    }
    {
        let outgoing = outgoing.clone();
        // The typed value goes out as it was typed. Whether it is legal is the
        // brain's answer, and it comes back as a `config_result`; validating here
        // would be a second rule set to disagree with the one that writes the
        // file. The API key's single trip across this wire is this line.
        window.on_save_setting(move |id, value| outgoing.send(&config_set_line(&id, &value)));
    }
    {
        let outgoing = outgoing.clone();
        // Asks; does not assume. The row's checkbox has already moved because
        // that is what a checkbox does, but nothing here records a new state —
        // the verdict triggers a fresh dump, and the dump decides.
        window.on_toggle_source(move |id, on| outgoing.send(&source_toggle_line(&id, on)));
    }
    {
        let outgoing = outgoing.clone();
        window.on_refresh(move || {
            outgoing.send(&config_get_line());
            outgoing.send(&source_get_line());
        });
    }
    {
        // Opening a capability's settings is entirely local: the rows are already
        // here from the last dump, so a disclosure costs no round trip and cannot
        // fail. Toggling closed is the same call with the same name, which is why
        // one control both opens and closes a door.
        let handle = window.as_weak();
        window.on_select_group(move |group| {
            let Some(window) = handle.upgrade() else {
                return;
            };
            let next = if window.get_open_group() == group {
                SharedString::new()
            } else {
                group
            };
            window.set_open_group(next);
            refresh_groups(&window);
        });
    }
    {
        let outgoing = outgoing.clone();
        // Reachable while `supervised` is set, which a panel-first run sets from
        // `launch.brain()`. The brain refuses `op:"restart"` unless it sees
        // `SQUID_SUPERVISED`, so an attached panel's button is hidden and the
        // request would be refused anyway — two independent guards on the one
        // operation that exits a healthy process on purpose.
        window.on_restart_service(move || outgoing.send(&control_line(Control::Restart)));
    }
    {
        let pending = Arc::clone(&pending);
        let outgoing = outgoing.clone();
        let handle = window.as_weak();
        window.on_approve(move || answer(&pending, &outgoing, &handle, Answer::Approved));
    }
    {
        let pending = Arc::clone(&pending);
        let outgoing = outgoing.clone();
        let handle = window.as_weak();
        window.on_decline(move || answer(&pending, &outgoing, &handle, Answer::Declined));
    }

    // Closing the panel is a decline of anything pending, not a hang.
    //
    // Both are refusals, so either is safe. Declining is the better one: the
    // engine's queue is serial, and a prompt that waits out its full timeout
    // holds every later candidate behind it. Shutting the panel should not cost
    // the next suggestion its turn.
    {
        {
            // Closing is "put away", not "end". The tray menu is measured to
            // export on Linux (see `ui/tray.slint`), so a hidden window still has
            // a way back and a way out of its own interface. Nothing here answers
            // a pending prompt: hiding changes nothing about the conversation,
            // the same way walking away from an open window does not, and the
            // engine's confirmation timeout is what an unanswered prompt meets.
            // On a desktop with no tray host the loop dies with the hidden
            // window — the pre-tray behavior, needing no code here. (Kept by
            // Slint's keepalive counter: `Window::hide` releases it, and a
            // live tray handle acquired one. See `AGENTS.md`'s tray section
            // for what this box can and cannot measure of that chain.)
            window
                .window()
                .on_close_requested(|| slint::CloseRequestResponse::HideWindow);
        }
    }

    {
        let pending = Arc::clone(&pending);
        let outgoing = outgoing.clone();
        let handle = window.as_weak();
        // `transport::run` never returns: it reconnects instead. A dropped
        // watch session must not end the panel, and it must not clear what is on
        // screen either — the last known reading, dated by `updated-at`, is the
        // honest thing to keep showing. Blanking the fields on disconnect would
        // make a lost connection look like a quiet machine.
        //
        // Keeping the reading is only honest if something says it is no longer
        // live, which is what `link-lost` is for. It marks the reading stale
        // rather than erasing it, so the two failures stay distinguishable: a
        // quiet machine still shows its last reading with no warning, and a lost
        // session shows the same reading with one.
        thread::spawn(move || {
            // The buffers live in this closure: one connection's dumps, torn down
            // with the closure if this thread ever ends. `transport::run` calls
            // this for every message on this thread, so no lock is needed to
            // accumulate — and nothing Slint-owned is touched until a terminator
            // posts a finished dump to the event loop.
            let mut dumps = Dumps::default();
            let link_handle = handle.clone();
            transport::run(
                &socket_path,
                &outgoing,
                |message| apply(&handle, &pending, &outgoing, &mut dumps, message),
                move |connected| {
                    let _ = link_handle.upgrade_in_event_loop(move |window| {
                        window.set_link_lost(!connected);
                        // Refreshed here as well as in `apply`, because losing the
                        // link is the one state change no message follows — that
                        // is what it means — and it is also the one a person with
                        // the window closed most needs the tooltip to admit.
                        refresh_tray(&window);
                    });
                },
            )
        });
    }

    // The supervision thread, when this run owns a brain. Its own thread because
    // `wait()` blocks, and the state changes hop to the UI thread the same way
    // the reader's messages do — nothing here touches a Slint property directly.
    //
    // The thread outliving its usefulness is fine: `supervise` returns when the
    // brain should not be restarted again, having reported why, and the panel
    // stays up showing that. A window that vanished with its child would be the
    // failure supervising mode exists to prevent.
    // The grip on that brain, shared with the tray so leaving can end it. `None`
    // for an attached panel: a session this run did not start is not its to stop.
    let supervision: Option<Arc<supervisor::Supervision>> = launch
        .brain()
        .map(|_| Arc::new(supervisor::Supervision::default()));
    if let Some(brain) = launch.brain() {
        let brain = brain.to_path_buf();
        let endpoint = endpoint_text.clone();
        let supervising = Arc::clone(
            supervision
                .as_ref()
                .expect("a run with a brain has a supervision handle"),
        );
        // Idle until the first spawn reports: the window opens before the child
        // exists, and "running" written optimistically here would be a claim about
        // a process that has not been created yet.
        window.set_service_state(supervisor::ServiceState::Idle.label().into());
        start_supervision(
            window.as_weak(),
            brain.clone(),
            endpoint.clone(),
            Arc::clone(&supervising),
        );

        // Recovering from a tripped crash guard. `supervise` returns once it will
        // not spawn again, which left the panel showing `failed` with no way
        // forward: the Restart button writes to a socket that by then has no
        // brain on it, and an unconnected write is dropped rather than queued. So
        // the guard's terminal decision ends a *round* of supervision, and this
        // starts a new one with a fresh crash log.
        //
        // Only from `failed`, and that is the whole guard: while a round is live
        // the button is hidden, so a second thread cannot race the first for the
        // endpoint. The user asking again is also the signal the guard was
        // waiting for — three crashes in a minute means "stop trying until a
        // human looks", not "never again".
        let handle = window.as_weak();
        window.on_start_service(move || {
            let Some(window) = handle.upgrade() else {
                return;
            };
            if window.get_service_state() != supervisor::ServiceState::FAILED_LABEL {
                return;
            }
            window.set_service_state(supervisor::ServiceState::Idle.label().into());
            window.set_service_detail(SharedString::new());
            start_supervision(
                window.as_weak(),
                brain.clone(),
                endpoint.clone(),
                Arc::clone(&supervising),
            );
        });
    }

    // The tray, and with it the process's new lifetime.
    //
    // Created after every window callback is wired, because it can end the loop:
    // `Quit Squid` must find a panel that can already answer a pending prompt.
    // Held in a binding rather than dropped — the icon exists exactly as long as
    // this value does — and its failure is the same class as a window that would
    // not open, except that it must not be fatal: a desktop with no tray host is
    // a desktop where the panel still works.
    let _tray = match SquidTray::new() {
        Ok(tray) => {
            tray.set_icon_image(tray_icon());
            tray.set_hover_text(tray_tooltip(&window.get_status_title()).into());
            {
                let handle = window.as_weak();
                // The way back in. The window exists for the whole run — hiding
                // it never drops it — so showing again is all "put away" needs
                // to be undone. Fails only if the loop is already ending, which
                // is not a state worth reporting.
                tray.on_show(move || {
                    if let Some(window) = handle.upgrade() {
                        let _ = window.window().show();
                    }
                });
            }
            {
                let pending = Arc::clone(&pending);
                let outgoing = outgoing.clone();
                let handle = window.as_weak();
                let supervision = supervision.clone();
                // Leaving is a refusal, exactly as a declined prompt is. The
                // engine hears `declined` rather than waiting out a deadline for
                // an answer nobody is left to give.
                //
                // And leaving ends the session this run started. "Quit Squid" used
                // to end only the window: the brain kept observing the desktop and
                // kept calling a model, with no window and no tray icon left to
                // say it was there. Asked over the wire first, because the brain
                // closes its store and its session history on its own shutdown
                // path; killed after the grace, because a wedged session must not
                // be able to keep the panel open. An attached panel has no handle
                // here and sends nothing — that session belongs to whoever started
                // it.
                tray.on_quit(move || {
                    answer(&pending, &outgoing, &handle, Answer::Declined);
                    if let Some(supervision) = supervision.as_ref() {
                        outgoing.send(&control_line(Control::Stop));
                        supervision.stop_within(STOP_GRACE);
                    }
                    let _ = slint::quit_event_loop();
                });
            }
            with_view(|state| *state.tray.borrow_mut() = Some(tray.as_weak()));
            Some(tray)
        }
        Err(error) => {
            eprintln!("squid-ui: no system tray on this desktop: {error}");
            None
        }
    };

    // Not an ordinary `run()` any more: with a visible tray, hiding the window no
    // longer ends the loop. That is the point — the old note here said a hidden
    // window keeping the process alive "is a shape this panel does not have", and
    // adding the tray is precisely the decision to have it.
    //
    // A failure here is the same class as a failure to create the window — the
    // display went away, or the loop could not start — and reaches a
    // double-clicked user through the same console that is about to close, so it
    // is reported the same way rather than returned.
    if let Err(error) = window.run() {
        startup::abort(Startup::Platform(error.to_string()));
    }
}

/// Runs one round of supervision on its own thread, reporting each state change
/// to the window.
///
/// Its own thread because `wait()` blocks and blocking the Slint event loop
/// would freeze the window this exists to keep informative. Nothing here touches
/// a Slint property directly: every state change hops to the UI thread the same
/// way the transport reader's messages do.
///
/// "One round" is the unit because a tripped crash guard ends supervision rather
/// than the process — `supervise` returns, having reported why, and the panel
/// stays up showing it. Starting a second round is how the user says "I have
/// looked at it, try again", which is exactly the signal the guard was holding
/// out for.
fn start_supervision(
    handle: slint::Weak<PanelWindow>,
    brain: PathBuf,
    endpoint: String,
    supervision: Arc<supervisor::Supervision>,
) {
    thread::spawn(move || {
        supervisor::supervise(&brain, &endpoint, &supervision, |state| {
            let label = state.label().to_owned();
            let detail = state.detail();
            let _ = handle.upgrade_in_event_loop(move |window| {
                window.set_service_state(label.into());
                window.set_service_detail(detail.into());
            });
        });
    });
}

/// Moves one message onto the UI thread and applies it.
///
/// Called on the reader thread, so every property write is inside the posted
/// closure. A failure to post means the event loop is gone, which means the
/// process is already on its way out — there is nothing left to show and nothing
/// to report it to.
fn apply(
    window: &slint::Weak<PanelWindow>,
    pending: &Pending,
    outgoing: &Outgoing,
    dumps: &mut Dumps,
    message: Incoming,
) {
    match message {
        Incoming::WorldState(state) => {
            let _ = window.upgrade_in_event_loop(move |window| show_world(&window, state));
        }
        Incoming::Agent(agent) => {
            let _ = window.upgrade_in_event_loop(move |window| show_agent(&window, agent));
        }
        Incoming::Prompt(prompt) => show_prompt(window, pending, prompt),
        Incoming::Cancel { prompt_id } => cancel(window, pending, prompt_id),
        Incoming::AgentThinking { thinking } => {
            let _ = window.upgrade_in_event_loop(move |window| {
                window.set_agent_thinking(thinking);
            });
        }
        Incoming::AgentTriggers {
            triggered,
            excluded,
            duplicate,
            coalesced,
            last,
        } => {
            let _ = window.upgrade_in_event_loop(move |window| {
                window.set_turns_triggered(count(Some(triggered)));
                window.set_turns_excluded(count(Some(excluded)));
                window.set_turns_duplicate(count(Some(duplicate)));
                window.set_turns_coalesced(count(Some(coalesced)));
                window.set_last_disposition(text(last));
            });
        }
        Incoming::Service { agent_state } => {
            let _ = window.upgrade_in_event_loop(move |window| {
                window.set_agent_state(agent_state.into());
            });
            // This line *is* the connect signal. The brain replays it to every
            // client as it attaches — that is the whole reason it exists as a
            // standing fact rather than a one-off broadcast — so the panel asks
            // for its two dumps here instead of the transport growing an
            // on-connect hook that would mean the same thing twice.
            //
            // It also arrives when the brain leaves `needs_config` mid-session,
            // where re-pulling is exactly right: the model keys just changed.
            outgoing.send(&config_get_line());
            outgoing.send(&source_get_line());
        }
        Incoming::Config(row) => dumps.settings.push(row),
        Incoming::ConfigEnd { count } => {
            // Taken, not cloned: the next dump starts empty, so a refresh cannot
            // append to the last one and show every setting twice.
            let rows = std::mem::take(&mut dumps.settings);
            let _ = window.upgrade_in_event_loop(move |window| show_settings(&window, rows, count));
        }
        Incoming::ConfigResult(result) => {
            let refresh = result.id.is_some();
            let _ = window.upgrade_in_event_loop(move |window| {
                window.set_status(config_verdict(&result).into());
            });
            // Re-read after a per-key verdict: a save can change `value` and can
            // clear or set `overridden`, and the honest way to show that is the
            // brain's own dump rather than this side patching the row it just
            // sent.
            //
            // Only when the verdict named a key. A dump-level refusal carries no
            // id, and asking again in response to it would answer itself forever.
            if refresh {
                outgoing.send(&config_get_line());
            }
        }
        Incoming::Source(row) => dumps.sources.push(row),
        Incoming::SourceEnd { count } => {
            let rows = std::mem::take(&mut dumps.sources);
            let _ = window.upgrade_in_event_loop(move |window| show_sources(&window, rows, count));
        }
        Incoming::SourceResult(result) => {
            let refresh = result.id.is_some();
            let _ = window.upgrade_in_event_loop(move |window| {
                window.set_status(source_verdict(&result).into());
            });
            // The verdict says whether the toggle landed, never what the catalog
            // now looks like — so the state on screen comes from a fresh dump. A
            // refused stop (the last observer) rebuilds the row still running,
            // which is the truth the checkbox owes the user.
            if refresh {
                outgoing.send(&source_get_line());
            }
        }
    }

    // One more hop, after whatever the branch above posted. Posted closures run
    // in order, so this reads the window the user is now looking at rather than
    // the one before the message landed. Cheap enough to do unconditionally:
    // working out which messages can move the status line would be a second copy
    // of the state machine's inputs, kept in agreement by hand.
    let _ = window.upgrade_in_event_loop(|window| refresh_tray(&window));
}

/// Replaces the settings form with a dump.
///
/// The count is read, not ignored: `parse_incoming` drops a row it cannot parse,
/// so a dump can arrive one row short with nothing else to show it. A user who
/// reads a missing key as "not a setting" would be misled by silence, so the
/// shortfall is stated in the status line.
///
/// The rows are also kept, not just projected. The panel shows one group's
/// settings at a time, and re-asking the brain for the whole dump every time a
/// door opens would make a local disclosure a round trip.
fn show_settings(window: &PanelWindow, rows: Vec<ConfigLine>, count: i64) {
    let note = dump_note("settings", rows.len(), count);
    let form: Vec<SettingRow> = rows.iter().map(setting_row).collect();
    with_view(|state| *state.settings.borrow_mut() = rows);
    window.set_settings(ModelRc::new(VecModel::from(form)));
    refresh_groups(window);
    if let Some(note) = note {
        window.set_status(note.into());
    }
}

/// One wire row as the window's own struct.
///
/// Everything optional collapses to a value that reads as "not stated" rather
/// than as a claim: an absent `group` puts the setting in no capability's door,
/// and an absent `secretPresent` says only that no credential could be read —
/// which is weaker than "none was ever set", because the brain's read cannot
/// tell an empty store from one it may not open, and `ui/settings.slint` is
/// where that distinction has to survive into words. Anything but an
/// explicit `1` on either flag is treated as false, because both are disclosures
/// and asserting one from a malformed field is worse than leaving it off.
fn setting_row(row: &ConfigLine) -> SettingRow {
    SettingRow {
        id: row.id.clone().into(),
        label: row.label.clone().into(),
        kind: row.kind.clone().into(),
        value: row.value.clone().into(),
        applies: row.applies.clone().into(),
        overridden: row.overridden == Some(1),
        values: row.values.clone().unwrap_or_default().into(),
        group: row.group.clone().unwrap_or_default().into(),
        description: row.description.clone().unwrap_or_default().into(),
        secret_present: row.secret_present == Some(1),
    }
}

/// Recomputes the group list, the open group's rows, and the running count.
///
/// Both dumps feed this, so it runs after either one lands. The group list is
/// the distinct `group` values in dump order with any group a source card
/// already owns removed — a capability's settings belong behind that capability,
/// and listing them twice would make the second copy the "advanced" pile this
/// design exists to avoid.
fn refresh_groups(window: &PanelWindow) {
    with_view(|state| refresh_groups_from(window, state));
}

fn refresh_groups_from(window: &PanelWindow, state: &ViewState) {
    let settings = state.settings.borrow();
    let sources = state.sources.borrow();

    let owned_by_a_source: Vec<&str> = sources.iter().map(|row| row.label.as_str()).collect();
    let mut groups: Vec<SharedString> = Vec::new();
    for row in settings.iter() {
        let Some(group) = row.group.as_deref() else {
            continue;
        };
        if group.is_empty() || owned_by_a_source.contains(&group) {
            continue;
        }
        if groups.iter().any(|seen| seen.as_str() == group) {
            continue;
        }
        groups.push(group.into());
    }
    window.set_setting_groups(ModelRc::new(VecModel::from(groups)));

    let open = window.get_open_group();
    let rows: Vec<SettingRow> = settings
        .iter()
        .filter(|row| row.group.as_deref() == Some(open.as_str()))
        .map(setting_row)
        .collect();
    window.set_group_settings(ModelRc::new(VecModel::from(rows)));

    window.set_running_sources(
        sources
            .iter()
            .filter(|row| row.state == "running")
            .count()
            .try_into()
            .unwrap_or(i32::MAX),
    );
}

/// Replaces the source list with a dump. Same swap-whole discipline as
/// [`show_settings`], and the same reason for reading the count.
fn show_sources(window: &PanelWindow, rows: Vec<SourceLine>, count: i64) {
    let note = dump_note("sources", rows.len(), count);
    let list: Vec<SourceRow> = rows
        .iter()
        .map(|row| SourceRow {
            id: row.id.clone().into(),
            label: row.label.clone().into(),
            state: row.state.clone().into(),
            // None reads as empty on purpose: the card treats an empty detail
            // as "nothing to report" and renders nothing, which is exactly the
            // claim an absent field makes.
            detail: row.detail.clone().unwrap_or_default().into(),
        })
        .collect();
    with_view(|state| *state.sources.borrow_mut() = rows);
    window.set_sources(ModelRc::new(VecModel::from(list)));
    refresh_groups(window);
    if let Some(note) = note {
        window.set_status(note.into());
    }
}

/// Complains when a dump's rows and its own count disagree, and says nothing
/// when they match — the ordinary case must not produce a status line.
fn dump_note(kind: &str, arrived: usize, count: i64) -> Option<String> {
    if i64::try_from(arrived).ok() == Some(count) {
        return None;
    }
    Some(format!(
        "Showing {arrived} {kind} rows, but the session counted {count}; this list is incomplete."
    ))
}

/// The status line for one settings verdict, in the brain's words.
///
/// The error text is already sanitized upstream and names the key and the reason,
/// so it is reported verbatim. The `ok` cases are this side's only sentences, and
/// they exist because "saved" and "saved, but not in effect yet" are different
/// facts that a user acting on the value needs told apart.
fn config_verdict(result: &ConfigResultLine) -> String {
    let subject = result.id.clone().unwrap_or_else(|| "settings".to_owned());
    if result.ok != 1 {
        return match &result.error {
            Some(error) => error.clone(),
            None => format!("{subject} was refused."),
        };
    }
    match result.applies.as_deref() {
        Some("restart") => format!("Saved {subject}. It takes effect when the session restarts."),
        _ => format!("Saved {subject}."),
    }
}

/// The status line for one toggle verdict, same discipline as
/// [`config_verdict`]: refusals are quoted, successes are stated plainly.
fn source_verdict(result: &SourceResultLine) -> String {
    let subject = result.id.clone().unwrap_or_else(|| "sources".to_owned());
    if result.ok != 1 {
        return match &result.error {
            Some(error) => error.clone(),
            None => format!("{subject} was refused."),
        };
    }
    format!("{subject} updated.")
}

/// Applies a `world_state` line. One property per wire field, nothing derived.
fn show_world(window: &PanelWindow, state: WorldState) {
    window.set_updated_at(state.updated_at.into());
    window.set_last_event(text(state.last_event));
    window.set_application(text(state.application));
    window.set_window_title(text(state.window));
    window.set_gate(text(state.gate));
    window.set_selection_length(count(state.selection_length));
    window.set_recent_actions(text(state.recent_actions));
    window.set_episode_events(count(state.episode_events));
}

/// Applies an `agent` line.
fn show_agent(window: &PanelWindow, agent: AgentLine) {
    window.set_agent_at(agent.at.into());
    window.set_agent_status(agent.status.into());
    window.set_agent_text(text(agent.text));
}

/// An absent string becomes `""`, which `panel.slint` renders as `—`.
///
/// "Nothing observed yet" is a real state and the protocol omits the field to say
/// so, so the placeholder is carried through rather than filled in. Inventing a
/// value here would be reporting an observation that was never made.
fn text(value: Option<String>) -> SharedString {
    value.unwrap_or_default().into()
}

/// An absent count becomes `-1`, the sentinel `panel.slint` renders as `—`.
///
/// A negative arriving on the wire is not a count, so it reads as not observed
/// rather than being displayed as data. A count too large for the Slint `int`
/// saturates instead: "very large" is closer to the truth than "never seen".
fn count(value: Option<i64>) -> i32 {
    match value {
        Some(number) if number >= 0 => i32::try_from(number).unwrap_or(i32::MAX),
        _ => -1,
    }
}

/// Opens the confirmation area and claims the pending slot for this prompt.
fn show_prompt(window: &slint::Weak<PanelWindow>, pending: &Pending, prompt: Prompt) {
    // Claim before displaying: a click can only ever settle an id that is
    // already recorded, so there is no window in which the buttons are live but
    // unattributed.
    //
    // A prompt arriving while another is pending replaces it. The engine
    // serializes asks so this should not happen, and if it does the abandoned id
    // is one the TypeScript side has already stopped waiting for.
    *pending.lock().expect(POISONED) = Some(prompt.prompt_id);

    let _ = window.upgrade_in_event_loop(move |window| {
        window.set_prompt_kind(prompt.kind.into());
        window.set_prompt_summary(prompt.summary.into());
        window.set_prompt_expires_at(prompt.expires_at.into());
        // Absent reads as empty, and the card hides the line rather than printing
        // a heading with nothing under it. A request that does not explain itself
        // is shown without an explanation, never with one invented here.
        window.set_prompt_why(prompt.why.unwrap_or_default().into());
        window.set_prompt_deny_consequence(prompt.deny_consequence.unwrap_or_default().into());
        // Last, so the buttons appear only once the text beside them is the text
        // of this prompt.
        window.set_prompt_pending(true);
    });
}

/// Withdraws a prompt the engine has given up on.
fn cancel(window: &slint::Weak<PanelWindow>, pending: &Pending, prompt_id: i64) {
    {
        let mut slot = pending.lock().expect(POISONED);
        // A cancel for an id that is no longer pending is stale — it names a
        // prompt already answered or already replaced. Acting on it would close a
        // live confirmation and lose an answer the user is about to give.
        if *slot != Some(prompt_id) {
            return;
        }
        *slot = None;
    }
    let _ = window.upgrade_in_event_loop(clear_prompt);
}

/// Writes one answer for the pending prompt, then closes the confirmation area.
///
/// Runs on the UI thread: both button callbacks and the close handler are Slint
/// callbacks. Takes the pending id, so a second click after the first answer
/// finds nothing to answer.
fn answer(
    pending: &Pending,
    outgoing: &Outgoing,
    window: &slint::Weak<PanelWindow>,
    answer: Answer,
) {
    let Some(prompt_id) = pending.lock().expect(POISONED).take() else {
        // Nothing pending: a click that raced a cancel, or a second click on an
        // already-answered prompt. Writing an uncorrelated answer here is the one
        // thing that could authorize the wrong plan.
        return;
    };

    // A send that finds no connection drops the line rather than queueing it, so
    // this may reach nobody. That is not a reason to keep the area open: the id
    // has been spent, and the TypeScript side's deadline fails closed on an
    // answer it never receives. Re-offering buttons for a question already
    // consumed here would be the worse surface.
    outgoing.send(&answer_line(prompt_id, answer));

    if let Some(window) = window.upgrade() {
        clear_prompt(window);
    }
}

/// Empties the confirmation area.
///
/// The stale text is cleared as well as the flag. `panel.slint` drops the whole
/// section when nothing is pending, so this is not visible today — but a summary
/// left behind is a command description waiting to reappear next to buttons that
/// belong to a different plan.
fn clear_prompt(window: PanelWindow) {
    window.set_prompt_pending(false);
    window.set_prompt_kind(SharedString::new());
    window.set_prompt_summary(SharedString::new());
    window.set_prompt_expires_at(SharedString::new());
    window.set_prompt_why(SharedString::new());
    window.set_prompt_deny_consequence(SharedString::new());
}

#[cfg(test)]
mod panel_tests;

#[cfg(test)]
mod tests {
    use super::{config_verdict, dump_note, source_verdict, tray_mark, tray_tooltip, version_line};
    use crate::protocol::{ConfigResultLine, SourceResultLine};

    /// The mark is drawn, so the drawing is what a test can hold.
    ///
    /// Four pixels, and the fourth is the one that matters: the gap between two
    /// tentacles. Without it every assertion here would still pass for a solid
    /// square, which is what a rasteriser degrades into when a taper or a bound
    /// goes wrong.
    #[test]
    fn the_tray_mark_is_a_dome_over_three_separate_tentacles() {
        let mark = tray_mark(64);
        assert_eq!((mark.width(), mark.height()), (64, 64));
        let alpha = |x: u32, y: u32| mark.as_slice()[(y * 64 + x) as usize].a;
        assert_eq!(alpha(32, 24), 255, "the dome's centre must be solid");
        assert_eq!(alpha(0, 0), 0, "the corner must be clear");
        assert_eq!(alpha(32, 47), 255, "the middle tentacle must be solid");
        assert_eq!(alpha(37, 47), 0, "the gap between tentacles must be clear");
    }

    /// The hover text names the app first, because a tooltip with only a state in
    /// it is a sentence about nothing.
    #[test]
    fn the_tray_tooltip_names_squid_and_then_what_it_is_doing() {
        assert_eq!(tray_tooltip("Watching"), "Squid — Watching");
        // Before the first binding evaluates there is no state to report, and
        // "Squid — " would read as a lost sentence.
        assert_eq!(tray_tooltip(""), "Squid");
    }

    /// The line is a name plus a version, from the crate's own compiled-in
    /// constant — the same reasoning as the placeholder check in `startup.rs`:
    /// a formatting slip here would ship a broken answer to the one question
    /// this line exists to answer.
    #[test]
    fn the_version_line_names_the_binary_and_the_version_it_was_built_from() {
        let line = version_line();
        assert!(line.starts_with("squid-ui "), "{line}");
        assert!(line.contains(env!("CARGO_PKG_VERSION")), "{line}");
        assert!(!line.contains('{'), "{line}");
        assert!(!line.contains('}'), "{line}");
    }

    /// A refusal is reported in the brain's words, because those words name the
    /// key and the reason. Paraphrasing here would be this window inventing a
    /// diagnosis for a file it never read.
    #[test]
    fn a_refusal_is_quoted_rather_than_paraphrased() {
        let refused = ConfigResultLine {
            id: Some("retentionHours".to_owned()),
            ok: 0,
            applies: None,
            error: Some("Retention (hours) must be a whole number.".to_owned()),
        };
        assert_eq!(
            config_verdict(&refused),
            "Retention (hours) must be a whole number."
        );
        let toggle = SourceResultLine {
            id: Some("browser-page-host".to_owned()),
            ok: 0,
            error: Some("Source \"browser-page-host\" is the only observer; a watch session needs at least one.".to_owned()),
        };
        assert_eq!(
            source_verdict(&toggle),
            "Source \"browser-page-host\" is the only observer; a watch session needs at least one."
        );
    }

    /// A refusal with no words still has to read as a refusal. Falling through to
    /// the success sentence is the one wrong outcome: the user would act on a
    /// value the brain never saved.
    #[test]
    fn a_refusal_without_words_still_reads_as_one() {
        let bare = ConfigResultLine {
            id: Some("watchRoot".to_owned()),
            ok: 0,
            applies: None,
            error: None,
        };
        assert_eq!(config_verdict(&bare), "watchRoot was refused.");
        let dump_level = ConfigResultLine {
            id: None,
            ok: 0,
            applies: None,
            error: None,
        };
        assert_eq!(config_verdict(&dump_level), "settings was refused.");
        let source = SourceResultLine {
            id: None,
            ok: 0,
            error: None,
        };
        assert_eq!(source_verdict(&source), "sources was refused.");
    }

    /// "Saved" and "saved but not yet in effect" are different facts. A user who
    /// reads the first when the second is true will look for a behavior change
    /// that cannot happen until the session restarts.
    #[test]
    fn a_save_that_needs_a_restart_says_so() {
        let now = ConfigResultLine {
            id: Some("apiKey".to_owned()),
            ok: 1,
            applies: Some("now".to_owned()),
            error: None,
        };
        assert_eq!(config_verdict(&now), "Saved apiKey.");
        let later = ConfigResultLine {
            id: Some("watchRoot".to_owned()),
            ok: 1,
            applies: Some("restart".to_owned()),
            error: None,
        };
        assert_eq!(
            config_verdict(&later),
            "Saved watchRoot. It takes effect when the session restarts."
        );
        // No `applies` at all reads as the weaker claim — plain "saved" — rather
        // than promising a restart the brain did not ask for.
        let unstated = ConfigResultLine {
            id: Some("watchRoot".to_owned()),
            ok: 1,
            applies: None,
            error: None,
        };
        assert_eq!(config_verdict(&unstated), "Saved watchRoot.");
        assert_eq!(
            source_verdict(&SourceResultLine {
                id: Some("filesystem-local".to_owned()),
                ok: 1,
                error: None,
            }),
            "filesystem-local updated."
        );
    }

    /// A dump that arrives short is stated, not hidden. The parser drops a row it
    /// cannot read, so without this the missing setting would look like a setting
    /// that does not exist — silence reading as an answer, which is the failure
    /// the whole protocol doc warns about.
    #[test]
    fn a_short_dump_is_reported_and_a_complete_one_is_silent() {
        assert_eq!(dump_note("settings", 21, 21), None);
        assert_eq!(dump_note("sources", 0, 0), None);
        let note = dump_note("settings", 20, 21).expect("a shortfall is worth saying");
        assert!(note.contains("20"), "{note}");
        assert!(note.contains("21"), "{note}");
        assert!(note.contains("incomplete"), "{note}");
    }
}
