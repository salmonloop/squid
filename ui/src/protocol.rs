//! The line protocol the TypeScript transport speaks, parsed and written
//! without a JSON library.
//!
//! Incoming, one JSON object per line on stdin:
//!
//! ```jsonc
//! {"type":"prompt","promptId":1,"candidateId":"...","kind":"run_tests","summary":"...","expiresAt":"..."}
//! {"type":"cancel","promptId":1}
//! ```
//!
//! Outgoing, one per line on stdout:
//!
//! ```jsonc
//! {"promptId":1,"answer":"approved"}
//! ```
//!
//! Hand-written rather than `serde_json` because this process is the one that
//! turns a click into permission to run a command: five flat scalar fields with
//! no nesting is less code than the dependency, and all of it is auditable here.
//!
//! It is a real structural parser, not a substring search. `summary` carries
//! command text, and a scan for `"kind":` would happily find one *inside* that
//! string — a summary containing `{"kind":"run_tests"}` could then rewrite the
//! very field describing what is about to run. Keys are only read where a key
//! can appear.

/// A recognized incoming message.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Incoming {
    Prompt(Prompt),
    /// The engine gave up on this prompt; close it without answering.
    Cancel {
        prompt_id: i64,
    },
}

/// The four fields a prompt is allowed to carry.
///
/// `candidateId` is accepted on the wire and deliberately not kept: the window
/// has no use for it, and a field that is never stored cannot be displayed.
/// There is no `arguments` field to drop, because the TypeScript side never
/// sends one — the selection cannot reach this process at all.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Prompt {
    pub prompt_id: i64,
    pub kind: String,
    pub summary: String,
    pub expires_at: String,
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
    let prompt_id = match field(&fields, "promptId")? {
        Value::Int(id) => *id,
        _ => return None,
    };
    let kind_of_message = match field(&fields, "type")? {
        Value::Str(text) => text.as_str(),
        _ => return None,
    };
    match kind_of_message {
        "prompt" => Some(Incoming::Prompt(Prompt {
            prompt_id,
            kind: text_field(&fields, "kind")?,
            summary: text_field(&fields, "summary")?,
            expires_at: text_field(&fields, "expiresAt")?,
        })),
        "cancel" => Some(Incoming::Cancel { prompt_id }),
        _ => None,
    }
}

/// Serializes an answer line, newline included.
///
/// `answer` is not a free string: the two spellings the TypeScript side accepts
/// are the only two an [`Answer`] can hold, so this cannot emit a third that
/// would read as a broken surface.
pub fn answer_line(prompt_id: i64, answer: Answer) -> String {
    format!(
        "{{\"promptId\":{},\"answer\":\"{}\"}}\n",
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
            "{\"promptId\":7,\"answer\":\"approved\"}\n"
        );
        assert_eq!(
            answer_line(7, Answer::Declined),
            "{\"promptId\":7,\"answer\":\"declined\"}\n"
        );
    }
}
