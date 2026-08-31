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
//! guard exists to prevent, just faster.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
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
    /// The one-word label the window shows. Deliberately not derived from
    /// `Debug`: a rename of a variant should not silently rewrite what a user
    /// reads.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Restarting { .. } => "restarting",
            Self::Failed { .. } => "failed",
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
    let deadline = Instant::now() + PROBE_TIMEOUT;
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

/// Spawns the brain, marked supervised.
///
/// The child's environment is inherited **plus** two variables: the endpoint it
/// should listen on and the supervised flag. Nothing else is injected, and that
/// is a decision rather than laziness — the config file is the authority for
/// every setting, and a panel that passed `SQUID_WATCH_ROOT` and friends would be
/// a second configuration path whose values silently outrank the file the
/// settings form writes. The one thing the panel knows and the file cannot is
/// where this panel is listening.
///
/// stdout and stderr are inherited so the brain's diagnostics land wherever the
/// panel's own do — a supervised run's log is the panel's console, and swallowing
/// it would make a failing session unexplainable.
pub fn spawn_brain(brain: &Path, endpoint: &str) -> io::Result<Child> {
    Command::new(brain)
        .env(crate::transport::SOCKET_ENV, endpoint)
        .env(SUPERVISED_ENV, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
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
pub fn supervise(brain: &Path, endpoint: &str, mut report: impl FnMut(ServiceState)) {
    let mut crashes = CrashLog::new();
    let mut backoff = first_backoff();
    loop {
        let mut child = match spawn_brain(brain, endpoint) {
            Ok(child) => child,
            Err(error) => {
                // Spawning failed rather than the brain failing: a missing
                // binary, a permission bit. Terminal, because the next attempt
                // runs the same `execve` against the same path.
                report(ServiceState::Failed {
                    reason: format!("could not start {}: {error}", brain.display()),
                });
                return;
            }
        };
        report(ServiceState::Running);

        let status = match child.wait() {
            Ok(status) => status,
            Err(error) => {
                report(ServiceState::Failed {
                    reason: format!("lost track of the session: {error}"),
                });
                return;
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
    fn the_exit_codes_match_the_protocol_documents_table() {
        // `docs/panel-protocol.md` publishes 2 as "startup refused" and 3 as
        // "stopped at a supervisor's request". Both sides read that table, so the
        // constants are pinned to it here rather than being trusted to stay put.
        assert_eq!(EXIT_STARTUP_REFUSED, 2);
        assert_eq!(EXIT_RESTART_REQUESTED, 3);
        assert_eq!(SUPERVISED_ENV, "SQUID_SUPERVISED");
    }
}
