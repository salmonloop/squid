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
//! need, so this one is not on top, is visible from launch, stays visible, and is
//! an ordinary `window.run()`.
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

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

use protocol::{
    answer_line, config_get_line, config_set_line, control_line, source_get_line,
    source_toggle_line, AgentLine, Answer, ConfigLine, ConfigResultLine, Control, Incoming, Prompt,
    SourceLine, SourceResultLine, WorldState,
};
use slint::{ComponentHandle, ModelRc, SharedString, VecModel};
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
        let pending = Arc::clone(&pending);
        let outgoing = outgoing.clone();
        let handle = window.as_weak();
        window.window().on_close_requested(move || {
            answer(&pending, &outgoing, &handle, Answer::Declined);
            slint::CloseRequestResponse::HideWindow
        });
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
        thread::spawn(move || {
            // The buffers live in this closure: one connection's dumps, torn down
            // with the closure if this thread ever ends. `transport::run` calls
            // this for every message on this thread, so no lock is needed to
            // accumulate — and nothing Slint-owned is touched until a terminator
            // posts a finished dump to the event loop.
            let mut dumps = Dumps::default();
            transport::run(&socket_path, &outgoing, |message| {
                apply(&handle, &pending, &outgoing, &mut dumps, message)
            })
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
    if let Some(brain) = launch.brain() {
        let brain = brain.to_path_buf();
        let endpoint = endpoint_text.clone();
        // Idle until the first spawn reports: the window opens before the child
        // exists, and "running" written optimistically here would be a claim about
        // a process that has not been created yet.
        window.set_service_state(supervisor::ServiceState::Idle.label().into());
        start_supervision(window.as_weak(), brain.clone(), endpoint.clone());

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
            start_supervision(window.as_weak(), brain.clone(), endpoint.clone());
        });
    }

    // An ordinary `run()`: the window is up from launch and stays up. The old
    // `run_event_loop_until_quit` existed only to keep a *hidden* window's
    // process alive between prompts, which is a shape this panel does not have.
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
fn start_supervision(handle: slint::Weak<PanelWindow>, brain: PathBuf, endpoint: String) {
    thread::spawn(move || {
        supervisor::supervise(&brain, &endpoint, |state| {
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
}

/// Replaces the settings form with a dump.
///
/// The count is read, not ignored: `parse_incoming` drops a row it cannot parse,
/// so a dump can arrive one row short with nothing else to show it. A user who
/// reads a missing key as "not a setting" would be misled by silence, so the
/// shortfall is stated in the status line.
fn show_settings(window: &PanelWindow, rows: Vec<ConfigLine>, count: i64) {
    let note = dump_note("settings", rows.len(), count);
    let form: Vec<SettingRow> = rows
        .into_iter()
        .map(|row| SettingRow {
            id: row.id.into(),
            label: row.label.into(),
            kind: row.kind.into(),
            value: row.value.into(),
            applies: row.applies.into(),
            // Anything but an explicit 1 reads as not overridden: this is a
            // disclosure, and claiming one on a malformed field would be worse
            // than leaving it off.
            overridden: row.overridden == Some(1),
            values: row.values.unwrap_or_default().into(),
        })
        .collect();
    window.set_settings(ModelRc::new(VecModel::from(form)));
    if let Some(note) = note {
        window.set_status(note.into());
    }
}

/// Replaces the source list with a dump. Same swap-whole discipline as
/// [`show_settings`], and the same reason for reading the count.
fn show_sources(window: &PanelWindow, rows: Vec<SourceLine>, count: i64) {
    let note = dump_note("sources", rows.len(), count);
    let list: Vec<SourceRow> = rows
        .into_iter()
        .map(|row| SourceRow {
            id: row.id.into(),
            label: row.label.into(),
            state: row.state.into(),
        })
        .collect();
    window.set_sources(ModelRc::new(VecModel::from(list)));
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
}

#[cfg(test)]
mod tests {
    use super::{config_verdict, dump_note, source_verdict, version_line};
    use crate::protocol::{ConfigResultLine, SourceResultLine};

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
