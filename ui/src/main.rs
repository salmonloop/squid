//! Squid's graphical confirmation surface: one native window, one answer.
//!
//! Spawned by `src/graphical-transport-stdio.ts`, which owns the timeout and the
//! fail-closed matrix. This process is deliberately dumb about policy: it shows
//! what it is told, reports a click, and stays silent about everything else.
//!
//! The two threads and why they exist: `stdin` reads block, and blocking the
//! Slint event loop would freeze the window mid-prompt. So a reader thread owns
//! stdin and hands work to the UI thread through `upgrade_in_event_loop`, which
//! is Slint's only sanctioned cross-thread entry point.
//!
//! Nothing here ever writes a line that was not caused by a click. Silence is a
//! refusal — the TypeScript side has its own deadline and treats a missing
//! answer as `timed_out`, never as consent — so every error path in this file is
//! allowed to simply do nothing.

mod protocol;

use std::io::{self, BufRead, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use protocol::{answer_line, parse_incoming, Answer, Incoming, Prompt};
use slint::ComponentHandle;

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

fn main() -> Result<(), slint::PlatformError> {
    let window = PromptWindow::new()?;
    let pending: Pending = Arc::new(Mutex::new(None));

    {
        let pending = Arc::clone(&pending);
        let handle = window.as_weak();
        window.on_approve(move || answer(&pending, &handle, Answer::Approved));
    }
    {
        let pending = Arc::clone(&pending);
        let handle = window.as_weak();
        window.on_decline(move || answer(&pending, &handle, Answer::Declined));
    }

    // Closing the window is a decline, not a hang.
    //
    // Both are refusals, so either is safe. Declining is the better one: the
    // engine's queue is serial, and a prompt that waits out its full timeout
    // holds every later candidate behind it. Dismissing a suggestion should not
    // cost the next one its turn.
    {
        let pending = Arc::clone(&pending);
        let handle = window.as_weak();
        window.window().on_close_requested(move || {
            answer(&pending, &handle, Answer::Declined);
            // `answer` already hid the window; hiding twice is not an error,
            // but letting Slint do it as well is redundant.
            slint::CloseRequestResponse::KeepWindowShown
        });
    }

    {
        let pending = Arc::clone(&pending);
        let handle = window.as_weak();
        thread::spawn(move || read_prompts(&handle, &pending));
    }

    // Not `window.run()`: that shows the window immediately, and an empty
    // "Squid wants to run:" frame sitting on screen with nothing pending would
    // be a lie. The window appears when a prompt arrives and hides when it is
    // answered, so its presence *is* the notification.
    //
    // `run_event_loop_until_quit` also keeps the process alive across a hidden
    // window, which is what lets one binary serve every prompt in a session
    // instead of flashing a new one each time.
    slint::run_event_loop_until_quit()
}

/// Reads stdin until the parent goes away.
fn read_prompts(window: &slint::Weak<PromptWindow>, pending: &Pending) {
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            // A read error is the parent's pipe dying, not a recoverable state.
            break;
        };
        match parse_incoming(&line) {
            Some(Incoming::Prompt(prompt)) => show(window, pending, prompt),
            Some(Incoming::Cancel { prompt_id }) => cancel(window, pending, prompt_id),
            // Unparseable input is dropped. Guessing at a malformed prompt would
            // mean showing the user a question we cannot vouch for the wording
            // of, and every field here describes a command about to run.
            None => {}
        }
    }
    quit();
}

/// Puts a prompt on screen and claims the pending slot for it.
fn show(window: &slint::Weak<PromptWindow>, pending: &Pending, prompt: Prompt) {
    // Claim before displaying: a click can only ever settle an id that is
    // already recorded, so there is no window in which the buttons are live but
    // unattributed.
    //
    // A prompt arriving while another is pending replaces it. The engine
    // serializes asks so this should not happen, and if it does the abandoned id
    // is one the TypeScript side has already stopped waiting for.
    *pending.lock().expect(POISONED) = Some(prompt.prompt_id);

    let posted = window.upgrade_in_event_loop(move |window| {
        window.set_action_kind(prompt.kind.into());
        window.set_summary(prompt.summary.into());
        window.set_expires_at(prompt.expires_at.into());
        if window.show().is_err() {
            // No display device, or the compositor refused. There is no way to
            // ask, so the honest move is to stop pretending we can: the
            // TypeScript side times out and fails closed.
            quit();
        }
    });
    if posted.is_err() {
        // The event loop is gone, so nothing can be shown ever again.
        quit();
    }
}

/// Withdraws a prompt the engine has given up on.
fn cancel(window: &slint::Weak<PromptWindow>, pending: &Pending, prompt_id: i64) {
    {
        let mut slot = pending.lock().expect(POISONED);
        // A cancel for an id that is no longer pending is stale — it names a
        // prompt already answered or already replaced. Acting on it would close
        // a live window and lose an answer the user is about to give.
        if *slot != Some(prompt_id) {
            return;
        }
        *slot = None;
    }
    let _ = window.upgrade_in_event_loop(|window| {
        let _ = window.hide();
    });
}

/// Writes one answer for the pending prompt, then clears the window.
///
/// Runs on the UI thread: both button callbacks and the close handler are Slint
/// callbacks. Takes the pending id, so a second click after the first answer
/// finds nothing to answer.
fn answer(pending: &Pending, window: &slint::Weak<PromptWindow>, answer: Answer) {
    let Some(prompt_id) = pending.lock().expect(POISONED).take() else {
        // Nothing pending: a click that raced a cancel, or a second click on an
        // already-answered prompt. Writing an uncorrelated answer here is the
        // one thing that could authorize the wrong plan.
        return;
    };

    let line = answer_line(prompt_id, answer);
    let mut out = io::stdout().lock();
    // A write or flush failure means the parent is gone, so this answer reaches
    // nobody and no later one will either. Flush explicitly: stdout to a pipe is
    // block-buffered, and an answer sitting in a buffer is a hang.
    if out.write_all(line.as_bytes()).is_err() || out.flush().is_err() {
        quit();
        return;
    }

    if let Some(window) = window.upgrade() {
        let _ = window.hide();
    }
}

/// Ends the event loop from any thread, so `main` returns and the process exits.
fn quit() {
    // Called from the reader thread as well as the UI thread; the closure hop is
    // what makes it safe from both. A failure to post means the loop has already
    // stopped, which is the state this function was trying to reach.
    let _ = slint::invoke_from_event_loop(|| {
        let _ = slint::quit_event_loop();
    });
}
