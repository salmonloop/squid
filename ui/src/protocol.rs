//! The line protocol the TypeScript transport speaks, parsed and written
//! without a JSON library.
//!
//! The spec both sides are written against is `docs/panel-protocol.md`; this
//! module is the Rust half of it.
//!
//! Incoming, one JSON object per line:
//!
//! ```jsonc
//! {"type":"world_state","updatedAt":"...","lastEvent":"file_saved","application":"Code","window":"main.ts","gate":"open","selectionLength":42,"recentActions":"copy;file_saved","episodeEvents":17}
//! {"type":"agent","at":"...","status":"replied","text":"ran the tests; they pass"}
//! {"type":"prompt","promptId":1,"candidateId":"...","kind":"run_tests","summary":"...","expiresAt":"...","why":"...","denyConsequence":"..."}
//! {"type":"cancel","promptId":1}
//! {"type":"service","agentState":"ready"}
//! {"type":"config","id":"watchRoot","label":"Watch root","kind":"text","value":"/","applies":"restart","group":"Files","description":"..."}
//! {"type":"config_end","count":21}
//! {"type":"config_result","id":"watchRoot","ok":1,"applies":"restart"}
//! {"type":"source","id":"filesystem-local","label":"Filesystem","state":"running"}
//! {"type":"source_end","count":5}
//! {"type":"source_result","id":"filesystem-local","ok":1}
//! ```
//!
//! Outgoing, one per line:
//!
//! ```jsonc
//! {"type":"control","op":"pause"}
//! {"type":"answer","promptId":1,"answer":"approved"}
//! {"type":"config_get"}
//! {"type":"config_set","id":"watchRoot","value":"/home/me"}
//! {"type":"source_get"}
//! {"type":"source_toggle","id":"filesystem-local","on":0}
//! ```
//!
//! Hand-written rather than `serde_json` because this process is the one that
//! turns a click into permission to run a command, and into a pause of the
//! machine's own capture: flat objects of scalar fields with no nesting are less
//! code than the dependency, and all of it is auditable here. The panel's supply
//! chain is part of its threat model, so `Cargo.toml` gains nothing for this.
//!
//! It is a real structural parser, not a substring search. `summary` and `text`
//! carry command output and assistant prose, and a scan for `"kind":` would
//! happily find one *inside* that string — a summary containing
//! `{"kind":"run_tests"}` could then rewrite the very field describing what is
//! about to run, and an agent `text` containing `{"type":"control","op":"pause"}`
//! could otherwise read as a message rather than as something the agent said.
//! Keys are only read where a key can appear.

/// A recognized incoming message.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Incoming {
    /// The projection changed. Every field here has already passed the TS side's
    /// sanitizers, because what the panel shows is what the sensors just read.
    WorldState(WorldState),
    /// The agent finished a turn.
    Agent(AgentLine),
    Prompt(Prompt),
    /// The engine gave up on this prompt; close it without answering.
    Cancel {
        prompt_id: i64,
    },
    /// The brain's own state, replayed on every connect. Not an event — a
    /// standing fact, and the one signal the settings form is the way out of.
    Service {
        agent_state: String,
    },
    /// One settings row. The schema rides on the wire (`kind`, `label`,
    /// `applies`, enum `values`), so this side holds no key names and renders
    /// every row the same generic way — a key hardcoded here would be a second
    /// schema to keep in sync with the brain's.
    Config(ConfigLine),
    /// Closes a settings dump. `count` is the sizing contract, like the dump
    /// lists in the protocol doc.
    ConfigEnd {
        count: i64,
    },
    /// The verdict on one `config_set` — or on the dump itself when `id` is
    /// absent. This is the only place a save's outcome is stated; the form
    /// reports what this line said, never what the click hoped for.
    ConfigResult(ConfigResultLine),
    /// One row of the source catalog — running, stopped, or unsupported, all
    /// three shown so an un-toggleable capability is visible, not hidden.
    Source(SourceLine),
    /// Closes a source dump, mirroring [`Incoming::ConfigEnd`].
    SourceEnd {
        count: i64,
    },
    /// The verdict on one toggle. The brain does not broadcast the new state
    /// with it, so this is the trigger to pull a fresh dump rather than to
    /// flip the row locally — optimism here would drift from the catalog.
    SourceResult(SourceResultLine),
}

/// The projection as the panel is allowed to see it.
///
/// Only `updated_at` is required: every other field describes something that may
/// simply not have been observed yet. "No foreground application has been seen"
/// is a real state, and the panel renders it as a dash rather than inventing a
/// value for it.
///
/// `selection_length` is a length and never the text. The selection is the one
/// piece of content that needs explicit consent to leave the machine, so it does
/// not cross this wire at all — there is no field here that could carry it.
///
/// `recent_actions` is a `;`-joined string rather than a list because the parser
/// is flat by design. Making it an array would mean growing array support, which
/// is exactly the second half-tested JSON implementation this module refuses to
/// become.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct WorldState {
    pub updated_at: String,
    pub last_event: Option<String>,
    pub application: Option<String>,
    pub window: Option<String>,
    pub gate: Option<String>,
    pub selection_length: Option<i64>,
    pub recent_actions: Option<String>,
    pub episode_events: Option<i64>,
}

/// One finished agent turn.
///
/// `text` is optional because a failed turn may have nothing to quote. It is
/// sanitized upstream; this side treats it as opaque display text and, being
/// parsed structurally, cannot mistake a message-shaped fragment inside it for a
/// message.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct AgentLine {
    pub at: String,
    pub status: String,
    pub text: Option<String>,
}

/// Everything a prompt is allowed to carry.
///
/// `candidateId` is accepted on the wire and deliberately not kept: the window
/// has no use for it, and a field that is never stored cannot be displayed.
/// There is no `arguments` field to drop, because the TypeScript side never
/// sends one — the selection cannot reach this process at all.
///
/// `why` and `deny_consequence` are optional additions rather than required
/// fields, and both are scalars. A nested object here would make an older panel
/// drop the whole line instead of ignoring the part it does not know, which is
/// the difference between a forward-compatible field and a breaking one.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Prompt {
    pub prompt_id: i64,
    pub kind: String,
    pub summary: String,
    pub expires_at: String,
    /// Why this is being asked now. Optional, and the panel shows nothing rather
    /// than inventing a reason: a capability that explains itself is worth more
    /// than a window that guesses on its behalf.
    pub why: Option<String>,
    /// What will not happen if the person refuses. The one sentence that turns a
    /// refusal from a guess into a decision, and the reason it is shown without
    /// being expanded.
    pub deny_consequence: Option<String>,
}

/// One settings row, exactly the fields the TS dump sends.
///
/// `value` is always a string on the wire, even for an int setting — the panel
/// renders it and sends it back verbatim, and any casting here would be a second
/// validator to disagree with the brain's. `values` arrives as the `;`-joined
/// string the flat wire mandates and stays joined: splitting it would be string
/// surgery in a place with no tests, and a joined list reads fine.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct ConfigLine {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub value: String,
    pub applies: String,
    pub overridden: Option<i64>,
    pub values: Option<String>,
    /// The user-facing capability this setting belongs to, named by the brain's
    /// own schema. Optional because an older brain does not send it; the panel
    /// groups by whatever arrives and recognizes no id of its own, which is what
    /// keeps the grouping out of this binary.
    pub group: Option<String>,
    /// One plain sentence saying what the setting does. A label alone cannot
    /// explain a retention window to someone who has not read the source.
    pub description: Option<String>,
    /// Whether a credential is already stored. Never the credential: the value
    /// itself is structurally absent from every dump, so without this flag an
    /// empty field is the only thing a saved key can look like — and that is
    /// indistinguishable from never having set one.
    pub secret_present: Option<i64>,
}

/// The verdict on one set. `id` is absent on a dump-level refusal, which is why
/// this is not part of [`ConfigLine`].
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct ConfigResultLine {
    pub id: Option<String>,
    pub ok: i64,
    pub applies: Option<String>,
    pub error: Option<String>,
}

/// One row of the source catalog.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct SourceLine {
    pub id: String,
    pub label: String,
    pub state: String,
    /// The newest diagnostic a running source has recorded, when it has one —
    /// the sentence separating "watching" from "running but blind" (a screen
    /// reader without its accessibility permission). Absent for stopped and
    /// unsupported rows, whose reasons the card already carries.
    pub detail: Option<String>,
}

/// The verdict on one toggle.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct SourceResultLine {
    pub id: Option<String>,
    pub ok: i64,
    pub error: Option<String>,
}

/// One field value. The protocol only uses strings and integers; `Other` exists
/// so an unrecognized value type in some future field is skipped rather than
/// poisoning the whole line.
#[derive(Debug, PartialEq, Eq, Clone)]
enum Value {
    Str(String),
    Int(i64),
    Other,
}

/// Parses one line, or `None` if it is not a message this process understands.
///
/// A malformed line is dropped rather than guessed at. Dropping is safe because
/// silence is a refusal: the TypeScript side has its own deadline and treats a
/// missing answer as `timed_out`, never as consent.
pub fn parse_incoming(line: &str) -> Option<Incoming> {
    let fields = parse_object(line)?;
    let kind_of_message = match field(&fields, "type")? {
        Value::Str(text) => text.as_str(),
        _ => return None,
    };
    // `type` decides which fields are required, so it is read before any of
    // them. `promptId` is only meaningful for the confirmation messages; a
    // `world_state` line does not carry one and must not be rejected for it.
    match kind_of_message {
        "world_state" => Some(Incoming::WorldState(WorldState {
            updated_at: text_field(&fields, "updatedAt")?,
            last_event: optional_text_field(&fields, "lastEvent"),
            application: optional_text_field(&fields, "application"),
            window: optional_text_field(&fields, "window"),
            gate: optional_text_field(&fields, "gate"),
            selection_length: optional_int_field(&fields, "selectionLength"),
            recent_actions: optional_text_field(&fields, "recentActions"),
            episode_events: optional_int_field(&fields, "episodeEvents"),
        })),
        "agent" => Some(Incoming::Agent(AgentLine {
            at: text_field(&fields, "at")?,
            status: text_field(&fields, "status")?,
            text: optional_text_field(&fields, "text"),
        })),
        "prompt" => Some(Incoming::Prompt(Prompt {
            prompt_id: int_field(&fields, "promptId")?,
            kind: text_field(&fields, "kind")?,
            summary: text_field(&fields, "summary")?,
            expires_at: text_field(&fields, "expiresAt")?,
            why: optional_text_field(&fields, "why"),
            deny_consequence: optional_text_field(&fields, "denyConsequence"),
        })),
        "cancel" => Some(Incoming::Cancel {
            prompt_id: int_field(&fields, "promptId")?,
        }),
        "service" => Some(Incoming::Service {
            agent_state: text_field(&fields, "agentState")?,
        }),
        "config" => Some(Incoming::Config(ConfigLine {
            id: text_field(&fields, "id")?,
            label: text_field(&fields, "label")?,
            kind: text_field(&fields, "kind")?,
            // Required even for a secret, whose value is the empty string: the
            // dump structurally never carries a credential, and an *absent*
            // value would be a different claim than "there is nothing to show".
            value: text_field(&fields, "value")?,
            applies: text_field(&fields, "applies")?,
            overridden: optional_int_field(&fields, "overridden"),
            values: optional_text_field(&fields, "values"),
            group: optional_text_field(&fields, "group"),
            description: optional_text_field(&fields, "description"),
            secret_present: optional_int_field(&fields, "secretPresent"),
        })),
        "config_end" => Some(Incoming::ConfigEnd {
            count: int_field(&fields, "count")?,
        }),
        "config_result" => Some(Incoming::ConfigResult(ConfigResultLine {
            // Absent when the refusal is about the dump rather than one key.
            id: optional_text_field(&fields, "id"),
            ok: flag_field(&fields, "ok")?,
            applies: optional_text_field(&fields, "applies"),
            error: optional_text_field(&fields, "error"),
        })),
        "source" => Some(Incoming::Source(SourceLine {
            id: text_field(&fields, "id")?,
            label: text_field(&fields, "label")?,
            state: text_field(&fields, "state")?,
            detail: optional_text_field(&fields, "detail"),
        })),
        "source_end" => Some(Incoming::SourceEnd {
            count: int_field(&fields, "count")?,
        }),
        "source_result" => Some(Incoming::SourceResult(SourceResultLine {
            id: optional_text_field(&fields, "id"),
            ok: flag_field(&fields, "ok")?,
            error: optional_text_field(&fields, "error"),
        })),
        _ => None,
    }
}

/// Serializes a control line, newline included.
///
/// The enum is the whole vocabulary, so a [`Control`] cannot name an operation
/// the TS side would drop.
pub fn control_line(op: Control) -> String {
    format!("{{\"type\":\"control\",\"op\":\"{}\"}}\n", op.as_wire())
}

/// The control operations that exist.
///
/// None of them changes capture state here. Pause and resume are appended to the
/// existing capture-gate command path, so a pause still produces a
/// `capture_gate_changed` event — the trace that tells a deliberate gap apart
/// from an idle machine.
///
/// `Restart` is the odd one and deliberately still just a line: this process
/// asks, and the brain decides. The brain refuses it outright unless it is a
/// supervised run, because a brain that exited with no supervisor to respawn it
/// would look like a crash to whoever started it by hand — so a panel that is not
/// the supervisor can send this and correctly get nothing back.
///
/// `Stop` is `Restart` without the coming back, and it carries no such condition:
/// a session asked to stop and stopping is never a lie about itself, whatever
/// started it. The panel sends it on the way out so the brain closes its store and
/// its session history on its own shutdown path — a kill would skip both, and
/// leaving the process alive would be worse still: the tray item says "Quit
/// Squid", and before this the desktop kept being observed with nothing left on
/// screen to say so.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Control {
    Pause,
    Resume,
    Restart,
    Stop,
}

impl Control {
    fn as_wire(self) -> &'static str {
        match self {
            Control::Pause => "pause",
            Control::Resume => "resume",
            Control::Restart => "restart",
            Control::Stop => "stop",
        }
    }
}

/// Serializes an answer line, newline included.
///
/// Tagged with `"type":"answer"` because the outgoing channel now carries control
/// lines too, and a reader that had to guess a message's kind from which fields
/// it happens to have is a reader that can guess wrong.
///
/// `answer` is not a free string: the two spellings the TypeScript side accepts
/// are the only two an [`Answer`] can hold, so this cannot emit a third that
/// would read as a broken surface.
pub fn answer_line(prompt_id: i64, answer: Answer) -> String {
    format!(
        "{{\"type\":\"answer\",\"promptId\":{},\"answer\":\"{}\"}}\n",
        prompt_id,
        answer.as_wire()
    )
}

/// The only two answers that exist.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Answer {
    Approved,
    Declined,
}

impl Answer {
    fn as_wire(self) -> &'static str {
        match self {
            Answer::Approved => "approved",
            Answer::Declined => "declined",
        }
    }
}

/// Serializes a `subscribe`, newline included.
///
/// The first line a *reading* connection sends, and the only line that changes
/// what a connection is rather than asking for something. Until it arrives the
/// server writes nothing to that connection.
///
/// It exists because accepting a connection and having a reader behind it are
/// different facts on Windows, where the write direction opens a connection per
/// line (see `transport::OutgoingHandle`). A server that replayed standing state
/// at accept would write into those write-only connections and get `EPIPE` per
/// click — and since the panel answers `service` by pulling its dumps, each
/// `EPIPE` would provoke two more. Declaring the reader is what breaks that loop
/// at its source rather than filtering its symptoms.
pub fn subscribe_line() -> String {
    "{\"type\":\"subscribe\"}\n".to_owned()
}

/// Serializes a `config_get`, newline included. No fields: the request is the
/// whole message, and the dump comes back as its own lines.
pub fn config_get_line() -> String {
    "{\"type\":\"config_get\"}\n".to_owned()
}

/// Serializes one `config_set`.
///
/// This is the first line this process writes that carries text a person typed,
/// which is why [`escape_json_string`] exists at all: every other outgoing field
/// is an enum spelling or an integer, and a `format!` over those cannot produce
/// an illegal object. A `value` holding a quote would, and the API key's one trip
/// across this wire is a `config_set`.
///
/// The brain re-validates everything anyway (kind rules, enum spellings, the
/// control-character ban), so this does not filter — it only makes sure what
/// arrives is the string the user typed rather than a broken object. Refusing
/// locally would be a second validator to disagree with the brain's.
pub fn config_set_line(id: &str, value: &str) -> String {
    format!(
        "{{\"type\":\"config_set\",\"id\":\"{}\",\"value\":\"{}\"}}\n",
        escape_json_string(id),
        escape_json_string(value)
    )
}

/// Serializes a `source_get`. Fieldless like [`config_get_line`].
pub fn source_get_line() -> String {
    "{\"type\":\"source_get\"}\n".to_owned()
}

/// Serializes one `source_toggle`.
///
/// `on` is a `bool` here and `1`/`0` on the wire: the flat protocol has no JSON
/// booleans, and the brain refuses anything that is not exactly one of those two
/// integers. Taking a `bool` means this side cannot emit the third value.
///
/// The id is escaped for the same reason as [`config_set_line`]'s, even though it
/// comes from a dump rather than a keyboard: it is a string this process did not
/// author, and the rule "escape what you did not write" is cheaper to keep than
/// to reason about per call site.
pub fn source_toggle_line(id: &str, on: bool) -> String {
    format!(
        "{{\"type\":\"source_toggle\",\"id\":\"{}\",\"on\":{}}}\n",
        escape_json_string(id),
        i32::from(on)
    )
}

/// Escapes a string for a JSON string body.
///
/// Handles exactly what JSON requires — quote, backslash, and every C0 control
/// character — and nothing more. Control characters become `\uXXXX` rather than
/// being dropped: the brain bans them and will refuse the line, and a *refusal*
/// naming the key is a better outcome than a silently-cleaned value the user
/// never sees was changed. Non-ASCII passes through as UTF-8, which the
/// TypeScript side's `JSON.parse` reads directly.
fn escape_json_string(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for character in raw.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            // The rest of C0, plus DEL, which JSON permits raw but the brain's
            // own ban covers — spelled as an escape either way so the line stays
            // one line and stays parseable.
            control if control < '\u{0020}' || control == '\u{007F}' => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            ordinary => out.push(ordinary),
        }
    }
    out
}

fn field<'a>(fields: &'a [(String, Value)], name: &str) -> Option<&'a Value> {
    // First occurrence wins. A duplicate key later in the object cannot override
    // an earlier one, so a crafted line cannot append a second `"kind"` to
    // replace the one already read.
    fields
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}

fn text_field(fields: &[(String, Value)], name: &str) -> Option<String> {
    match field(fields, name)? {
        Value::Str(text) => Some(text.clone()),
        _ => None,
    }
}

fn int_field(fields: &[(String, Value)], name: &str) -> Option<i64> {
    match field(fields, name)? {
        Value::Int(number) => Some(*number),
        _ => None,
    }
}

/// Reads a wire boolean, which the flat protocol spells `1` or `0`.
///
/// Strict where [`optional_int_field`] is lenient, and the split is the point:
/// `ok` decides whether the panel reports a save as landed or refused, so a `7`
/// arriving is not a verdict to be mapped onto one of the two answers — it is a
/// line to drop, the same posture `answer` takes with its two exact spellings.
/// Display-only fields stay lenient, because losing a whole reading over a
/// cosmetic field would cost the user more than the field is worth.
fn flag_field(fields: &[(String, Value)], name: &str) -> Option<i64> {
    match int_field(fields, name)? {
        value @ (0 | 1) => Some(value),
        _ => None,
    }
}

/// Reads an optional string field.
///
/// Absent and unreadable collapse to the same `None` on purpose. The spec says
/// absent fields are omitted rather than sent as `null`, so a `null` arriving is
/// already a sender not holding to the contract — but it means "nothing observed",
/// which is exactly `None`, and losing the other seven fields of a `world_state`
/// over it would cost the user the whole reading. A wrong *type* is treated the
/// same way for the same reason: this is display text, not a decision.
fn optional_text_field(fields: &[(String, Value)], name: &str) -> Option<String> {
    match field(fields, name) {
        Some(Value::Str(text)) => Some(text.clone()),
        _ => None,
    }
}

/// Reads an optional integer field. Absent, `null`, or a non-integer all read as
/// "not observed" — see [`optional_text_field`] for why that is not a silent
/// failure. A fractional number never gets this far: `parse_number` refuses it,
/// so the line is rejected outright rather than rounded into a plausible count.
fn optional_int_field(fields: &[(String, Value)], name: &str) -> Option<i64> {
    match field(fields, name) {
        Some(Value::Int(number)) => Some(*number),
        _ => None,
    }
}

/// Parses a flat JSON object into its top-level key/value pairs.
///
/// Rejects trailing content after the closing brace: two objects on one line is
/// not a message, and taking the first would let a sender smuggle a second.
fn parse_object(line: &str) -> Option<Vec<(String, Value)>> {
    let bytes = line.as_bytes();
    let mut at = 0usize;
    skip_whitespace(bytes, &mut at);
    if bytes.get(at) != Some(&b'{') {
        return None;
    }
    at += 1;
    let mut fields: Vec<(String, Value)> = Vec::new();
    skip_whitespace(bytes, &mut at);
    if bytes.get(at) == Some(&b'}') {
        at += 1;
        skip_whitespace(bytes, &mut at);
        return if at == bytes.len() {
            Some(fields)
        } else {
            None
        };
    }
    loop {
        skip_whitespace(bytes, &mut at);
        let key = parse_string(bytes, &mut at)?;
        skip_whitespace(bytes, &mut at);
        if bytes.get(at) != Some(&b':') {
            return None;
        }
        at += 1;
        skip_whitespace(bytes, &mut at);
        let value = parse_value(bytes, &mut at)?;
        fields.push((key, value));
        skip_whitespace(bytes, &mut at);
        match bytes.get(at) {
            Some(&b',') => at += 1,
            Some(&b'}') => {
                at += 1;
                break;
            }
            _ => return None,
        }
    }
    skip_whitespace(bytes, &mut at);
    if at == bytes.len() {
        Some(fields)
    } else {
        None
    }
}

fn parse_value(bytes: &[u8], at: &mut usize) -> Option<Value> {
    match bytes.get(*at)? {
        b'"' => parse_string(bytes, at).map(Value::Str),
        b'-' | b'0'..=b'9' => parse_number(bytes, at),
        b't' => expect_literal(bytes, at, b"true").map(|()| Value::Other),
        b'f' => expect_literal(bytes, at, b"false").map(|()| Value::Other),
        b'n' => expect_literal(bytes, at, b"null").map(|()| Value::Other),
        // No arrays, no nested objects. The protocol has none, and refusing them
        // keeps this parser to the shape it claims to handle rather than growing
        // a second, half-tested JSON implementation.
        _ => None,
    }
}

fn expect_literal(bytes: &[u8], at: &mut usize, literal: &[u8]) -> Option<()> {
    if bytes.len() < *at + literal.len() || &bytes[*at..*at + literal.len()] != literal {
        return None;
    }
    *at += literal.len();
    Some(())
}

/// Parses an integer. Fractions and exponents are refused rather than truncated:
/// `promptId` is a correlation id, and a rounded id would match the wrong ask.
fn parse_number(bytes: &[u8], at: &mut usize) -> Option<Value> {
    let start = *at;
    if bytes.get(*at) == Some(&b'-') {
        *at += 1;
    }
    let digits_start = *at;
    while matches!(bytes.get(*at), Some(b'0'..=b'9')) {
        *at += 1;
    }
    if *at == digits_start {
        return None;
    }
    if matches!(bytes.get(*at), Some(b'.') | Some(b'e') | Some(b'E')) {
        return None;
    }
    std::str::from_utf8(&bytes[start..*at])
        .ok()?
        .parse::<i64>()
        .ok()
        .map(Value::Int)
}

fn parse_string(bytes: &[u8], at: &mut usize) -> Option<String> {
    if bytes.get(*at) != Some(&b'"') {
        return None;
    }
    *at += 1;
    let mut out = String::new();
    loop {
        match bytes.get(*at)? {
            b'"' => {
                *at += 1;
                return Some(out);
            }
            b'\\' => {
                *at += 1;
                match bytes.get(*at)? {
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    b'b' => out.push('\u{0008}'),
                    b'f' => out.push('\u{000C}'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        *at += 1;
                        out.push(parse_unicode_escape(bytes, at)?);
                    }
                    _ => return None,
                }
                // Every arm above leaves `at` on the last byte of the escape,
                // including `\u`, so one shared step past it serves all of them.
                // A branch that advanced on its own would have to skip this, and
                // skipping it is how the last hex digit ends up copied into the
                // text as if it were content.
                *at += 1;
            }
            // Raw control characters are not legal in a JSON string, and a line
            // protocol cannot carry a raw newline at all.
            0x00..=0x1F => return None,
            _ => {
                // Copy one whole UTF-8 sequence. Slicing by byte would split a
                // multi-byte character; `from_utf8` on the run decides where the
                // boundary is.
                let start = *at;
                *at += utf8_width(bytes[*at])?;
                out.push_str(std::str::from_utf8(bytes.get(start..*at)?).ok()?);
            }
        }
    }
}

/// Reads `\uXXXX`, joining a surrogate pair when one follows.
///
/// A lone surrogate is refused rather than replaced: this text goes on screen
/// next to a command the user is about to authorize, and a silent U+FFFD in it
/// would be a small lie about what was sent.
///
/// Enters with `at` on the first hex digit and leaves it on the last byte
/// consumed — the low half's final digit for a pair — so the caller's single
/// step past the escape works for both shapes.
fn parse_unicode_escape(bytes: &[u8], at: &mut usize) -> Option<char> {
    let high = parse_hex4(bytes, at)?;
    if let Some(unit) = char::from_u32(u32::from(high)) {
        return Some(unit);
    }
    // Surrogate half: only a high surrogate followed by `\uDC00..=\uDFFF` is a
    // character.
    if !(0xD800..=0xDBFF).contains(&high) {
        return None;
    }
    if bytes.get(*at + 1) != Some(&b'\\') || bytes.get(*at + 2) != Some(&b'u') {
        return None;
    }
    *at += 3;
    let low = parse_hex4(bytes, at)?;
    if !(0xDC00..=0xDFFF).contains(&low) {
        return None;
    }
    let combined = 0x1_0000u32 + ((u32::from(high) - 0xD800) << 10) + (u32::from(low) - 0xDC00);
    char::from_u32(combined)
}

/// Reads exactly four hex digits, leaving `at` on the last one.
fn parse_hex4(bytes: &[u8], at: &mut usize) -> Option<u16> {
    let digits = bytes.get(*at..*at + 4)?;
    let mut value: u16 = 0;
    for digit in digits {
        let nibble = match digit {
            b'0'..=b'9' => digit - b'0',
            b'a'..=b'f' => digit - b'a' + 10,
            b'A'..=b'F' => digit - b'A' + 10,
            _ => return None,
        };
        value = value * 16 + u16::from(nibble);
    }
    *at += 3;
    Some(value)
}

fn utf8_width(lead: u8) -> Option<usize> {
    match lead {
        0x00..=0x7F => Some(1),
        0xC2..=0xDF => Some(2),
        0xE0..=0xEF => Some(3),
        0xF0..=0xF4 => Some(4),
        _ => None,
    }
}

fn skip_whitespace(bytes: &[u8], at: &mut usize) {
    while matches!(
        bytes.get(*at),
        Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n')
    ) {
        *at += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt_line(summary: &str) -> String {
        format!(
            "{{\"type\":\"prompt\",\"promptId\":7,\"candidateId\":\"req:candidate:0\",\"kind\":\"run_tests\",\"summary\":\"{}\",\"expiresAt\":\"2030-01-01T00:01:00.000Z\"}}",
            summary
        )
    }

    #[test]
    fn parses_a_prompt() {
        let parsed = parse_incoming(&prompt_line("bun test")).expect("recognized");
        assert_eq!(
            parsed,
            Incoming::Prompt(Prompt {
                prompt_id: 7,
                kind: "run_tests".to_owned(),
                summary: "bun test".to_owned(),
                expires_at: "2030-01-01T00:01:00.000Z".to_owned(),
                why: None,
                deny_consequence: None,
            })
        );
    }

    #[test]
    fn parses_a_cancel() {
        assert_eq!(
            parse_incoming("{\"type\":\"cancel\",\"promptId\":7}"),
            Some(Incoming::Cancel { prompt_id: 7 })
        );
    }

    #[test]
    fn a_key_inside_a_string_value_is_not_a_key() {
        // The reason this is a structural parser. A substring scan for
        // `"kind":` would find the one embedded in the summary and could be
        // steered into describing a different action than the one being run.
        let parsed = parse_incoming(&prompt_line(
            "bun test {\\\"kind\\\":\\\"delete_everything\\\"}",
        ))
        .expect("recognized");
        match parsed {
            Incoming::Prompt(prompt) => {
                assert_eq!(prompt.kind, "run_tests");
                assert_eq!(prompt.summary, "bun test {\"kind\":\"delete_everything\"}");
            }
            other => panic!("expected a prompt, got {other:?}"),
        }
    }

    #[test]
    fn a_duplicate_key_cannot_override_the_first() {
        let line = "{\"type\":\"prompt\",\"promptId\":1,\"kind\":\"run_tests\",\"summary\":\"s\",\"expiresAt\":\"e\",\"kind\":\"other\"}";
        match parse_incoming(line).expect("recognized") {
            Incoming::Prompt(prompt) => assert_eq!(prompt.kind, "run_tests"),
            other => panic!("expected a prompt, got {other:?}"),
        }
    }

    #[test]
    fn rejects_lines_that_are_not_one_object() {
        for line in [
            "",
            "not json",
            "[]",
            "{}",
            "{\"type\":\"prompt\"}",
            // promptId missing
            "{\"type\":\"cancel\"}",
            // promptId not an integer
            "{\"type\":\"cancel\",\"promptId\":\"7\"}",
            "{\"type\":\"cancel\",\"promptId\":1.5}",
            // an unknown message type is not a prompt
            "{\"type\":\"shutdown\",\"promptId\":1}",
            // a second object smuggled onto the same line
            "{\"type\":\"cancel\",\"promptId\":1}{\"type\":\"cancel\",\"promptId\":2}",
            // unterminated string
            "{\"type\":\"cancel\",\"promptId\":1,\"x\":\"open",
            // nested values are outside the protocol's shape
            "{\"type\":\"cancel\",\"promptId\":1,\"x\":{\"y\":1}}",
            "{\"type\":\"cancel\",\"promptId\":1,\"x\":[1]}",
        ] {
            assert_eq!(parse_incoming(line), None, "should reject: {line}");
        }
    }

    #[test]
    fn tolerates_an_unknown_scalar_field() {
        // Forward compatibility: a field this build does not know about must not
        // cost the user a window. A prompt that fails to parse is a suggestion
        // that silently never appears.
        let line = "{\"type\":\"cancel\",\"promptId\":1,\"future\":true,\"other\":null}";
        assert_eq!(
            parse_incoming(line),
            Some(Incoming::Cancel { prompt_id: 1 })
        );
    }

    #[test]
    fn decodes_escapes_including_astral_characters() {
        let parsed = parse_incoming(&prompt_line(
            "tab\\there \\u00e9 \\uD83D\\uDE00 \\\"quoted\\\"",
        ))
        .expect("recognized");
        match parsed {
            Incoming::Prompt(prompt) => {
                assert_eq!(prompt.summary, "tab\there é 😀 \"quoted\"");
            }
            other => panic!("expected a prompt, got {other:?}"),
        }
    }

    #[test]
    fn passes_through_raw_utf8() {
        let parsed = parse_incoming(&prompt_line("运行测试 é")).expect("recognized");
        match parsed {
            Incoming::Prompt(prompt) => assert_eq!(prompt.summary, "运行测试 é"),
            other => panic!("expected a prompt, got {other:?}"),
        }
    }

    #[test]
    fn rejects_a_raw_control_character_in_a_string() {
        // Written as an escape in this source on purpose: a literal control byte
        // in a file makes git treat it as binary and makes grep miss it.
        let line = format!(
            "{{\"type\":\"cancel\",\"promptId\":1,\"x\":\"bad{}\"}}",
            "\u{0007}"
        );
        assert_eq!(parse_incoming(&line), None);
    }

    #[test]
    fn rejects_a_lone_surrogate() {
        assert_eq!(parse_incoming(&prompt_line("\\uD83D alone")), None);
    }

    #[test]
    fn writes_both_answers() {
        assert_eq!(
            answer_line(7, Answer::Approved),
            "{\"type\":\"answer\",\"promptId\":7,\"answer\":\"approved\"}\n"
        );
        assert_eq!(
            answer_line(7, Answer::Declined),
            "{\"type\":\"answer\",\"promptId\":7,\"answer\":\"declined\"}\n"
        );
    }

    #[test]
    fn writes_both_control_ops() {
        assert_eq!(
            control_line(Control::Pause),
            "{\"type\":\"control\",\"op\":\"pause\"}\n"
        );
        assert_eq!(
            control_line(Control::Resume),
            "{\"type\":\"control\",\"op\":\"resume\"}\n"
        );
    }

    #[test]
    fn parses_a_world_state_with_every_field() {
        let line = "{\"type\":\"world_state\",\"updatedAt\":\"2026-08-27T10:00:00.000Z\",\"lastEvent\":\"file_saved\",\"application\":\"Code\",\"window\":\"main.ts\",\"gate\":\"open\",\"selectionLength\":42,\"recentActions\":\"copy;file_saved\",\"episodeEvents\":17}";
        assert_eq!(
            parse_incoming(line),
            Some(Incoming::WorldState(WorldState {
                updated_at: "2026-08-27T10:00:00.000Z".to_owned(),
                last_event: Some("file_saved".to_owned()),
                application: Some("Code".to_owned()),
                window: Some("main.ts".to_owned()),
                gate: Some("open".to_owned()),
                selection_length: Some(42),
                recent_actions: Some("copy;file_saved".to_owned()),
                episode_events: Some(17),
            }))
        );
    }

    #[test]
    fn parses_a_world_state_with_every_optional_field_absent() {
        // The first observation of a fresh run: a timestamp and nothing else seen
        // yet. Requiring more would mean the panel shows nothing until the
        // machine happens to have looked at an application.
        assert_eq!(
            parse_incoming("{\"type\":\"world_state\",\"updatedAt\":\"2026-08-27T10:00:00.000Z\"}"),
            Some(Incoming::WorldState(WorldState {
                updated_at: "2026-08-27T10:00:00.000Z".to_owned(),
                last_event: None,
                application: None,
                window: None,
                gate: None,
                selection_length: None,
                recent_actions: None,
                episode_events: None,
            }))
        );
    }

    #[test]
    fn a_null_optional_field_reads_as_absent() {
        // The spec says omit rather than send null, so this line is a sender not
        // holding to it. It still means "nothing observed", and dropping the whole
        // reading over one off-spec key would cost the user the other seven fields.
        let line = "{\"type\":\"world_state\",\"updatedAt\":\"t\",\"application\":null,\"selectionLength\":null,\"gate\":\"paused\"}";
        match parse_incoming(line).expect("recognized") {
            Incoming::WorldState(state) => {
                assert_eq!(state.application, None);
                assert_eq!(state.selection_length, None);
                assert_eq!(state.gate, Some("paused".to_owned()));
            }
            other => panic!("expected a world_state, got {other:?}"),
        }
    }

    #[test]
    fn a_world_state_needs_its_timestamp() {
        for line in [
            // updatedAt missing entirely
            "{\"type\":\"world_state\"}",
            // present but not a string: a misdated observation is worse than none
            "{\"type\":\"world_state\",\"updatedAt\":17}",
            "{\"type\":\"world_state\",\"updatedAt\":null}",
            // a fractional count is refused outright rather than rounded
            "{\"type\":\"world_state\",\"updatedAt\":\"t\",\"episodeEvents\":1.5}",
        ] {
            assert_eq!(parse_incoming(line), None, "should reject: {line}");
        }
    }

    #[test]
    fn parses_an_agent_line_with_and_without_text() {
        let line = "{\"type\":\"agent\",\"at\":\"2026-08-27T10:00:01.000Z\",\"status\":\"replied\",\"text\":\"ran the tests; they pass\"}";
        assert_eq!(
            parse_incoming(line),
            Some(Incoming::Agent(AgentLine {
                at: "2026-08-27T10:00:01.000Z".to_owned(),
                status: "replied".to_owned(),
                text: Some("ran the tests; they pass".to_owned()),
            }))
        );
        // A failed turn may have nothing to quote.
        assert_eq!(
            parse_incoming("{\"type\":\"agent\",\"at\":\"t\",\"status\":\"failed\"}"),
            Some(Incoming::Agent(AgentLine {
                at: "t".to_owned(),
                status: "failed".to_owned(),
                text: None,
            }))
        );
    }

    #[test]
    fn an_agent_line_needs_its_instant_and_status() {
        for line in [
            "{\"type\":\"agent\",\"status\":\"replied\"}",
            "{\"type\":\"agent\",\"at\":\"t\"}",
            "{\"type\":\"agent\",\"at\":\"t\",\"status\":null}",
        ] {
            assert_eq!(parse_incoming(line), None, "should reject: {line}");
        }
    }

    #[test]
    fn a_control_message_inside_agent_text_cannot_inject() {
        // The panel's own outgoing line, quoted verbatim by the agent. Structural
        // parsing is what keeps it prose: a scan for `"op":` would find one here,
        // and this text is written by whatever the agent was told to summarize.
        let line = "{\"type\":\"agent\",\"at\":\"t\",\"status\":\"replied\",\"text\":\"I sent {\\\"type\\\":\\\"control\\\",\\\"op\\\":\\\"pause\\\"}\"}";
        match parse_incoming(line).expect("recognized") {
            Incoming::Agent(agent) => {
                assert_eq!(agent.status, "replied");
                assert_eq!(
                    agent.text,
                    Some("I sent {\"type\":\"control\",\"op\":\"pause\"}".to_owned())
                );
            }
            other => panic!("expected an agent line, got {other:?}"),
        }
    }

    #[test]
    fn a_type_inside_a_world_state_string_cannot_retype_the_line() {
        // Same invariant from the other direction: an embedded `"type"` in a
        // window title must not turn a world_state into some other message.
        let line = "{\"type\":\"world_state\",\"updatedAt\":\"t\",\"window\":\"{\\\"type\\\":\\\"prompt\\\"}\"}";
        match parse_incoming(line).expect("recognized") {
            Incoming::WorldState(state) => {
                assert_eq!(state.window, Some("{\"type\":\"prompt\"}".to_owned()));
            }
            other => panic!("expected a world_state, got {other:?}"),
        }
    }

    #[test]
    fn the_new_variants_keep_the_shared_invariants() {
        // First key wins, no trailing object, no nesting, no raw control bytes —
        // the same rules the prompt path is held to, checked on the new types so
        // a later refactor cannot quietly exempt them.
        match parse_incoming(
            "{\"type\":\"world_state\",\"updatedAt\":\"first\",\"updatedAt\":\"second\"}",
        )
        .expect("recognized")
        {
            Incoming::WorldState(state) => assert_eq!(state.updated_at, "first"),
            other => panic!("expected a world_state, got {other:?}"),
        }
        let raw_control = format!(
            "{{\"type\":\"agent\",\"at\":\"t\",\"status\":\"replied\",\"text\":\"bad{}\"}}",
            "\u{0007}"
        );
        for line in [
            // a second object smuggled onto the same line
            "{\"type\":\"world_state\",\"updatedAt\":\"a\"}{\"type\":\"world_state\",\"updatedAt\":\"b\"}",
            // recentActions stays a joined string; an array is outside the shape
            "{\"type\":\"world_state\",\"updatedAt\":\"t\",\"recentActions\":[\"copy\"]}",
            "{\"type\":\"agent\",\"at\":\"t\",\"status\":\"replied\",\"text\":{\"y\":1}}",
            // a lone surrogate is refused, not replaced with U+FFFD
            "{\"type\":\"agent\",\"at\":\"t\",\"status\":\"replied\",\"text\":\"\\uD83D alone\"}",
            raw_control.as_str(),
        ] {
            assert_eq!(parse_incoming(line), None, "should reject: {line}");
        }
    }

    #[test]
    fn parses_a_service_line() {
        assert_eq!(
            parse_incoming("{\"type\":\"service\",\"agentState\":\"needs_config\"}"),
            Some(Incoming::Service {
                agent_state: "needs_config".to_owned(),
            })
        );
        // The state is carried as the string the brain sent, not mapped onto a
        // local enum: a spelling this build has not met must reach the window as
        // itself rather than being flattened into whichever variant is nearest.
        assert_eq!(
            parse_incoming("{\"type\":\"service\",\"agentState\":\"draining\"}"),
            Some(Incoming::Service {
                agent_state: "draining".to_owned(),
            })
        );
        // A service line with no state says nothing; there is no default that
        // would be honest here.
        assert_eq!(parse_incoming("{\"type\":\"service\"}"), None);
    }

    #[test]
    fn parses_a_config_row_with_and_without_its_optional_fields() {
        let line = "{\"type\":\"config\",\"id\":\"screenReader\",\"label\":\"Screen reader\",\"kind\":\"enum\",\"value\":\"linux\",\"applies\":\"restart\",\"overridden\":1,\"values\":\"synthetic;darwin;linux;windows\"}";
        assert_eq!(
            parse_incoming(line),
            Some(Incoming::Config(ConfigLine {
                id: "screenReader".to_owned(),
                label: "Screen reader".to_owned(),
                kind: "enum".to_owned(),
                value: "linux".to_owned(),
                applies: "restart".to_owned(),
                overridden: Some(1),
                // Stays joined. Splitting here would be string surgery the flat
                // wire exists to avoid.
                values: Some("synthetic;darwin;linux;windows".to_owned()),
                group: None,
                description: None,
                secret_present: None,
            }))
        );
        // A secret's value is the empty string, which is a real value and not an
        // absent one: the dump structurally never carries a credential.
        assert_eq!(
            parse_incoming(
                "{\"type\":\"config\",\"id\":\"apiKey\",\"label\":\"API key\",\"kind\":\"secret\",\"value\":\"\",\"applies\":\"now\"}"
            ),
            Some(Incoming::Config(ConfigLine {
                id: "apiKey".to_owned(),
                label: "API key".to_owned(),
                kind: "secret".to_owned(),
                value: String::new(),
                applies: "now".to_owned(),
                overridden: None,
                values: None,
                group: None,
                description: None,
                secret_present: None,
            }))
        );
    }

    /// The three display fields the grouped form needs, and the reason they are
    /// optional: a brain that predates them still produces a renderable row, and
    /// this side must not treat their absence as a malformed line.
    #[test]
    fn a_config_row_carries_its_group_description_and_secret_presence() {
        let line = "{\"type\":\"config\",\"id\":\"apiKey\",\"label\":\"API key\",\"kind\":\"secret\",\"value\":\"\",\"applies\":\"restart\",\"group\":\"Model\",\"description\":\"Lets Squid talk to the model.\",\"secretPresent\":1}";
        let Some(Incoming::Config(row)) = parse_incoming(line) else {
            panic!("recognized");
        };
        assert_eq!(row.group.as_deref(), Some("Model"));
        assert_eq!(
            row.description.as_deref(),
            Some("Lets Squid talk to the model.")
        );
        assert_eq!(row.secret_present, Some(1));
        // The credential itself is still structurally absent. A presence flag is
        // the whole disclosure; anything more would be the value by instalments.
        assert_eq!(row.value, "");
    }

    /// A prompt may explain itself, and the panel shows nothing when it does not.
    #[test]
    fn a_prompt_carries_its_reason_and_the_cost_of_refusing() {
        let line = "{\"type\":\"prompt\",\"promptId\":3,\"kind\":\"run_tests\",\"summary\":\"bun test\",\"expiresAt\":\"z\",\"why\":\"The tests were changed.\",\"denyConsequence\":\"Squid will not check them.\"}";
        let Some(Incoming::Prompt(prompt)) = parse_incoming(line) else {
            panic!("recognized");
        };
        assert_eq!(prompt.why.as_deref(), Some("The tests were changed."));
        assert_eq!(
            prompt.deny_consequence.as_deref(),
            Some("Squid will not check them.")
        );

        let bare = "{\"type\":\"prompt\",\"promptId\":3,\"kind\":\"run_tests\",\"summary\":\"bun test\",\"expiresAt\":\"z\"}";
        let Some(Incoming::Prompt(prompt)) = parse_incoming(bare) else {
            panic!("recognized");
        };
        assert_eq!(prompt.why, None);
        assert_eq!(prompt.deny_consequence, None);
    }

    #[test]
    fn a_config_row_missing_a_required_field_is_not_a_row() {
        // Five required fields, each dropped in turn. A row rendered with a
        // guessed kind would offer the wrong editor for the value.
        for line in [
            "{\"type\":\"config\",\"label\":\"L\",\"kind\":\"text\",\"value\":\"v\",\"applies\":\"now\"}",
            "{\"type\":\"config\",\"id\":\"i\",\"kind\":\"text\",\"value\":\"v\",\"applies\":\"now\"}",
            "{\"type\":\"config\",\"id\":\"i\",\"label\":\"L\",\"value\":\"v\",\"applies\":\"now\"}",
            "{\"type\":\"config\",\"id\":\"i\",\"label\":\"L\",\"kind\":\"text\",\"applies\":\"now\"}",
            "{\"type\":\"config\",\"id\":\"i\",\"label\":\"L\",\"kind\":\"text\",\"value\":\"v\"}",
        ] {
            assert_eq!(parse_incoming(line), None, "should reject: {line}");
        }
    }

    #[test]
    fn parses_both_dump_terminators() {
        assert_eq!(
            parse_incoming("{\"type\":\"config_end\",\"count\":21}"),
            Some(Incoming::ConfigEnd { count: 21 })
        );
        assert_eq!(
            parse_incoming("{\"type\":\"source_end\",\"count\":5}"),
            Some(Incoming::SourceEnd { count: 5 })
        );
        // The count is the sizing contract; a terminator without one closes a
        // dump of unknown length, which is not something to render.
        assert_eq!(parse_incoming("{\"type\":\"config_end\"}"), None);
        assert_eq!(
            parse_incoming("{\"type\":\"source_end\",\"count\":\"5\"}"),
            None
        );
    }

    #[test]
    fn parses_both_verdicts_in_both_directions() {
        assert_eq!(
            parse_incoming("{\"type\":\"config_result\",\"id\":\"watchRoot\",\"ok\":1,\"applies\":\"restart\"}"),
            Some(Incoming::ConfigResult(ConfigResultLine {
                id: Some("watchRoot".to_owned()),
                ok: 1,
                applies: Some("restart".to_owned()),
                error: None,
            }))
        );
        assert_eq!(
            parse_incoming(
                "{\"type\":\"config_result\",\"id\":\"retentionHours\",\"ok\":0,\"error\":\"Retention (hours) must be a whole number.\"}"
            ),
            Some(Incoming::ConfigResult(ConfigResultLine {
                id: Some("retentionHours".to_owned()),
                ok: 0,
                applies: None,
                error: Some("Retention (hours) must be a whole number.".to_owned()),
            }))
        );
        // No id: the refusal is about the dump itself, not one key.
        assert_eq!(
            parse_incoming("{\"type\":\"config_result\",\"ok\":0,\"error\":\"The config file is unreadable.\"}"),
            Some(Incoming::ConfigResult(ConfigResultLine {
                id: None,
                ok: 0,
                applies: None,
                error: Some("The config file is unreadable.".to_owned()),
            }))
        );
        assert_eq!(
            parse_incoming("{\"type\":\"source_result\",\"id\":\"browser-page-host\",\"ok\":0,\"error\":\"Source \\\"browser-page-host\\\" is the only observer; a watch session needs at least one.\"}"),
            Some(Incoming::SourceResult(SourceResultLine {
                id: Some("browser-page-host".to_owned()),
                ok: 0,
                error: Some(
                    "Source \"browser-page-host\" is the only observer; a watch session needs at least one."
                        .to_owned()
                ),
            }))
        );
    }

    #[test]
    fn a_verdict_needs_a_flag_that_is_exactly_zero_or_one() {
        // `ok` is the field that decides whether the form says "saved" or
        // "refused", so it is read strictly. There is no third answer to map a
        // stray number onto, and mapping it would make the panel state an
        // outcome the brain never claimed.
        for line in [
            "{\"type\":\"config_result\",\"id\":\"i\"}",
            "{\"type\":\"config_result\",\"id\":\"i\",\"ok\":7}",
            "{\"type\":\"config_result\",\"id\":\"i\",\"ok\":-1}",
            "{\"type\":\"config_result\",\"id\":\"i\",\"ok\":true}",
            "{\"type\":\"config_result\",\"id\":\"i\",\"ok\":\"1\"}",
            "{\"type\":\"source_result\",\"id\":\"i\",\"ok\":2}",
            "{\"type\":\"source_result\",\"id\":\"i\"}",
        ] {
            assert_eq!(parse_incoming(line), None, "should reject: {line}");
        }
    }

    #[test]
    fn parses_all_three_source_states() {
        // Every declared entry is rendered, including the one this run cannot
        // start: an un-toggleable capability must be visible rather than hidden.
        for state in ["running", "stopped", "unsupported"] {
            let line = format!(
                "{{\"type\":\"source\",\"id\":\"filesystem-local\",\"label\":\"Filesystem\",\"state\":\"{state}\"}}"
            );
            assert_eq!(
                parse_incoming(&line),
                Some(Incoming::Source(SourceLine {
                    id: "filesystem-local".to_owned(),
                    label: "Filesystem".to_owned(),
                    state: state.to_owned(),
                    detail: None,
                }))
            );
        }
        for line in [
            "{\"type\":\"source\",\"label\":\"Filesystem\",\"state\":\"running\"}",
            "{\"type\":\"source\",\"id\":\"i\",\"state\":\"running\"}",
            "{\"type\":\"source\",\"id\":\"i\",\"label\":\"L\"}",
        ] {
            assert_eq!(parse_incoming(line), None, "should reject: {line}");
        }
    }

    #[test]
    fn parses_the_optional_detail_on_a_source_row() {
        // The detail is how "running but blind" reaches the card: the source is
        // running, its reader keeps being refused, and the newest diagnostic is
        // the one sentence a person can act on. Absent means absent — the wire
        // omits what it does not have, and a stopped or unsupported row carries
        // no detail because the card already has words for those states.
        assert_eq!(
            parse_incoming(
                "{\"type\":\"source\",\"id\":\"screen-text-host\",\"label\":\"Screen\",\"state\":\"running\",\"detail\":\"xdotool exited 1: no DISPLAY\"}",
            ),
            Some(Incoming::Source(SourceLine {
                id: "screen-text-host".to_owned(),
                label: "Screen".to_owned(),
                state: "running".to_owned(),
                detail: Some("xdotool exited 1: no DISPLAY".to_owned()),
            }))
        );
        // A null reads as absent for the same reason every optional text field
        // does: display text, not a decision — see `optional_text_field`.
        assert_eq!(
            parse_incoming(
                "{\"type\":\"source\",\"id\":\"screen-text-host\",\"label\":\"Screen\",\"state\":\"running\",\"detail\":null}",
            )
            .expect("recognized"),
            Incoming::Source(SourceLine {
                id: "screen-text-host".to_owned(),
                label: "Screen".to_owned(),
                state: "running".to_owned(),
                detail: None,
            })
        );
    }

    #[test]
    fn the_settings_and_source_variants_keep_the_shared_invariants() {
        // The same four rules the prompt path is held to, checked on the newest
        // types so a later refactor cannot quietly exempt the ones that carry a
        // credential and a capability switch.
        match parse_incoming(
            "{\"type\":\"config\",\"id\":\"first\",\"label\":\"L\",\"kind\":\"text\",\"value\":\"v\",\"applies\":\"now\",\"id\":\"second\"}",
        )
        .expect("recognized")
        {
            Incoming::Config(row) => assert_eq!(row.id, "first"),
            other => panic!("expected a config row, got {other:?}"),
        }
        // A value that quotes a whole message stays a value. This is the field a
        // typed API key travels in, so a substring scan finding `"type":` inside
        // it would be the worst place in the protocol to have one.
        match parse_incoming(
            "{\"type\":\"config\",\"id\":\"watchRoot\",\"label\":\"L\",\"kind\":\"text\",\"value\":\"{\\\"type\\\":\\\"source_toggle\\\",\\\"id\\\":\\\"x\\\",\\\"on\\\":0}\",\"applies\":\"now\"}",
        )
        .expect("recognized")
        {
            Incoming::Config(row) => {
                assert_eq!(row.id, "watchRoot");
                assert_eq!(
                    row.value,
                    "{\"type\":\"source_toggle\",\"id\":\"x\",\"on\":0}"
                );
            }
            other => panic!("expected a config row, got {other:?}"),
        }
        let raw_control = format!(
            "{{\"type\":\"source\",\"id\":\"bad{}\",\"label\":\"L\",\"state\":\"running\"}}",
            "\u{0007}"
        );
        for line in [
            // a second object smuggled onto the same line
            "{\"type\":\"source_end\",\"count\":1}{\"type\":\"source_end\",\"count\":2}",
            // enum choices stay a joined string; an array is outside the shape
            "{\"type\":\"config\",\"id\":\"i\",\"label\":\"L\",\"kind\":\"enum\",\"value\":\"a\",\"applies\":\"now\",\"values\":[\"a\"]}",
            raw_control.as_str(),
        ] {
            assert_eq!(parse_incoming(line), None, "should reject: {line}");
        }
    }

    #[test]
    fn writes_the_settings_and_source_requests() {
        assert_eq!(config_get_line(), "{\"type\":\"config_get\"}\n");
        assert_eq!(source_get_line(), "{\"type\":\"source_get\"}\n");
        assert_eq!(
            config_set_line("watchRoot", "/home/me/code"),
            "{\"type\":\"config_set\",\"id\":\"watchRoot\",\"value\":\"/home/me/code\"}\n"
        );
        // Booleans ride as 1|0: the flat wire has no JSON booleans, and the brain
        // refuses anything else outright.
        assert_eq!(
            source_toggle_line("filesystem-local", false),
            "{\"type\":\"source_toggle\",\"id\":\"filesystem-local\",\"on\":0}\n"
        );
        assert_eq!(
            source_toggle_line("filesystem-local", true),
            "{\"type\":\"source_toggle\",\"id\":\"filesystem-local\",\"on\":1}\n"
        );
        assert_eq!(
            control_line(Control::Restart),
            "{\"type\":\"control\",\"op\":\"restart\"}\n"
        );
        assert_eq!(
            control_line(Control::Stop),
            "{\"type\":\"control\",\"op\":\"stop\"}\n"
        );
    }

    #[test]
    fn a_typed_value_cannot_break_out_of_its_own_field() {
        // The reason `escape_json_string` exists. A path with a quote in it is an
        // ordinary thing to type, and unescaped it would end the value early and
        // leave the rest of the characters reading as object syntax.
        let line = config_set_line("watchRoot", "/tmp/\"; rm -rf /");
        assert_eq!(
            line,
            "{\"type\":\"config_set\",\"id\":\"watchRoot\",\"value\":\"/tmp/\\\"; rm -rf /\"}\n"
        );
        // Round-trips through this module's own parser, which refuses trailing
        // content and unterminated strings — so a line that parses back to the
        // typed value is a line the brain's `JSON.parse` reads the same way.
        let echoed = line.trim_end();
        let fields = parse_object(echoed).expect("still one legal object");
        assert_eq!(
            text_field(&fields, "value"),
            Some("/tmp/\"; rm -rf /".to_owned())
        );
    }

    #[test]
    fn control_characters_and_backslashes_are_escaped_rather_than_dropped() {
        // A newline would end the line and turn the tail into a second message;
        // a backslash left alone would eat the closing quote. Both are spelled as
        // escapes rather than stripped: the brain bans control characters and
        // will refuse this key by name, which the user can see, whereas a quiet
        // cleanup changes the saved value without saying so.
        let line = config_set_line("watchRoot", "a\nb\\c\td\u{0001}e");
        assert_eq!(
            line,
            "{\"type\":\"config_set\",\"id\":\"watchRoot\",\"value\":\"a\\nb\\\\c\\td\\u0001e\"}\n"
        );
        let fields = parse_object(line.trim_end()).expect("one legal object");
        assert_eq!(
            text_field(&fields, "value"),
            Some("a\nb\\c\td\u{0001}e".to_owned())
        );
    }

    #[test]
    fn non_ascii_rides_through_as_utf8() {
        // No `\u` expansion for ordinary text: the wire is UTF-8 and both parsers
        // read it directly, so escaping it would only make the line longer and
        // the tests harder to read.
        let line = config_set_line("watchRoot", "/home/我的项目");
        assert!(line.contains("/home/我的项目"), "{line}");
        let fields = parse_object(line.trim_end()).expect("one legal object");
        assert_eq!(
            text_field(&fields, "value"),
            Some("/home/我的项目".to_owned())
        );
    }

    #[test]
    fn tolerates_an_unknown_scalar_field_on_the_new_variants() {
        // Forward compatibility, same as the prompt path: a field this build does
        // not know about must not cost the user the reading.
        let line =
            "{\"type\":\"world_state\",\"updatedAt\":\"t\",\"future\":true,\"gate\":\"open\"}";
        match parse_incoming(line).expect("recognized") {
            Incoming::WorldState(state) => assert_eq!(state.gate, Some("open".to_owned())),
            other => panic!("expected a world_state, got {other:?}"),
        }
    }
}
