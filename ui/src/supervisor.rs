//! Starting and looking after the brain, for the run where the panel is the
//! thing the user opened.
//!
//! Two ways this process starts, and they are genuinely different jobs:
//!
//! * **Attached.** `SQUID_PANEL_SOCKET` is set, so a session already exists (or
//!   is about to) and this panel is its second display. Nothing in this module
//!   runs. That is the shape the panel has always had.
//! * **Supervising.** The variable is unset, which used to be a refusal — the
//!   panel exited `2` and explained that it was a client. Issue #23 inverts that:
//!   a double-clicked panel is now the ordinary way in, so it computes the
//!   default endpoint, checks whether a session is already listening there, and
//!   starts one if not.
//!
//! ## The probe comes first, and it is the double-start guard
//!
//! Before spawning anything, the supervisor tries to *connect*. A successful
//! connect means a session is already on that endpoint — started by hand, by a
//! previous panel, or by the packaged `squid` binary — and the right move is to
//! attach to it rather than start a second brain that would fight it for the
//! socket. This matters more than it looks: `Bun.listen({ unix })` does not
//! reliably report `EADDRINUSE` (see the transport notes in
//! `docs/panel-protocol.md`), so two sessions on one path both appear to bind and
//! then split connections unpredictably. A connect that succeeds is the one
//! cheap, reliable answer available to this side.
//!
//! ## Restart is an exit code, not a signal
//!
//! The brain stops itself when the panel asks (`{"type":"control","op":"restart"}`)
//! and exits `3`, which is this module's cue to spawn a replacement. The panel
//! never kills a brain to restart it: a signal would cut the session's own
//! ordered teardown — sources, turns, panel, agent, store — and the store is the
//! last thing anyone wants interrupted. So `Restart` here is a *wait for exit 3*,
//! and the exit-code table in `docs/panel-protocol.md` is the contract both sides
//! are written against.
//!
//! ## A crash loop must end in a message, not in a loop
//!
//! A brain that exits non-zero is respawned after a backoff, doubling from 250ms
//! to a cap of 8s. But a brain that keeps failing is not a transient problem, and
//! respawning it forever would burn a laptop battery to hide a broken install. So
//! three non-zero exits inside 60 seconds is [`ServiceState::Failed`] and the
//! supervisor stops trying until the user asks again.
//!
//! Exit `2` skips even the first retry. It is the brain's "startup refused" code —
//! a config error, a relative watch root, a malformed `models.json` — and none of
//! those get better by being run again. Respawning a typo is the crash loop the
//! guard exists to prevent, just faster. What the brain said on its way out — the
//! one sentence naming the broken setting — is carried into the failure the panel
//! shows, because the person who double-clicked this window has no console to
//! read it from.

use std::collections::VecDeque;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The exit code the brain uses for "I stopped cleanly because the panel asked
/// me to; start my replacement".
///
/// Named here and in the protocol doc's exit-code table, and the test below
/// asserts the pair — a launcher that read this wrong would either strand the
/// user on a dead endpoint or respawn a config error forever.
pub const EXIT_RESTART_REQUESTED: i32 = 3;

/// The brain's "startup refused" code: a configuration error that a retry cannot
/// fix. Terminal by construction, not by backoff.
pub const EXIT_STARTUP_REFUSED: i32 = 2;

/// Marks the child as supervised, which is what lets it accept a restart at all.
///
/// The brain refuses `op:"restart"` unless it sees this, because an unsupervised
/// exit would look like a crash to whoever started it by hand. Spelled once here
/// and read by `watch-session.ts`; the doc's process-contract section is the
/// shared definition.
pub const SUPERVISED_ENV: &str = "SQUID_SUPERVISED";

/// First retry delay after a non-zero exit.
const FIRST_BACKOFF: Duration = Duration::from_millis(250);

/// Ceiling for the retry delay. A brain that is failing for an external reason
/// (a disk that filled, a display that went away) should be retried
/// indefinitely but cheaply; 8s is slow enough to be free and fast enough that a
/// fixed machine recovers without the user reaching for the panel.
const MAX_BACKOFF: Duration = Duration::from_secs(8);

/// How many non-zero exits inside [`CRASH_WINDOW`] mean "stop trying".
const CRASH_LIMIT: usize = 3;

/// The window the crash counter looks back over. Long enough that three quick
/// failures are clearly one broken install rather than three unrelated
/// accidents, short enough that a session which ran for a minute and then died
/// starts the count over.
const CRASH_WINDOW: Duration = Duration::from_secs(60);

/// What the panel says about the brain it started.
///
/// Only meaningful in supervising mode. An attached panel has no opinion about a
/// process it did not start, and the window renders no service state for it —
/// claiming "Running" about somebody else's session would be a guess.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum ServiceState {
    /// Not started yet, or deliberately stopped.
    Idle,
    /// A child is alive. Whether its *session* is healthy is the `service` line's
    /// business, not this module's: a running process that cannot open its store
    /// is running, and the panel shows both facts separately rather than blending
    /// them into one optimistic word.
    Running,
    /// Spawning failed, or the child exited and a retry is due.
    Restarting { reason: String },
    /// Terminal. A crash loop, or an exit this module will not retry.
    Failed { reason: String },
}

impl ServiceState {
    /// The label a tripped guard leaves on screen, named because it is also a
    /// *condition*: only from here may a new round of supervision be started, so
    /// the spelling is shared rather than repeated at the comparison site.
    pub const FAILED_LABEL: &'static str = "failed";

    /// The one-word label the window shows. Deliberately not derived from
    /// `Debug`: a rename of a variant should not silently rewrite what a user
    /// reads.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Restarting { .. } => "restarting",
            Self::Failed { .. } => Self::FAILED_LABEL,
        }
    }

    /// The sentence beside the label, or empty when the state speaks for itself.
    pub fn detail(&self) -> String {
        match self {
            Self::Idle | Self::Running => String::new(),
            Self::Restarting { reason } | Self::Failed { reason } => reason.clone(),
        }
    }
}

/// The decision a finished child produces: retry after a wait, or stop.
///
/// A pure function of the exit code and the crash history, which is the whole
/// reason it exists separately from the process handling — the retry policy is
/// the part worth testing, and it is testable without spawning anything.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum ExitDecision {
    /// Spawn again after this delay.
    Retry { after: Duration, reason: String },
    /// Do not spawn again.
    Stop { reason: String },
}

/// Reads one child exit and decides what happens next.
///
/// `code` is `None` when the child died by signal, which counts as a crash: a
/// brain killed by the OOM killer has not shut down cleanly, and treating it as
/// a clean exit would leave the user with a panel attached to nothing and no
/// explanation.
///
/// `recent_crashes` is how many non-zero exits already landed inside
/// [`CRASH_WINDOW`], *including* this one — the caller owns the clock, so this
/// stays pure.
pub fn decide_after_exit(
    code: Option<i32>,
    recent_crashes: usize,
    backoff: Duration,
) -> ExitDecision {
    match code {
        // The restart handshake. Not a crash, so it neither counts toward the
        // guard nor waits out a backoff: the user clicked a button and is
        // watching for the session to come back.
        Some(EXIT_RESTART_REQUESTED) => ExitDecision::Retry {
            after: Duration::ZERO,
            reason: "restarting at your request".to_owned(),
        },
        // A clean exit is the brain being asked to stop, by a signal it handled
        // or by its own shutdown path. Respawning it would fight the user.
        Some(0) => ExitDecision::Stop {
            reason: "the session stopped".to_owned(),
        },
        // Startup refused: a config error. A retry runs the same broken
        // configuration into the same wall, so the first failure is the last.
        Some(EXIT_STARTUP_REFUSED) => ExitDecision::Stop {
            reason: "the session refused to start; its configuration needs fixing".to_owned(),
        },
        Some(code) if recent_crashes >= CRASH_LIMIT => ExitDecision::Stop {
            reason: format!(
                "the session exited {code} three times in a minute; not restarting it again"
            ),
        },
        Some(code) => ExitDecision::Retry {
            after: backoff,
            reason: format!("the session exited {code}; restarting"),
        },
        None if recent_crashes >= CRASH_LIMIT => ExitDecision::Stop {
            reason: "the session was killed three times in a minute; not restarting it again"
                .to_owned(),
        },
        None => ExitDecision::Retry {
            after: backoff,
            reason: "the session was killed; restarting".to_owned(),
        },
    }
}

/// One rung up the retry ladder, capped. Same shape as the transport's ladder and
/// separate on purpose: this one is about a process that keeps dying, that one is
/// about a socket that is not there yet, and they have no reason to move
/// together.
pub fn next_backoff(current: Duration) -> Duration {
    (current * 2).min(MAX_BACKOFF)
}

/// The first delay of a fresh ladder.
pub fn first_backoff() -> Duration {
    FIRST_BACKOFF
}

/// Records non-zero exits and answers how many landed inside the window.
///
/// A plain `Vec` of instants rather than a counter with a reset, because the
/// question is "how many in the last minute", and a counter would have to guess
/// when to forget. Bounded by construction: entries older than the window are
/// dropped on every push, and nothing pushes faster than a process can exit.
#[derive(Default)]
pub struct CrashLog {
    at: Vec<Instant>,
}

impl CrashLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records a crash at `now` and returns how many are inside the window.
    pub fn record(&mut self, now: Instant) -> usize {
        self.at
            .retain(|earlier| now.duration_since(*earlier) < CRASH_WINDOW);
        self.at.push(now);
        self.at.len()
    }

    /// Forgets the history. Called when the user asks for a start or a restart:
    /// they have seen the failure and decided to try again, and holding the old
    /// count against them would refuse the second click.
    pub fn clear(&mut self) {
        self.at.clear();
    }
}

/// Where the brain sits: next to this binary, in the release zip.
///
/// The mirror of `panelExecutablePath` in `src/app-defaults.ts`, pointing the
/// other way — that function finds the panel from the brain, this one finds the
/// brain from the panel. The zip puts them side by side precisely so neither has
/// to search a PATH that a double-click does not reliably provide.
///
/// `.exe` follows the *target*, like its TypeScript mirror: a Windows build looks
/// for `squid.exe` wherever it is unpacked.
pub fn brain_executable_path(panel_exe: &Path) -> PathBuf {
    let name = if cfg!(windows) { "squid.exe" } else { "squid" };
    match panel_exe.parent() {
        Some(directory) => directory.join(name),
        // A bare name with no directory: look beside the current directory
        // rather than treating the root as the install folder.
        None => PathBuf::from(name),
    }
}

/// The endpoint a supervising panel uses when the user named none.
///
/// The Rust mirror of `defaultPanelEndpoint` in `src/app-defaults.ts`, and the
/// two are tested against the same strings in both languages: this is the one
/// value both processes have to agree on without either being told it. A
/// disagreement here is a panel that starts a brain and then cannot find it.
///
/// Windows is the pipe namespace, Unix the runtime directory (falling back to
/// `/tmp` when `XDG_RUNTIME_DIR` is unset or relative, exactly as the TypeScript
/// side does — the resolver refuses a relative path, so honoring a malformed one
/// would only turn a sane default into a broken startup).
pub fn default_endpoint(runtime_dir: Option<&str>) -> String {
    if cfg!(windows) {
        return "\\\\.\\pipe\\squid-panel".to_owned();
    }
    let base = match runtime_dir {
        Some(directory) if directory.starts_with('/') => directory.trim_end_matches('/'),
        _ => "/tmp",
    };
    format!("{base}/squid-panel.sock")
}

/// How long the startup probe waits for an existing session before concluding
/// there is none.
///
/// Short on purpose: this delay is in front of every double-click, and the
/// question it answers ("is something already listening?") is answered by the
/// first connect attempt or not at all. A session that is up answers in
/// microseconds on a Unix socket; a session that is not up cannot be made to
/// answer by waiting longer.
const PROBE_TIMEOUT: Duration = Duration::from_millis(1_500);

/// How often the probe retries inside its budget. A session mid-startup may have
/// resolved its config but not yet bound, and a single instantaneous attempt
/// would miss it and start a second brain — the exact double-start this guards.
const PROBE_INTERVAL: Duration = Duration::from_millis(100);

/// Whether a session is already listening on this endpoint.
///
/// A successful *connect* is the whole test, and it is the double-start guard:
/// `Bun.listen({ unix })` does not reliably report `EADDRINUSE`, so two brains on
/// one path both appear to bind and then split connections unpredictably. This
/// side cannot ask "is this bound"; it can only ask "does someone answer", which
/// is the reliable half of the question.
///
/// A stale Unix socket file left by a crashed run is *not* a false positive: the
/// connect fails with `ECONNREFUSED` because nothing is accepting, so the
/// supervisor correctly decides to spawn. The brain then clears the stale path
/// itself before binding, which is `startPanelServer`'s job and not this one's.
pub fn session_is_listening(endpoint: &Path) -> bool {
    probe_until(endpoint, PROBE_TIMEOUT)
}

/// The probe loop with an explicit budget.
///
/// Split out so a test can state a short one: the production window exists to
/// cover a session that is still binding, and waiting it out twice for the two
/// negative cases would add three seconds to every suite run for no coverage.
fn probe_until(endpoint: &Path, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    loop {
        if crate::transport::probe(endpoint) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(PROBE_INTERVAL);
    }
}

/// The location and runtime variables a child is allowed to inherit.
///
/// All are location/runtime, not Squid behavior. Windows needs SYSTEMROOT/WINDIR
/// to create normal child processes; Unix needs HOME for Pi's own config
/// location; the XDG pair names the same locations the TS config resolver uses.
/// Missing values stay missing — inventing one here would be a new default
/// separate from the brain's.
///
/// The last four are how a brain reaches the desktop it is supposed to observe,
/// and their absence was measured as a silent capability loss rather than an
/// error: the X11 backend shells out to `xdotool`, which needs `DISPLAY` (and
/// `XAUTHORITY` where the cookie is not in the default place) to find a display at
/// all, and the desktop notice needs the session bus. `env_clear()` removed them,
/// so a panel-started brain on Linux reported read errors forever while the same
/// binary started from a terminal worked — the difference being four variables
/// nobody had listed. They are locations, like the rest of this list: none of them
/// selects any Squid behavior, they name where this session's display and bus are.
pub const INHERITED_ENV: &[&str] = &[
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_RUNTIME_DIR",
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
];

/// The exact environment a supervised brain is given, as data.
///
/// Split out from the spawn so the allowlist is assertable without creating a
/// process. That mattered more than it sounds: this list is the mechanism that
/// makes the settings file the authority — a stray `SQUID_BROWSER` in the
/// panel's parent environment must not outrank what the form saved — and it was
/// covered by nothing, because everything around it needed a real child.
///
/// `lookup` reads the parent environment, injected so a test can state one
/// instead of depending on the developer machine's.
pub fn child_env(
    endpoint: &str,
    lookup: impl Fn(&str) -> Option<String>,
) -> Vec<(&'static str, String)> {
    let mut env: Vec<(&str, String)> = Vec::new();
    for name in INHERITED_ENV {
        if let Some(value) = lookup(name) {
            env.push((name, value));
        }
    }
    // The config-file *locator* is the one Squid variable that travels. It
    // points to the file rather than selecting a behavior, and leaving it behind
    // would make a panel opened with SQUID_CONFIG edit one file while the brain
    // starts from another.
    if let Some(value) = lookup("SQUID_CONFIG") {
        env.push(("SQUID_CONFIG", value));
    }
    // The two the panel itself owns, last so they cannot be shadowed by a
    // parent value of the same name.
    env.push((crate::transport::SOCKET_ENV, endpoint.to_owned()));
    env.push((SUPERVISED_ENV, "1".to_owned()));
    env
}

/// Spawns the brain, marked supervised.
///
/// The child does **not** inherit the panel's whole environment. That is the
/// point of the config file: a stray `SQUID_WATCH_ROOT` or `SQUID_BROWSER` in the
/// parent must not silently outrank the values the settings form writes. The
/// child receives only the operating-system variables needed to find a home,
/// runtime directory, temporary files, and system libraries — plus `SQUID_CONFIG`
/// when a person deliberately chose a non-default *location* for the config file.
/// The location is not a business setting; it is the pointer to the one authority
/// for them. Every other `SQUID_*` value is deliberately absent.
///
/// The two variables the panel itself owns are then added: the endpoint it should
/// listen on and the supervised flag. Nothing else is injected.
///
/// stderr is a pipe rather than inherited, drained and kept as a tail by
/// [`StderrTail`] — see that type for why capturing it costs the brain nothing
/// on its way to a person. stdout stays inherited so the brain's ordinary
/// logging lands wherever the panel's own does.
/// What [`spawn_brain`] hands back besides the child: a reader that is already
/// draining the brain's stderr into memory, and from which the last lines can be
/// taken once the child is gone.
///
/// The split is the whole design. A pipe nobody reads fills its kernel buffer
/// and then *blocks the brain's next write to stderr* — a chatty failure wedging
/// itself into a hang — so the drain cannot wait for an exit the panel cares
/// about. But the decision needs the tail only after the exit, so that is when
/// it joins: the reader thread ends on its own once the child's stderr closes,
/// and the tail is read from what it left behind. Nobody waits on the thread;
/// the [`Supervision`] handle remains the only thing that can be asked to stop.
pub struct SpawnedBrain {
    /// The child, for the supervision loop's `try_wait`/`kill`.
    pub child: Child,
    /// stderr, as the reader thread left it once the pipe hit EOF.
    pub stderr_tail: StderrTail,
}

pub fn spawn_brain(brain: &Path, endpoint: &str) -> io::Result<SpawnedBrain> {
    let mut command = Command::new(brain);
    command.env_clear();
    for (name, value) in child_env(endpoint, |name| {
        std::env::var_os(name).map(|value| value.to_string_lossy().into_owned())
    }) {
        command.env(name, value);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::piped())
        .spawn()?;
    // Taken before the child is returned, so this function's caller can never
    // hold a live pipe on a child it does not own.
    let stderr = child.stderr.take().expect("stderr was just piped");
    Ok(SpawnedBrain {
        stderr_tail: StderrTail::spawn(stderr),
        child,
    })
}

/// How many trailing stderr lines are kept, per child.
///
/// The config error is a single sentence on the last line, and the brain is
/// chatty only when something is already wrong; the tail exists to be read by a
/// person, and four lines is the whole of what a person reads of a stack trace.
const STDERR_TAIL_LINES: usize = 4;

/// The tail of one brain's stderr, kept by a thread that drains it from the
/// first byte to EOF.
///
/// The reader exists to keep the pipe from filling: stderr is a pipe now, and a
/// pipe nobody reads blocks its writer once the kernel buffer is full. A brain
/// that fails loudly (a stack trace, a flood of warnings) would otherwise hang
/// itself mid-complaint. The tail is kept so that when the exit arrives, the
/// sentence that explains it is still around.
pub struct StderrTail {
    shared: Arc<Mutex<TailState>>,
    /// The drain thread, held but never joined. It ends when the pipe hits EOF
    /// — which happens when the child exits, or when `kill` closes its end — so
    /// its lifetime is already bounded by the child's.
    _drain: std::thread::JoinHandle<()>,
}

#[derive(Default)]
struct TailState {
    /// The kept lines, oldest first; never longer than [`STDERR_TAIL_LINES`].
    lines: VecDeque<String>,
    /// Set when the drain reached EOF. The difference between "nothing left"
    /// and "not read yet", which is the difference between a finished sentence
    /// and half of one.
    eof: bool,
}

impl StderrTail {
    /// Starts draining `stderr`, keeping the last lines.
    fn spawn(stderr: ChildStderr) -> Self {
        let shared = Arc::new(Mutex::new(TailState::default()));
        let state = Arc::clone(&shared);
        let drain = std::thread::Builder::new()
            .name("brain-stderr".to_owned())
            .spawn(move || drain_stderr(stderr, state))
            .expect("spawn the stderr drain thread");
        Self {
            shared,
            _drain: drain,
        }
    }

    /// The last non-empty line, once the drain has finished.
    ///
    /// The config error is one sentence on stderr's last line; everything above
    /// it is noise the sentence does not need. Empty lines are skipped because
    /// a trailing newline is spelling, not content.
    ///
    /// Waits for EOF rather than reading early, because a child can be reaped
    /// before the drain thread has read its final line — a race that turns the
    /// sentence into silence. Bounded, because EOF needs every writer closed
    /// and a grandchild that inherited stderr can hold the pipe open past its
    /// parent's death; on timeout this returns the best tail it has, which for
    /// a refused startup is at worst the lines before the last. The caller only
    /// asks after the child is gone, so the wait is short in every case that
    /// happens in practice.
    pub fn last_words(&self) -> Option<String> {
        let deadline = Instant::now() + STDERR_EOF_WAIT;
        loop {
            let guard = self
                .shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if guard.eof || Instant::now() >= deadline {
                return guard
                    .lines
                    .iter()
                    .rev()
                    .find(|line| !line.trim().is_empty())
                    .cloned();
            }
            drop(guard);
            std::thread::sleep(STDERR_EOF_POLL);
        }
    }
}

/// How long [`StderrTail::last_words`] will wait for the drain to reach EOF.
///
/// Generous next to the microseconds a closed pipe needs, and short next to the
/// quarter-second the supervision loop already tolerates — its job is to
/// outlast a scheduler hiccup, not a process that refuses to die.
const STDERR_EOF_WAIT: Duration = Duration::from_secs(2);

/// How often that wait re-checks the drain.
const STDERR_EOF_POLL: Duration = Duration::from_millis(2);

/// Reads `stderr` to EOF, keeping the last [`STDERR_TAIL_LINES`] lines in `state`
/// and passing every line through to this process's own stderr.
///
/// The pass-through is the tee that keeps the old inherited-stderr contract
/// alive: capturing the stream must not cost the brain its console. A developer
/// running the panel from a terminal still sees the brain's diagnostics live,
/// exactly as when stderr was inherited; the tail is a second reader on the
/// same stream, not a replacement for the first. (Line-buffered rather than a
/// raw byte copy, so a line split across two reads is still forwarded whole.)
fn drain_stderr(stderr: ChildStderr, state: Arc<Mutex<TailState>>) {
    use std::io::{BufRead, Write};
    let reader = io::BufReader::new(stderr);
    let mut own = io::stderr();
    let mut guard = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if guard.lines.len() == STDERR_TAIL_LINES {
            guard.lines.pop_front();
        }
        guard.lines.push_back(line.clone());
        let _ = writeln!(own, "{line}");
    }
    guard.eof = true;
}

/// Refuses-to-start reasons get the brain's own sentence appended, when it has
/// one. The generic refusal named no setting and no file; the sentence names
/// both.
fn refused_reason(tail: &Option<String>) -> String {
    let base = "the session refused to start; its configuration needs fixing".to_owned();
    match tail {
        Some(sentence) => format!("{base}: {sentence}"),
        None => base,
    }
}

/// How often the loop asks a living child whether it has exited.
///
/// A poll rather than a blocking `wait()`, and the whole reason this module has a
/// [`Supervision`] handle at all. `wait()` cannot be interrupted, so a panel that
/// blocked in it could not honor "stop now" until the child chose to exit — which
/// for a healthy brain is never. A quarter-second is invisible next to a process
/// lifetime and costs four wakeups a second on a thread that would otherwise be
/// parked.
const CHILD_POLL: Duration = Duration::from_millis(250);

/// How often [`Supervision::stop_within`] re-checks a child it asked to stop.
const STOP_POLL: Duration = Duration::from_millis(20);

/// The panel's grip on the brain it started.
///
/// Exists because quitting the panel must not leave the session running. The tray
/// item says "Quit Squid", and before this the brain outlived it: the supervisor
/// thread owned the child, blocked in `wait()`, and had no way to be told the user
/// was done. Observation and model calls continued with no window and no tray icon
/// to say so, which is the worst shape this program can take — invisible and still
/// watching.
///
/// Two facts, shared with the supervising thread: whether a stop was asked for, and
/// which child is alive. Both are needed. Killing without the flag races the loop
/// into spawning a replacement; the flag without the kill waits for a process that
/// has no reason to exit.
///
/// An *attached* panel has none of this. A session it did not start is not its to
/// stop, so the handle is created only when this run owns a brain.
#[derive(Default)]
pub struct Supervision {
    stopping: AtomicBool,
    /// `None` before the first spawn, between a child's exit and the next spawn,
    /// and after a stop. Held only for as long as one decision takes: a lock held
    /// across a blocking `wait()` would be the deadlock this design exists to
    /// avoid.
    child: Mutex<Option<Child>>,
}

impl Supervision {
    /// Whether a stop has been asked for, so no further child is started.
    pub fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    /// Spawns the next child, unless a stop has been asked for.
    ///
    /// One step under one lock rather than a check and then a spawn. Between those
    /// two a stop could arrive, find nothing running, and return satisfied — and
    /// this loop would then start a child with nobody left to stop it, which is
    /// the original bug wearing a smaller window.
    ///
    /// `None` is the refusal; `Some(Err)` is a spawn that failed. On success the
    /// caller also receives the child's stderr tail, because the spawn handed it
    /// back alongside the child and the decision that needs it belongs to this
    /// loop, not to the lock.
    fn start(
        &self,
        spawn: impl FnOnce() -> io::Result<SpawnedBrain>,
    ) -> Option<io::Result<StderrTail>> {
        let mut slot = self.lock();
        if self.stopping() {
            return None;
        }
        match spawn() {
            Ok(spawned) => {
                *slot = Some(spawned.child);
                Some(Ok(spawned.stderr_tail))
            }
            Err(error) => Some(Err(error)),
        }
    }

    /// Reaps the child if it has exited, leaving it in place if it has not.
    ///
    /// `None` means there is nothing to wait for any more — either it exited (and
    /// the status is returned) or a stop already reaped it, which the caller tells
    /// apart by having asked.
    fn poll_exit(&self) -> Option<io::Result<std::process::ExitStatus>> {
        let mut slot = self.lock();
        let child = slot.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => {
                *slot = None;
                Some(Ok(status))
            }
            Ok(None) => None,
            Err(error) => {
                *slot = None;
                Some(Err(error))
            }
        }
    }

    /// Stops the session and does not let it come back.
    ///
    /// Asked first, killed second, and `grace` is the whole difference between the
    /// two: the brain closes its store and its session history on its own shutdown
    /// path, and a kill skips that. The caller sends the stop request over the
    /// panel wire; this waits for the exit that request produces, and kills only a
    /// child that did not take it. Returns when nothing of ours is running.
    ///
    /// Bounded on purpose. A wedged brain must not be able to keep the panel from
    /// closing — a program that will not quit is the failure this method exists
    /// inside, not one it may cause.
    pub fn stop_within(&self, grace: Duration) {
        self.stopping.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + grace;
        loop {
            {
                let mut slot = self.lock();
                let Some(child) = slot.as_mut() else { return };
                match child.try_wait() {
                    // It took the request, or the supervising thread reaped it
                    // first. Either way there is nothing of ours left.
                    Ok(Some(_)) => {
                        *slot = None;
                        return;
                    }
                    Ok(None) if Instant::now() < deadline => {}
                    // Out of grace, or unwaitable. `kill` is SIGKILL, which is
                    // what makes this bounded; the `wait` after it is what keeps
                    // the process from becoming a zombie this panel leaves behind.
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        *slot = None;
                        return;
                    }
                }
            }
            std::thread::sleep(STOP_POLL);
        }
    }

    /// The lock, past a poisoned mutex.
    ///
    /// A panic while holding it would leave the child unreachable and the session
    /// unstoppable, which is a worse outcome than acting on the state a panicking
    /// thread left. Nothing here is an invariant a panic can break: it is one
    /// `Option<Child>`.
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Child>> {
        self.child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Keeps a brain alive on `endpoint` until the process ends.
///
/// Runs on its own thread, like the transport reader and for the same reason:
/// `wait()` blocks, and blocking the Slint event loop would freeze the window
/// this module exists to keep informative.
///
/// `report` is called with every state change and hops to the UI thread itself —
/// this loop never touches a Slint property. The states it reports are about the
/// *process*: whether the session inside it is healthy is the `service` line's
/// business, and the window shows the two separately rather than blending them
/// into one optimistic word.
///
/// Returns when the brain should not be restarted again — a clean exit, a refused
/// startup, or a tripped crash guard. It does not exit the process: the panel
/// stays up, showing why, because a window that vanishes when its child dies is
/// the failure mode the whole supervising mode was added to avoid.
pub fn supervise(
    brain: &Path,
    endpoint: &str,
    supervision: &Supervision,
    mut report: impl FnMut(ServiceState),
) {
    let mut crashes = CrashLog::new();
    let mut backoff = first_backoff();
    loop {
        let stderr_tail = match supervision.start(|| spawn_brain(brain, endpoint)) {
            // A stop arrived — before the first spawn, or while a backoff was
            // being waited out. Either way this round is over and no child of ours
            // is running, which is exactly `Idle`.
            None => {
                report(ServiceState::Idle);
                return;
            }
            // Spawning failed rather than the brain failing: a missing binary, a
            // permission bit. Terminal, because the next attempt runs the same
            // `execve` against the same path.
            Some(Err(error)) => {
                report(ServiceState::Failed {
                    reason: format!("could not start {}: {error}", brain.display()),
                });
                return;
            }
            Some(Ok(tail)) => tail,
        };
        report(ServiceState::Running);

        let status = loop {
            match supervision.poll_exit() {
                Some(Ok(status)) => break status,
                Some(Err(error)) => {
                    report(ServiceState::Failed {
                        reason: format!("lost track of the session: {error}"),
                    });
                    return;
                }
                // Still alive — unless a stop took it out from under this loop,
                // which is the one case where there is nothing left to wait for
                // and nothing to report: the panel is on its way out.
                None => {
                    if supervision.stopping() {
                        return;
                    }
                    std::thread::sleep(CHILD_POLL);
                }
            }
        };

        let code = status.code();
        // The restart handshake is not a crash and must not age the guard: a user
        // who restarts four times in a minute has not got a crash loop.
        let recent = if code == Some(EXIT_RESTART_REQUESTED) {
            crashes.clear();
            0
        } else {
            crashes.record(Instant::now())
        };

        match decide_after_exit(code, recent, backoff) {
            ExitDecision::Stop { reason } => {
                // The one refusal a retry cannot fix is also the one whose
                // explanation the brain prints on stderr — the config error's
                // sentence names the setting and the file, and a person facing
                // the "Start Squid again" button needs exactly that sentence to
                // know the button is not the fix. The drain thread has usually
                // finished by now (the child is gone, so its stderr is closed),
                // but "usually" is not a contract, so the tail is read under the
                // drain's own lock: a line the brain wrote is either already in
                // the tail or not yet visible to anyone, and either way this
                // reads a consistent prefix rather than racing a writer.
                let reason = if code == Some(EXIT_STARTUP_REFUSED) {
                    refused_reason(&stderr_tail.last_words())
                } else {
                    reason
                };
                report(ServiceState::Failed { reason });
                return;
            }
            ExitDecision::Retry { after, reason } => {
                report(ServiceState::Restarting { reason });
                if after > Duration::ZERO {
                    std::thread::sleep(after);
                    backoff = next_backoff(backoff);
                } else {
                    // A requested restart resets the ladder: the next unexpected
                    // failure is a first failure, not the continuation of a
                    // sequence the user deliberately interrupted.
                    backoff = first_backoff();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn drained_last_words(script: &str) -> Option<String> {
        // A real child with a real stderr pipe, because the part worth testing
        // is the drain's lifecycle: it must settle to EOF on its own once the
        // child is gone, without anyone joining the thread.
        use std::process::Command;
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(script)
            .stderr(Stdio::piped())
            .stdout(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .expect("spawn the writer");
        let stderr = child.stderr.take().expect("stderr was piped");
        let tail = StderrTail::spawn(stderr);
        child.wait().expect("the writer exits");
        // The drain ends when the pipe hits EOF, which the child's exit has
        // just caused. Waited for rather than slept past, so the tail is
        // settled by the time it is read.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let words = tail.last_words();
            if words.is_some() || Instant::now() >= deadline {
                return words;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn the_default_endpoint_matches_its_typescript_mirror() {
        // The strings in `tests/squid-app.test.ts` for `defaultPanelEndpoint`,
        // asserted here so the two halves cannot drift. If this test and that one
        // disagree, a supervising panel starts a brain on an endpoint it will
        // then fail to connect to — the failure is silent on both sides, which is
        // why it is pinned in both languages.
        if cfg!(windows) {
            assert_eq!(default_endpoint(None), "\\\\.\\pipe\\squid-panel");
            // The runtime directory is a Unix concept; Windows ignores it rather
            // than building a path out of it.
            assert_eq!(
                default_endpoint(Some("/run/user/1000")),
                "\\\\.\\pipe\\squid-panel"
            );
        } else {
            assert_eq!(
                default_endpoint(Some("/run/user/1000")),
                "/run/user/1000/squid-panel.sock"
            );
            assert_eq!(default_endpoint(None), "/tmp/squid-panel.sock");
            // A relative XDG_RUNTIME_DIR falls back rather than being resolved:
            // the endpoint resolver refuses a relative path, so honoring it would
            // move a sane default into a broken startup.
            assert_eq!(default_endpoint(Some("run/user")), "/tmp/squid-panel.sock");
            // Windows-shaped values are not absolute *here*, and must not be:
            // `starts_with('/')` is the POSIX rule, matching the TypeScript
            // mirror's `posix.isAbsolute`. The TS side originally used the
            // host-sensitive `isAbsolute`, which on a Windows runner would have
            // accepted these and emitted `C:\tmp/squid-panel.sock` — an endpoint
            // this side would never compute, so the panel would start a brain and
            // then fail to find it. Both halves are pinned to the same inputs.
            assert_eq!(default_endpoint(Some("C:\\tmp")), "/tmp/squid-panel.sock");
            assert_eq!(
                default_endpoint(Some("\\\\server\\share")),
                "/tmp/squid-panel.sock"
            );
            assert_eq!(default_endpoint(Some("")), "/tmp/squid-panel.sock");
            // No endpoint may mix separators.
            for runtime_dir in ["/run/user/1000", "run/user", "C:\\tmp", ""] {
                assert!(
                    !default_endpoint(Some(runtime_dir)).contains('\\'),
                    "endpoint for {runtime_dir:?} must not hold a backslash"
                );
            }
        }
    }

    #[test]
    fn the_brain_sits_next_to_the_panel() {
        // The mirror of `panelExecutablePath`, pointing the other way. Asserted on
        // the file name and the directory rather than a joined string, because the
        // separator spelling is the host's and the contract is "beside this
        // binary".
        let panel = if cfg!(windows) {
            PathBuf::from("C:\\opt\\squid\\squid-ui.exe")
        } else {
            PathBuf::from("/opt/squid/squid-ui")
        };
        let brain = brain_executable_path(&panel);
        let expected = if cfg!(windows) { "squid.exe" } else { "squid" };
        assert_eq!(
            brain.file_name().and_then(|name| name.to_str()),
            Some(expected)
        );
        assert_eq!(brain.parent(), panel.parent());
    }

    #[test]
    fn a_restart_exit_respawns_immediately_and_is_not_a_crash() {
        // The user clicked a button and is watching. A backoff here would read as
        // the panel having ignored the click.
        let decision = decide_after_exit(Some(EXIT_RESTART_REQUESTED), 0, FIRST_BACKOFF);
        match decision {
            ExitDecision::Retry { after, .. } => assert_eq!(after, Duration::ZERO),
            other => panic!("expected an immediate retry, got {other:?}"),
        }
    }

    #[test]
    fn a_clean_exit_is_not_respawned() {
        // Zero is the brain being asked to stop. Starting it again would fight the
        // user's own shutdown.
        assert!(matches!(
            decide_after_exit(Some(0), 0, FIRST_BACKOFF),
            ExitDecision::Stop { .. }
        ));
    }

    #[test]
    fn refused_reason_carries_the_brains_sentence_when_it_has_one() {
        // The generic refusal names no setting and no file. The sentence the
        // brain printed names both, and appending it is the whole fix: the
        // person facing the failed panel is the one person guaranteed not to
        // have the console it was printed on.
        assert_eq!(
            refused_reason(&Some("a sentence".to_owned())),
            "the session refused to start; its configuration needs fixing: a sentence"
        );
        // A brain that exited 2 without saying anything still gets the generic
        // refusal — an invented sentence would be worse than a vague one.
        assert_eq!(
            refused_reason(&None),
            "the session refused to start; its configuration needs fixing"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_stderr_tail_keeps_the_last_line_and_skips_empty_ones() {
        // The config error is the last line the brain writes. A trailing blank
        // line is spelling, not content, and must not blank the sentence.
        assert_eq!(
            drained_last_words("echo 'first noise' >&2; echo 'the real sentence' >&2; echo >&2"),
            Some("the real sentence".to_owned())
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_stderr_tail_drops_what_it_cannot_keep_rather_than_blocking_the_writer() {
        // More lines than the tail keeps: the drain's job is to keep the pipe
        // empty and the last few lines; a writer that floods stderr must never
        // block on a full buffer because the keeper kept too much.
        let script = "for i in 1 2 3 4 5 6 7 8; do echo \"line $i\" >&2; done";
        assert_eq!(drained_last_words(script), Some("line 8".to_owned()));
    }

    #[cfg(unix)]
    #[test]
    fn a_silent_stderr_tails_to_nothing() {
        // Nothing on stderr means nothing to say; `None` is what keeps the
        // generic refusal honest rather than inventing a sentence.
        assert_eq!(drained_last_words("exit 0"), None);
    }

    #[test]
    fn a_refused_startup_is_terminal_on_the_first_try() {
        // Exit 2 is a config error. The crash guard would otherwise let a typo
        // spawn three processes before giving up, which is the same crash loop
        // with a shorter fuse.
        let decision = decide_after_exit(Some(EXIT_STARTUP_REFUSED), 0, FIRST_BACKOFF);
        match decision {
            ExitDecision::Stop { reason } => assert!(reason.contains("configuration"), "{reason}"),
            other => panic!("expected a terminal stop, got {other:?}"),
        }
    }

    #[test]
    fn an_ordinary_failure_retries_until_the_guard_trips() {
        // Two crashes retry, the third stops. The count is the caller's, so this
        // asserts the policy rather than the clock.
        for crashes in 1..CRASH_LIMIT {
            assert!(
                matches!(
                    decide_after_exit(Some(1), crashes, FIRST_BACKOFF),
                    ExitDecision::Retry { .. }
                ),
                "crash {crashes} should still retry"
            );
        }
        match decide_after_exit(Some(1), CRASH_LIMIT, FIRST_BACKOFF) {
            ExitDecision::Stop { reason } => {
                assert!(reason.contains("three times"), "{reason}");
            }
            other => panic!("expected the guard to trip, got {other:?}"),
        }
    }

    #[test]
    fn a_signalled_death_counts_as_a_crash() {
        // No exit code means killed — the OOM killer, a `kill -9`. Treating it as
        // a clean exit would leave the panel attached to nothing with nothing to
        // say about why.
        assert!(matches!(
            decide_after_exit(None, 1, FIRST_BACKOFF),
            ExitDecision::Retry { .. }
        ));
        assert!(matches!(
            decide_after_exit(None, CRASH_LIMIT, FIRST_BACKOFF),
            ExitDecision::Stop { .. }
        ));
    }

    #[test]
    fn the_backoff_doubles_and_stops_at_the_cap() {
        let mut delay = first_backoff();
        assert_eq!(delay, Duration::from_millis(250));
        assert_eq!(next_backoff(delay), Duration::from_millis(500));
        for _ in 0..40 {
            delay = next_backoff(delay);
            assert!(
                delay <= MAX_BACKOFF,
                "backoff must stay capped, got {delay:?}"
            );
        }
        assert_eq!(delay, MAX_BACKOFF);
    }

    #[test]
    fn the_crash_log_forgets_what_falls_out_of_the_window() {
        // Three failures a minute apart are three accidents, not a loop. Without
        // the window this would refuse to restart a session that had been running
        // fine for an hour between failures.
        let mut log = CrashLog::new();
        let start = Instant::now();
        assert_eq!(log.record(start), 1);
        assert_eq!(log.record(start + Duration::from_secs(1)), 2);
        assert_eq!(log.record(start + Duration::from_secs(2)), 3);
        // Far enough out that all three have aged past the window — the newest was
        // at `start + 2s`, so the probe has to clear that too, not just `start`.
        assert_eq!(log.record(start + CRASH_WINDOW + Duration::from_secs(3)), 1);
        // And the boundary itself: an entry exactly one window old is out, since
        // the window is what the last minute holds rather than what it touches.
        let mut boundary = CrashLog::new();
        assert_eq!(boundary.record(start), 1);
        assert_eq!(boundary.record(start + CRASH_WINDOW), 1);
    }

    #[test]
    fn asking_again_clears_the_history() {
        // The user has seen the failure and clicked anyway. Holding the old count
        // against them would make the second click do nothing.
        let mut log = CrashLog::new();
        let now = Instant::now();
        log.record(now);
        log.record(now);
        log.clear();
        assert_eq!(log.record(now), 1);
    }

    #[test]
    fn the_state_labels_are_stable_words_not_debug_output() {
        // The window shows these. Deriving them from `Debug` would let a variant
        // rename rewrite what a user reads.
        assert_eq!(ServiceState::Idle.label(), "idle");
        assert_eq!(ServiceState::Running.label(), "running");
        assert_eq!(
            ServiceState::Restarting {
                reason: "x".to_owned()
            }
            .label(),
            "restarting"
        );
        assert_eq!(
            ServiceState::Failed {
                reason: "x".to_owned()
            }
            .label(),
            "failed"
        );
        // Idle and Running speak for themselves; the other two carry the why.
        assert_eq!(ServiceState::Running.detail(), "");
        assert_eq!(
            ServiceState::Failed {
                reason: "boom".to_owned()
            }
            .detail(),
            "boom"
        );
    }

    #[test]
    fn the_failed_label_is_the_one_state_a_new_round_may_start_from() {
        // `main.rs` compares the window's `service-state` against this constant to
        // decide whether Start may run, and `panel.slint` swaps Restart for Start
        // on the same string. Three readers, one spelling — a rename that moved
        // only two of them would leave a button that either never appears or races
        // a live supervision round for the endpoint.
        assert_eq!(ServiceState::FAILED_LABEL, "failed");
        assert_eq!(
            ServiceState::Failed {
                reason: "three crashes".to_owned()
            }
            .label(),
            ServiceState::FAILED_LABEL
        );
        // And nothing else may: each of these means a round is still live, so
        // starting a second one would put two brains on one endpoint.
        for state in [
            ServiceState::Idle,
            ServiceState::Running,
            ServiceState::Restarting {
                reason: "backoff".to_owned(),
            },
        ] {
            assert_ne!(state.label(), ServiceState::FAILED_LABEL);
        }
    }

    #[test]
    fn a_fresh_round_starts_from_a_clean_crash_log() {
        // The guard trips on three crashes in a minute and `supervise` returns.
        // A new round builds its own `CrashLog`, which is what makes the user's
        // "try again" a first failure rather than the fourth — otherwise Start
        // would trip the guard again on the next single crash.
        let mut log = CrashLog::new();
        let start = Instant::now();
        for _ in 0..CRASH_LIMIT {
            log.record(start);
        }
        assert!(log.record(start) > CRASH_LIMIT);

        let mut fresh = CrashLog::new();
        assert_eq!(fresh.record(start), 1);
        assert_eq!(
            decide_after_exit(Some(1), 1, first_backoff()),
            ExitDecision::Retry {
                after: first_backoff(),
                reason: "the session exited 1; restarting".to_owned(),
            }
        );
    }

    #[test]
    fn the_child_inherits_locations_and_nothing_that_selects_behavior() {
        // This allowlist is what makes the settings file the authority: a stray
        // `SQUID_BROWSER` in whatever shell opened the panel must not outrank
        // what the form saved. It was covered by nothing, because every test
        // around it needed a real child.
        let parent = |name: &str| -> Option<String> {
            match name {
                "HOME" => Some("/home/me".to_owned()),
                "PATH" => Some("/usr/bin".to_owned()),
                "SQUID_CONFIG" => Some("/home/me/squid.json".to_owned()),
                // Where this login session's display and bus are. Without them a
                // panel-started brain on Linux cannot reach the desktop it exists
                // to observe, and says so once per poll forever.
                "DISPLAY" => Some(":0".to_owned()),
                "XAUTHORITY" => Some("/home/me/.Xauthority".to_owned()),
                "WAYLAND_DISPLAY" => Some("wayland-0".to_owned()),
                "DBUS_SESSION_BUS_ADDRESS" => Some("unix:path=/run/user/1000/bus".to_owned()),
                // Every one of these selects a behavior the form owns.
                "SQUID_BROWSER" => Some("darwin".to_owned()),
                "SQUID_WATCH_ROOT" => Some("/somewhere/else".to_owned()),
                "SQUID_TERMINAL" => Some("fifo".to_owned()),
                "PI_MODEL_PROVIDER" => Some("someone-elses-gateway".to_owned()),
                // And this one would point the child at another panel.
                "SQUID_PANEL_SOCKET" => Some("/tmp/not-ours".to_owned()),
                _ => None,
            }
        };

        let env = child_env("/run/squid/panel.sock", parent);
        let names: Vec<&str> = env.iter().map(|(name, _)| *name).collect();

        assert!(names.contains(&"HOME"));
        assert!(names.contains(&"PATH"));
        for reachable in [
            "DISPLAY",
            "XAUTHORITY",
            "WAYLAND_DISPLAY",
            "DBUS_SESSION_BUS_ADDRESS",
        ] {
            assert!(
                names.contains(&reachable),
                "{reachable} did not reach the child, so it cannot see the desktop"
            );
        }
        // The locator travels because it points at the file rather than
        // selecting a behavior; a panel opened with it must not edit one file
        // while its brain starts from another.
        assert!(names.contains(&"SQUID_CONFIG"));
        for blocked in [
            "SQUID_BROWSER",
            "SQUID_WATCH_ROOT",
            "SQUID_TERMINAL",
            "PI_MODEL_PROVIDER",
        ] {
            assert!(!names.contains(&blocked), "{blocked} reached the child");
        }
        // Absent variables stay absent: inventing a value here would be a new
        // default, separate from the brain's own.
        assert!(!names.contains(&"XDG_RUNTIME_DIR"));

        // The two the panel owns are the panel's, whatever the parent said.
        let socket = env
            .iter()
            .find(|(name, _)| *name == crate::transport::SOCKET_ENV)
            .map(|(_, value)| value.as_str());
        assert_eq!(socket, Some("/run/squid/panel.sock"));
        let supervised = env
            .iter()
            .find(|(name, _)| *name == SUPERVISED_ENV)
            .map(|(_, value)| value.as_str());
        assert_eq!(supervised, Some("1"));
        // Written last, so a parent value of the same name cannot shadow them:
        // `Command::env` keeps the final assignment.
        assert_eq!(
            names.iter().filter(|name| **name == SUPERVISED_ENV).count(),
            1
        );
    }

    #[test]
    fn the_supervised_flag_is_the_brains_permission_to_be_restarted() {
        // The brain refuses `op:"restart"` unless it sees this, because exiting
        // with nobody to respawn it would read as a crash to whoever started it
        // by hand. Only a real supervisor may set it, so it is asserted to be
        // present here and nowhere a parent could forge it in.
        let env = child_env("endpoint", |_| None);
        assert_eq!(
            env,
            vec![
                (crate::transport::SOCKET_ENV, "endpoint".to_owned()),
                (SUPERVISED_ENV, "1".to_owned()),
            ]
        );
    }

    /// Writes an executable that exits with `code`, and records each run by
    /// appending a line to `log`. Unix-only: the point is a real `spawn`/`wait`
    /// round trip, and a portable shim would test the shim.
    ///
    /// Written under a private name and `rename`d into place, because this
    /// suite runs its children in parallel and an `execve` racing the last
    /// write of a just-closed file is answered with `ETXTBSY` on Linux — the
    /// child that never runs, the run count that reads zero, and a suite that
    /// flakes about one round in six (issue #28). A rename is atomic and the
    /// file it publishes is held open by nobody.
    #[cfg(unix)]
    fn fake_brain(dir: &Path, log: &Path, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-brain");
        let staging = dir.join("fake-brain.staging");
        let body = format!("#!/bin/sh\necho run >> {}\n{script}\n", log.display());
        std::fs::write(&staging, body).expect("write the fake brain");
        let mut perms = std::fs::metadata(&staging).expect("stat").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&staging, perms).expect("chmod");
        std::fs::rename(&staging, &path).expect("publish the fake brain");
        path
    }

    #[cfg(unix)]
    fn runs_recorded(log: &Path) -> usize {
        std::fs::read_to_string(log)
            .map(|body| body.lines().count())
            .unwrap_or(0)
    }

    #[cfg(unix)]
    #[test]
    fn supervise_spawns_a_real_child_and_stops_when_it_refuses_startup() {
        // The spawn and wait themselves, not the policy around them: everything
        // else in this module is a pure function, and `spawn_brain`/`supervise`
        // had no test caller at all -- the env allowlist and the retry ladder
        // were connected to a real process only by review.
        let dir = std::env::temp_dir().join(format!("squid-sup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let log = dir.join("runs");
        // Exit 2 is "startup refused": a config error a retry cannot fix. One
        // run, then a terminal stop -- respawning a typo is the crash loop the
        // guard exists to prevent, just faster. The brain prints its config
        // error on stderr before exiting, exactly as the real one does, and the
        // failure must carry that sentence: it names the setting and the file,
        // and the person facing the "Start Squid again" button is the one
        // person guaranteed not to have a console to read it from.
        let brain = fake_brain(
            &dir,
            &log,
            "echo 'The config file at /tmp/squid/settings.json is not valid JSON: unexpected token' >&2\nexit 2",
        );

        let mut states: Vec<ServiceState> = Vec::new();
        supervise(
            &brain,
            "unused-endpoint",
            &Supervision::default(),
            |state| states.push(state),
        );

        assert_eq!(
            runs_recorded(&log),
            1,
            "a refused startup must not be retried; states: {states:?}"
        );
        assert_eq!(states.first().map(|s| s.label()), Some("running"));
        let last = states.last().expect("a terminal state was reported");
        assert_eq!(last.label(), ServiceState::FAILED_LABEL);
        let detail = last.detail();
        assert!(
            detail.contains("not valid JSON"),
            "the brain's own sentence must reach the failure detail: {detail}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn supervise_retries_a_crash_until_the_guard_trips() {
        // A brain that always fails is respawned with backoff and then stopped:
        // three non-zero exits in a minute is not transient, and respawning it
        // forever would burn a battery to hide a broken install. The ladder
        // starts at 250ms, so CRASH_LIMIT rounds cost well under a second.
        let dir = std::env::temp_dir().join(format!("squid-crash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let log = dir.join("runs");
        let brain = fake_brain(&dir, &log, "exit 1");

        let mut states: Vec<String> = Vec::new();
        supervise(
            &brain,
            "unused-endpoint",
            &Supervision::default(),
            |state| states.push(state.label().to_owned()),
        );

        // Exactly the guard's limit: the run that trips it is the last one.
        assert_eq!(runs_recorded(&log), CRASH_LIMIT);
        assert_eq!(
            states.last().map(String::as_str),
            Some(ServiceState::FAILED_LABEL)
        );
        // And it said why on the way, rather than dying quietly.
        assert!(states.iter().any(|label| label == "restarting"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_stop_ends_the_session_and_the_round_with_it() {
        // The bug this is here for: "Quit Squid" ended the panel's event loop and
        // left the brain running. No window, no tray icon, and a process still
        // observing the desktop and still calling a model.
        let dir = std::env::temp_dir().join(format!("squid-stop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let log = dir.join("runs");
        // A brain that does not exit on its own, which is what a healthy one looks
        // like: nothing but the stop can end this.
        let brain = fake_brain(&dir, &log, "exec sleep 30");

        let supervision = std::sync::Arc::new(Supervision::default());
        let watcher = std::sync::Arc::clone(&supervision);
        let running = std::sync::Arc::new(AtomicBool::new(false));
        let seen = std::sync::Arc::clone(&running);
        let brain_path = brain.clone();
        let thread = std::thread::spawn(move || {
            supervise(&brain_path, "unused-endpoint", &watcher, |state| {
                if state == ServiceState::Running {
                    seen.store(true, Ordering::SeqCst);
                }
            });
        });

        // Waited for, not slept past: the stop has to arrive while a child is
        // actually alive, or the test would pass against a panel that quit before
        // the brain existed.
        let deadline = Instant::now() + Duration::from_secs(10);
        while !running.load(Ordering::SeqCst) {
            assert!(Instant::now() < deadline, "the brain never started");
            std::thread::sleep(Duration::from_millis(10));
        }

        // No grace: this fake brain has no wire to be asked over, so the kill path
        // is the one under test — and the kill path is what has to be bounded.
        supervision.stop_within(Duration::ZERO);
        thread.join().expect("the supervising thread ended");

        assert!(supervision.stopping());
        assert_eq!(
            runs_recorded(&log),
            1,
            "a stopped session must not be respawned"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_stop_before_the_first_spawn_starts_nothing() {
        // The race the spawn-under-lock closes: a stop that lands between the
        // check and the spawn used to produce a child with nobody left to stop it.
        let dir = std::env::temp_dir().join(format!("squid-nostart-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let log = dir.join("runs");
        let brain = fake_brain(&dir, &log, "exec sleep 30");

        let supervision = Supervision::default();
        supervision.stop_within(Duration::ZERO);

        let mut states: Vec<String> = Vec::new();
        supervise(&brain, "unused-endpoint", &supervision, |state| {
            states.push(state.label().to_owned())
        });

        assert_eq!(
            runs_recorded(&log),
            0,
            "nothing may be spawned after a stop"
        );
        assert_eq!(states, vec!["idle".to_owned()]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn supervise_reports_a_missing_binary_instead_of_spinning_on_it() {
        // Spawning failed rather than the brain failing. Terminal, because the
        // next attempt runs the same execve against the same path -- and the
        // message names the path, which is the whole of what a double-clicking
        // user has to go on.
        let missing = Path::new("/nonexistent/squid-brain-that-is-not-there");
        let mut reported: Vec<ServiceState> = Vec::new();
        supervise(
            missing,
            "unused-endpoint",
            &Supervision::default(),
            |state| reported.push(state),
        );

        assert_eq!(reported.len(), 1, "a failed spawn must not report running");
        match reported.first() {
            Some(ServiceState::Failed { reason }) => {
                assert!(reason.contains("squid-brain-that-is-not-there"), "{reason}")
            }
            other => panic!("expected a Failed report, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_probe_answers_yes_only_when_something_is_accepting() {
        // The probe IS the double-start guard: `Bun.listen({ unix })` does not
        // reliably report EADDRINUSE, so two brains on one path would both appear
        // to bind and then split connections. A connect that succeeds is the one
        // cheap reliable answer this side has, and it had no test.
        use std::os::unix::net::UnixListener;

        let dir = std::env::temp_dir().join(format!("squid-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");

        // Nothing there at all: no session, so the supervisor should spawn. The
        // short budget is the whole difference from production, where the window
        // covers a session that is still binding.
        let short = Duration::from_millis(50);
        let absent = dir.join("absent.sock");
        assert!(!probe_until(&absent, short));

        // A live listener answers, so the panel attaches instead of starting a
        // second brain that would fight it for the socket.
        let live = dir.join("live.sock");
        let listener = UnixListener::bind(&live).expect("bind the fake session");
        assert!(session_is_listening(&live));

        // A stale socket file from a crashed run is not a false positive: the
        // connect is refused because nothing is accepting, so spawning is right.
        // The brain clears the stale path itself before binding.
        drop(listener);
        assert!(live.exists(), "the socket file outlives its listener");
        assert!(!probe_until(&live, short));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_exit_codes_match_the_protocol_documents_table() {
        // `docs/panel-protocol.md` publishes 2 as "startup refused" and 3 as
        // "stopped at a supervisor's request". Both sides read that table, so the
        // constants are pinned to it here rather than being trusted to stay put.
        assert_eq!(EXIT_STARTUP_REFUSED, 2);
        assert_eq!(EXIT_RESTART_REQUESTED, 3);
        assert_eq!(SUPERVISED_ENV, "SQUID_SUPERVISED");
    }
}
