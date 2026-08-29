//! The panel transport client half of `docs/panel-protocol.md`.
//!
//! The watch session listens; this process connects, reads pushed lines, and
//! writes control and answer lines back. Only the standard library: a socket, a
//! `BufReader`, and a sleep are the whole mechanism, and `Cargo.toml` staying
//! shut is part of the threat model for a process that turns a click into
//! permission to run a command.
//!
//! Two things here are load-bearing and easy to get subtly wrong:
//!
//! * **Reconnect.** The panel may be launched before the watch session, and the
//!   watch session may restart underneath it. A client that gave up on the first
//!   refusal would have to be restarted by hand for no reason, so connecting is a
//!   loop with a capped backoff rather than a single attempt.
//! * **Framing.** A socket delivers bytes, not lines: one read can hold half a
//!   line or three of them. Everything below reads through one buffered reader
//!   whose leftovers survive between reads, and no line is handed to the parser
//!   until its `\n` has arrived.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use std::fs::{File, OpenOptions};
#[cfg(unix)]
use std::os::unix::net::UnixStream;

/// The connected transport, chosen by the build target.
///
/// Unix is a domain socket. Windows is a named pipe, and a pipe client on
/// Windows is opened as a *file*: `CreateFileW` on `\\.\pipe\<name>` is the
/// documented way in, so `std::fs::File` is the std type that already wraps that
/// handle. It implements `Read + Write` like the socket does, which is why the
/// buffered framing and the backoff ladder below are written once for both.
///
/// Deliberately *not* a crate. `tokio` and `interprocess` both open pipes with
/// `FILE_FLAG_OVERLAPPED`, and std's synchronous read/write path aborts the
/// process on an overlapped handle; the async machinery is also the opposite of
/// what a blocking reader thread wants. `File` is both the smaller dependency
/// and the correct one.
#[cfg(unix)]
type PanelStream = UnixStream;
#[cfg(windows)]
type PanelStream = File;

/// What the UI thread holds in order to write, which is *not* the same shape on
/// both platforms — and this is the one place the two transports genuinely part
/// ways.
///
/// Unix parks a duplicated socket handle. Two descriptors on one socket read and
/// write independently, so the reader can sit blocked in `read` while the UI
/// thread writes past it.
///
/// Windows parks the pipe's **name** and opens a fresh connection per line,
/// because the duplicate trick does not hold there. `try_clone` is
/// `DuplicateHandle`, which yields two handles to one *file object*, and a handle
/// opened without `FILE_FLAG_OVERLAPPED` is a synchronous file object whose I/O
/// the I/O manager serializes on that object's lock. The reader parked in
/// `ReadFile` awaiting the next push would hold it, and a pause click would
/// block behind the reader until the server happened to send something — a panel
/// that looks frozen for as long as the session is quiet, which is exactly the
/// freeze the split exists to prevent.
///
/// A second *long-lived* connection would not do either: the server broadcasts
/// to every client, so a connection nobody drains grows the server's per-client
/// outbound buffer without bound. One connection per line is bounded by
/// construction, costs a `CreateFileW` per click, and preserves the rule that a
/// click with no server behind it is a click that did not happen — a refused open
/// drops the line exactly as a failed write does.
#[cfg(unix)]
type OutgoingHandle = UnixStream;
#[cfg(windows)]
type OutgoingHandle = PathBuf;

use crate::protocol::{parse_incoming, Incoming};

/// The capability variable. Off by default, like every other one: opening a
/// panel declares that this run can be observed and controlled.
pub const SOCKET_ENV: &str = "SQUID_PANEL_SOCKET";

/// The longest line this client will assemble.
///
/// Without a ceiling, a server that sends megabytes and no newline grows this
/// process's memory until the OOM killer settles it — and the panel is the
/// surface a user looks at to find out what is going on, so it is the worst
/// thing in the session to lose to a peer's bug. 64 KiB is far above any real
/// message: the largest field is sanitized agent text.
const MAX_LINE_BYTES: u64 = 64 * 1024;

/// First retry delay. Short enough that a watch session restarting under the
/// panel is picked up before the user notices.
const FIRST_BACKOFF: Duration = Duration::from_millis(125);

/// Ceiling for the retry delay. Capped rather than unbounded so a server that
/// comes back after an hour is still found promptly, and low enough that the
/// wait never looks like the panel has given up — while still being far off the
/// busy-loop that an uncapped-but-tiny delay would be.
const MAX_BACKOFF: Duration = Duration::from_secs(4);

/// Reads the socket path, or `None` when the panel was not asked to connect.
pub fn socket_path() -> Option<PathBuf> {
    path_from(std::env::var(SOCKET_ENV).ok())
}

/// An empty value reads as unset rather than as the empty path: exporting the
/// variable with nothing in it is how a shell says "not configured", and
/// `connect("")` would only fail on every attempt forever.
fn path_from(raw: Option<String>) -> Option<PathBuf> {
    let value = raw?;
    if value.is_empty() {
        return None;
    }
    Some(PathBuf::from(value))
}

/// The outgoing half of the connection, shared between the UI thread and the
/// reader thread.
///
/// The reader thread owns connecting, so it is also the thread that knows when
/// there is a socket to write to; it hands a clone of the stream in here on
/// connect and takes it back out on disconnect. The UI thread never blocks on
/// anything but this mutex, which is held only for the length of one small
/// write.
#[derive(Clone)]
pub struct Outgoing {
    handle: Arc<Mutex<Option<OutgoingHandle>>>,
}

impl Outgoing {
    pub fn new() -> Self {
        Self {
            handle: Arc::new(Mutex::new(None)),
        }
    }

    /// Writes one already-framed line, or drops it if there is nobody to write
    /// to.
    ///
    /// Dropping is deliberate and not a queue. A pause held while the server is
    /// away and delivered on reconnect would take effect at a moment the user
    /// did not choose, and an answer replayed later could authorize a plan that
    /// has already expired. A click with no server behind it is a click that did
    /// not happen; the panel keeps showing the gate the projection last
    /// reported, so nothing on screen claims otherwise.
    pub fn send(&self, line: &str) {
        // A poisoned lock means a thread panicked while holding this slot,
        // possibly mid-write. The bytes already on the wire cannot be
        // characterized, so appending to that stream could complete somebody
        // else's half-written line into a message nobody sent. Refusing to write
        // again is the only safe reading of that state.
        let Ok(mut slot) = self.handle.lock() else {
            return;
        };
        let Some(handle) = slot.as_ref() else {
            return;
        };
        // Clearing the slot is a Unix-only conclusion. There a failed write means
        // this handle is dead, and dropping it is all this side needs to do — the
        // reader loop replaces it. On Windows the handle is a name, not a
        // connection: a refused open says nothing about whether the reader is
        // still attached, so clearing here would silently mute every later click.
        if write_line(handle, line).is_err() && cfg!(unix) {
            *slot = None;
        }
    }

    fn adopt(&self, handle: OutgoingHandle) {
        if let Ok(mut slot) = self.handle.lock() {
            *slot = Some(handle);
        }
    }

    fn release(&self) {
        if let Ok(mut slot) = self.handle.lock() {
            *slot = None;
        }
    }

    /// Whether a connection is currently held. Exists for the tests; the panel
    /// deliberately does not render this, because "connected" is not one of the
    /// things the projection reports.
    #[cfg(test)]
    fn is_connected(&self) -> bool {
        self.handle
            .lock()
            .map(|slot| slot.is_some())
            .unwrap_or(false)
    }
}

/// Puts one framed line on the wire.
///
/// Unix writes through the parked socket handle. Windows opens the pipe, writes,
/// and lets the connection close at the end of this call — see [`OutgoingHandle`]
/// for why the write direction is its own connection there rather than a second
/// handle on the reader's.
#[cfg(unix)]
fn write_line(stream: &UnixStream, line: &str) -> io::Result<()> {
    // `&UnixStream` is itself `Write`, so the shared handle is borrowed rather
    // than taken mutably; nothing here mutates the socket.
    let mut stream = stream;
    // Flush explicitly. A stream wrapped in anything block-buffered turns an
    // unflushed line into a lost click, which looks exactly like a panel that
    // ignored the button.
    stream.write_all(line.as_bytes())?;
    stream.flush()
}

#[cfg(windows)]
fn write_line(pipe_name: &Path, line: &str) -> io::Result<()> {
    // Write access only: this connection never reads, so asking for read access
    // would claim a capability the call has no use for.
    let mut pipe = OpenOptions::new().write(true).open(pipe_name)?;
    pipe.write_all(line.as_bytes())?;
    pipe.flush()
}

/// Connects, reads until the connection ends, and connects again. Never returns.
///
/// Runs on the reader thread: `connect`, `read`, and `sleep` all block, and
/// blocking Slint's event loop would freeze the window. `deliver` is called on
/// this thread for every message, so its body must hop to the UI thread before
/// touching a property.
pub fn run(socket_path: &Path, outgoing: &Outgoing, mut deliver: impl FnMut(Incoming)) {
    let mut backoff = FIRST_BACKOFF;
    loop {
        if let Ok(stream) = connect(socket_path) {
            // This thread reads from the connection it just made; the UI thread
            // gets whatever it needs to write independently of that read. What
            // "independently" costs differs per platform, which is the whole
            // subject of [`OutgoingHandle`].
            if let Ok(handle) = outgoing_handle(&stream, socket_path) {
                // Reset only after a connection actually stands up. A ladder
                // that reset on attempt rather than success would never climb.
                backoff = FIRST_BACKOFF;
                outgoing.adopt(handle);
                read_messages(stream, &mut deliver);
                outgoing.release();
            }
        }
        // Sleep after a dropped connection as well as after a refused one: a
        // server that accepts and immediately closes would otherwise spin this
        // thread as fast as the kernel can complete a connect.
        thread::sleep(backoff);
        backoff = next_backoff(backoff);
    }
}

/// Opens the reading half of the connection, using the transport the build
/// target selects.
///
/// Unix keeps the filesystem socket and its mode-600 boundary. Windows opens the
/// named pipe the server bound, `\\.\pipe\<name>`: a pipe client is opened as a
/// file, and `OpenOptions::open` is `CreateFileW` with `OPEN_EXISTING`, so a
/// missing pipe fails rather than creating a file named after it.
///
/// Read access only. This connection is the reader's, the write direction is its
/// own (see [`OutgoingHandle`]), and a handle that cannot write is one that
/// cannot interleave a stray byte into the server's inbound framing.
///
/// No `WaitNamedPipe` on the busy path. If every instance is taken the open
/// fails with `ERROR_PIPE_BUSY` and the caller's backoff ladder retries, which is
/// the same shape as the "server is not up yet" case and needs no second
/// mechanism to express.
fn connect(socket_path: &Path) -> io::Result<PanelStream> {
    #[cfg(unix)]
    {
        PanelStream::connect(socket_path)
    }

    #[cfg(windows)]
    {
        OpenOptions::new().read(true).open(socket_path)
    }
}

/// Derives the UI thread's write handle from a connection the reader just made.
///
/// Fallible on Unix, where it is a `dup`, and infallible on Windows, where it is
/// the name that was passed in. Kept as one signature so `run` has one shape.
#[cfg(unix)]
fn outgoing_handle(stream: &UnixStream, _pipe_name: &Path) -> io::Result<OutgoingHandle> {
    stream.try_clone()
}

#[cfg(windows)]
fn outgoing_handle(_stream: &File, pipe_name: &Path) -> io::Result<OutgoingHandle> {
    Ok(pipe_name.to_path_buf())
}

/// One rung up the retry ladder.
///
/// Doubling rather than a fixed interval so a server that is simply not running
/// yet costs almost nothing to wait for, and a server that is down for a long
/// time is not polled thousands of times. Its own function because the cap is
/// the part worth a test: an uncapped ladder is a panel that takes minutes to
/// notice a watch session came back.
fn next_backoff(current: Duration) -> Duration {
    (current * 2).min(MAX_BACKOFF)
}

/// Splits a byte stream into lines and hands the recognized ones to `deliver`.
///
/// Returns on end of stream or on a read error; both mean the same thing to the
/// caller, which is that this connection is over.
///
/// The seam the tests use: anything `Read` will do, so the framing rules below
/// can be checked against a `&[u8]` with no server in sight.
pub fn read_messages<R: Read>(source: R, mut deliver: impl FnMut(Incoming)) {
    let mut reader = BufReader::new(source);
    let mut line = Vec::new();
    loop {
        line.clear();
        // `read_until` on a `take`, rather than `lines()`, for two reasons.
        // `lines()` has no ceiling — it will happily assemble a gigabyte — and
        // `Take` is what puts one on, being a `BufRead` itself when it wraps
        // one. And `lines()` decodes before it frames, so one invalid UTF-8 byte
        // becomes an error for the whole iterator; framing is defined on bytes
        // here and decoding happens per line, so a bad byte costs one line.
        let count = match reader
            .by_ref()
            .take(MAX_LINE_BYTES)
            .read_until(b'\n', &mut line)
        {
            Ok(0) => return,
            Ok(count) => count,
            Err(_) => return,
        };
        if line.last() != Some(&b'\n') {
            // No terminator. Either the ceiling cut a line that is still
            // arriving, or the stream ended without a final newline. An
            // unterminated line is not a message in either case: taking its
            // prefix would hand the parser a truncated object, and for the
            // over-long case the remainder is still queued and would reframe as
            // lines of its own — which is how one oversized blob turns into a
            // stream of plausible-looking garbage. Skip to the next newline and
            // resynchronize.
            if count as u64 == MAX_LINE_BYTES && skip_to_newline(&mut reader).is_err() {
                return;
            }
            continue;
        }
        // Decode per line and drop what will not decode. Lossy decoding is not
        // an option: the parser refuses a lone surrogate rather than showing
        // U+FFFD for exactly this reason, and substituting a replacement
        // character into text sitting next to a command would be a small lie
        // about what was sent.
        let Ok(text) = std::str::from_utf8(&line) else {
            continue;
        };
        // A malformed line is dropped, never guessed at — see `parse_incoming`.
        if let Some(message) = parse_incoming(text.trim_end_matches(['\n', '\r'])) {
            deliver(message);
        }
    }
}

/// Discards bytes through the end of the current line, in bounded chunks.
fn skip_to_newline<R: Read>(reader: &mut BufReader<R>) -> io::Result<()> {
    let mut discard = Vec::new();
    loop {
        discard.clear();
        let count = reader
            .by_ref()
            .take(MAX_LINE_BYTES)
            .read_until(b'\n', &mut discard)?;
        // End of stream, or the terminator found: either way the caller can go
        // back to reading whole lines.
        if count == 0 || discard.last() == Some(&b'\n') {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{AgentLine, Prompt, WorldState};

    /// Collects every message a byte slice yields, so each test below reads as
    /// "these bytes mean these messages".
    fn messages(bytes: &[u8]) -> Vec<Incoming> {
        let mut seen = Vec::new();
        read_messages(bytes, |message| seen.push(message));
        seen
    }

    const WORLD: &str =
        "{\"type\":\"world_state\",\"updatedAt\":\"2026-08-27T10:00:00.000Z\",\"gate\":\"open\"}";
    const CANCEL: &str = "{\"type\":\"cancel\",\"promptId\":4}";

    #[test]
    fn reads_several_lines_from_one_buffer() {
        let bytes = format!("{WORLD}\n{CANCEL}\n");
        assert_eq!(
            messages(bytes.as_bytes()),
            vec![
                Incoming::WorldState(WorldState {
                    updated_at: "2026-08-27T10:00:00.000Z".to_owned(),
                    last_event: None,
                    application: None,
                    window: None,
                    gate: Some("open".to_owned()),
                    selection_length: None,
                    recent_actions: None,
                    episode_events: None,
                }),
                Incoming::Cancel { prompt_id: 4 },
            ]
        );
    }

    #[test]
    fn a_line_split_across_reads_is_still_one_message() {
        // The framing invariant, exercised the way a socket actually behaves: a
        // reader that hands over whatever fits and makes the caller come back.
        // Chunking at one byte is the harshest version of the same thing.
        struct Dribble<'a> {
            rest: &'a [u8],
        }
        impl Read for Dribble<'_> {
            fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                if self.rest.is_empty() || out.is_empty() {
                    return Ok(0);
                }
                out[0] = self.rest[0];
                self.rest = &self.rest[1..];
                Ok(1)
            }
        }
        let bytes = format!("{CANCEL}\n{WORLD}\n");
        let mut seen = Vec::new();
        read_messages(
            Dribble {
                rest: bytes.as_bytes(),
            },
            |message| seen.push(message),
        );
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0], Incoming::Cancel { prompt_id: 4 });
    }

    #[test]
    fn a_trailing_partial_line_is_not_delivered() {
        // The stream ended mid-object. Parsing the prefix would mean acting on a
        // message whose sender never finished writing it.
        let bytes = format!("{CANCEL}\n{{\"type\":\"cancel\",\"promptI");
        assert_eq!(
            messages(bytes.as_bytes()),
            vec![Incoming::Cancel { prompt_id: 4 }]
        );
    }

    #[test]
    fn an_over_long_line_is_dropped_and_the_next_one_survives() {
        // The buffer bound, and the part that matters more than the bound: after
        // refusing the oversized line, the reader has to land on the *next*
        // newline rather than reframing the remainder into lines of its own.
        let huge = "x".repeat((MAX_LINE_BYTES as usize) * 3);
        let bytes = format!("{{\"type\":\"cancel\",\"summary\":\"{huge}\"}}\n{CANCEL}\n");
        assert_eq!(
            messages(bytes.as_bytes()),
            vec![Incoming::Cancel { prompt_id: 4 }]
        );
    }

    #[test]
    fn a_flood_with_no_newline_ends_rather_than_growing() {
        // No terminator at all. The point is that this returns: without the
        // ceiling it would assemble the whole thing in memory first.
        let bytes = vec![b'x'; (MAX_LINE_BYTES as usize) * 4];
        assert_eq!(messages(&bytes), Vec::new());
    }

    #[test]
    fn an_unparseable_line_costs_only_itself() {
        let bytes = format!("not json\n{{}}\n{CANCEL}\n");
        assert_eq!(
            messages(bytes.as_bytes()),
            vec![Incoming::Cancel { prompt_id: 4 }]
        );
    }

    #[test]
    fn a_line_that_is_not_utf8_costs_only_itself() {
        // Framing is defined on bytes and decoding happens per line, so an
        // invalid sequence does not end the connection. `lines()` would have
        // errored here and taken every later message with it.
        let mut bytes = b"{\"type\":\"cancel\",\"promptId\":1,\"x\":\"".to_vec();
        bytes.extend_from_slice(&[0xFF, 0xFE]);
        bytes.extend_from_slice(b"\"}\n");
        bytes.extend_from_slice(CANCEL.as_bytes());
        bytes.push(b'\n');
        assert_eq!(messages(&bytes), vec![Incoming::Cancel { prompt_id: 4 }]);
    }

    #[test]
    fn tolerates_crlf_and_a_missing_final_newline_on_the_last_line() {
        // A `\r` is not part of the object, and the parser rejects trailing
        // content, so it has to come off before parsing.
        let bytes = format!("{CANCEL}\r\n");
        assert_eq!(
            messages(bytes.as_bytes()),
            vec![Incoming::Cancel { prompt_id: 4 }]
        );
    }

    #[test]
    fn delivers_every_message_variant() {
        // The four variants over the wire, so a later change to the read path
        // cannot quietly stop forwarding one of them.
        let lines = [
            WORLD,
            "{\"type\":\"agent\",\"at\":\"t\",\"status\":\"replied\",\"text\":\"done\"}",
            "{\"type\":\"prompt\",\"promptId\":9,\"kind\":\"run_tests\",\"summary\":\"bun test\",\"expiresAt\":\"e\"}",
            CANCEL,
        ];
        let bytes = format!("{}\n", lines.join("\n"));
        let seen = messages(bytes.as_bytes());
        assert_eq!(seen.len(), 4);
        assert!(matches!(seen[0], Incoming::WorldState(_)));
        assert_eq!(
            seen[1],
            Incoming::Agent(AgentLine {
                at: "t".to_owned(),
                status: "replied".to_owned(),
                text: Some("done".to_owned()),
            })
        );
        assert_eq!(
            seen[2],
            Incoming::Prompt(Prompt {
                prompt_id: 9,
                kind: "run_tests".to_owned(),
                summary: "bun test".to_owned(),
                expires_at: "e".to_owned(),
            })
        );
        assert_eq!(seen[3], Incoming::Cancel { prompt_id: 4 });
    }

    #[test]
    fn backoff_doubles_and_stops_at_the_cap() {
        let mut delay = FIRST_BACKOFF;
        assert_eq!(next_backoff(delay), FIRST_BACKOFF * 2);
        // Enough rungs to overshoot the cap several times over; the point is that
        // it settles rather than growing without bound.
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
    fn an_unset_or_empty_socket_path_reads_as_not_configured() {
        // Off by default, like every capability variable. An exported-but-empty
        // value is a shell saying "not configured", not a request to connect to
        // the empty path forever.
        assert_eq!(path_from(None), None);
        assert_eq!(path_from(Some(String::new())), None);
        assert_eq!(
            path_from(Some("/tmp/squid.sock".to_owned())),
            Some(PathBuf::from("/tmp/squid.sock"))
        );
    }

    #[test]
    fn sending_with_no_connection_is_dropped_not_queued() {
        // A click with no server behind it is a click that did not happen. The
        // test is that it neither panics nor holds the line for later delivery
        // at a moment the user did not choose.
        let outgoing = Outgoing::new();
        assert!(!outgoing.is_connected());
        outgoing.send("{\"type\":\"control\",\"op\":\"pause\"}\n");
        assert!(!outgoing.is_connected());
    }

    #[cfg(unix)]
    #[test]
    fn a_write_to_a_closed_peer_drops_the_connection_rather_than_the_process() {
        // The reconnect contract from the writing side: a dead socket must leave
        // the slot empty so the reader loop replaces it, and must not be fatal.
        let (ours, theirs) = UnixStream::pair().expect("socketpair");
        let outgoing = Outgoing::new();
        outgoing.adopt(ours);
        assert!(outgoing.is_connected());
        drop(theirs);
        // The first write after the peer goes away may be accepted by the
        // kernel; the error surfaces on the one after. Both are sent because the
        // invariant is about where this ends up, not which write reports it.
        outgoing.send("{\"type\":\"control\",\"op\":\"pause\"}\n");
        outgoing.send("{\"type\":\"control\",\"op\":\"pause\"}\n");
        assert!(!outgoing.is_connected());
    }

    #[cfg(unix)]
    #[test]
    fn what_is_written_arrives_as_whole_lines() {
        // The other half of the seam: the framing this side produces is what the
        // server's reader is entitled to expect.
        let (ours, theirs) = UnixStream::pair().expect("socketpair");
        let outgoing = Outgoing::new();
        outgoing.adopt(ours);
        outgoing.send(&crate::protocol::control_line(
            crate::protocol::Control::Pause,
        ));
        outgoing.send(&crate::protocol::answer_line(
            3,
            crate::protocol::Answer::Approved,
        ));
        drop(outgoing);
        let mut received = String::new();
        BufReader::new(theirs)
            .read_to_string(&mut received)
            .expect("read back");
        assert_eq!(
            received,
            "{\"type\":\"control\",\"op\":\"pause\"}\n{\"type\":\"answer\",\"promptId\":3,\"answer\":\"approved\"}\n"
        );
    }
}
