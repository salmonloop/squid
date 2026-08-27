import { describeErrorForAudit } from "./audit-text.js";
import type {
  ScreenTextFocusRole,
  ScreenTextFrame,
  ScreenTextReaderFactory,
} from "./screen-text-source.js";

const DEFAULT_POLL_MS = 1_000;
/**
 * ASCII unit separator. Window titles and selected text routinely contain `|`,
 * commas, and tabs, so the script joins fields with a control character that UI
 * text does not carry.
 */
const FIELD_SEPARATOR = "\u001F";
const FIELD_COUNT = 6;
/**
 * Selected text is unbounded — a user can select a whole file — and each sample
 * would otherwise be persisted verbatim. Truncating keeps one selection from
 * dominating the event store; the heuristics that read selections only need the
 * leading text.
 */
const MAX_SELECTION_LENGTH = 4_096;

/**
 * One osascript invocation per poll, returning six separator-joined fields:
 * process name, unix id, front window title, focused role, focused description,
 * and `AXSelectedText`.
 *
 * Every lookup sits in its own `try`, nested inside the one it depends on, so a
 * process with no front window still yields a name and pid, and an element with
 * no `AXSelectedText` still yields a role. A field that could not be read comes
 * back empty rather than as an error — this reader's job is to degrade, not fail.
 */
const FOREGROUND_SCRIPT = `
set fields to {"", "", "", "", "", ""}
try
  tell application "System Events"
    set frontProcess to first application process whose frontmost is true
    try
      set item 1 of fields to (name of frontProcess) as text
    end try
    try
      set item 2 of fields to (unix id of frontProcess) as text
    end try
    try
      set frontWindow to front window of frontProcess
      try
        set item 3 of fields to (title of frontWindow) as text
      end try
      try
        set focusedElement to first UI element of frontWindow whose focused is true
        try
          set item 4 of fields to (role of focusedElement) as text
        end try
        try
          set item 5 of fields to (description of focusedElement) as text
        end try
        try
          set item 6 of fields to (value of attribute "AXSelectedText" of focusedElement) as text
        end try
      end try
    end try
  end tell
end try
set output to item 1 of fields
repeat with fieldIndex from 2 to 6
  set output to output & (ASCII character 31) & (item fieldIndex of fields)
end repeat
return output
`;

export interface MacosScreenTextReaderOptions {
  /** Poll interval. Default 1000ms. */
  readonly pollMs?: number;
}

/**
 * A `ScreenTextReaderFactory` backed by the macOS accessibility API through
 * `osascript`.
 *
 * This is the repository's first subprocess backend, and it is real but not
 * testable here: it needs a darwin host with an accessibility grant, so CI
 * exercises the seam and the adapter through a fake reader instead, and this
 * file is verified by hand with `SQUID_SCREEN_READER=darwin bun run watch:screen`.
 * That is the same posture as the SQLite conformance suite — test the contract,
 * not the operating system.
 *
 * Throws immediately off darwin rather than degrading, because a caller that
 * reached this function on Linux chose the wrong backend and silence would hide
 * that.
 */
export function createMacosScreenTextReader(
  options: MacosScreenTextReaderOptions = {},
): ScreenTextReaderFactory {
  if (process.platform !== "darwin") {
    throw new Error(
      `The macOS screen text reader requires darwin; this process reports ${process.platform}.`,
    );
  }

  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  return ({ onFrame, onError }) => {
    let closed = false;
    let sampling = false;
    let activeProcess: { kill(): void } | null = null;
    let lastErrorMessage: string | null = null;

    /**
     * osascript failures repeat once per poll — a revoked accessibility grant or
     * an unresponsive app would otherwise emit an identical diagnostic every
     * second, forever. Only report transitions, and never after close: a killed
     * subprocess reports a broken pipe that says nothing about the host.
     */
    const reportError = (message: string): void => {
      if (closed || message === lastErrorMessage) return;
      lastErrorMessage = message;
      onError(new Error(message));
    };

    const sample = async (): Promise<void> => {
      // Polls must not overlap: osascript can block for longer than the interval
      // when the frontmost app is busy, and a queued second query would only
      // deepen the backlog.
      if (closed || sampling) return;
      sampling = true;
      const occurredAt = new Date().toISOString();

      try {
        const child = Bun.spawn(["osascript", "-e", FOREGROUND_SCRIPT], {
          stdout: "pipe",
          stderr: "pipe",
        });
        activeProcess = child;
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (closed) return;

        if (exitCode !== 0) {
          reportError(`osascript exited ${exitCode}: ${stderr.trim() || "no stderr output"}`);
          return;
        }

        const frame = parseFrame(stdout, occurredAt);
        // A screen with no describable frontmost process — a lock screen, the
        // login window — is a quiet observation, not a failure.
        lastErrorMessage = null;
        if (frame !== null) onFrame(frame);
      } catch (error) {
        reportError(describeErrorForAudit(error));
      } finally {
        activeProcess = null;
        sampling = false;
      }
    };

    // Sample once immediately so the first frame does not wait a whole interval.
    void sample();
    const timer = setInterval(() => void sample(), pollMs);

    return {
      close: () => {
        closed = true;
        clearInterval(timer);
        // A poll can be mid-flight; killing it keeps osascript from outliving
        // the reader that started it.
        activeProcess?.kill();
        activeProcess = null;
      },
    };
  };
}

/**
 * Turns one script invocation's stdout into a neutral frame, or `null` when the
 * output describes no addressable process.
 *
 * Empty fields become absent frame fields rather than empty ones, because
 * osascript cannot distinguish "the query failed" from "the value is empty": a
 * window whose title could not be read and a window with no title both come back
 * as `""`. Reporting absence is the honest reading of that ambiguity, at the cost
 * of never emitting `window_changed` for a genuinely untitled window.
 */
function parseFrame(stdout: string, occurredAt: string): ScreenTextFrame | null {
  // osascript terminates a returned string with one newline. A selection that
  // itself ends in a newline loses that character here, which no consumer of
  // selected text depends on.
  const raw = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  const parts = raw.split(FIELD_SEPARATOR);
  if (parts.length < FIELD_COUNT) return null;

  const applicationName = parts[0] ?? "";
  const applicationId = parts[1] ?? "";
  const windowTitle = parts[2] ?? "";
  const role = parts[3] ?? "";
  const label = parts[4] ?? "";
  // Selected text is the one field that carries arbitrary user input, so it is
  // also the only place a stray separator can plausibly appear. Rejoining the
  // tail keeps such a selection intact instead of discarding the whole sample.
  const selection = parts.slice(FIELD_COUNT - 1).join(FIELD_SEPARATOR).slice(0, MAX_SELECTION_LENGTH);

  if (applicationId.length === 0) return null;

  return {
    applicationId,
    occurredAt,
    ...(applicationName.length > 0 ? { applicationName } : {}),
    ...(windowTitle.length > 0 ? { windowTitle } : {}),
    ...(role.length > 0 ? { focusedRole: mapRole(role) } : {}),
    ...(label.length > 0 ? { focusedLabel: label } : {}),
    // Honest scope: osascript exposes no stable caret position, so prefix and
    // suffix stay empty and this backend only reports text context when the user
    // has a selection — which is exactly what the `search_selection` heuristic
    // reads. Full caret context waits for an IDE or OCR backend.
    ...(selection.length > 0
      ? { textContext: { prefix: "", suffix: "", selection, language: null } }
      : {}),
  };
}

/**
 * Maps an `AXRole` onto the protocol's role union. macOS exposes no role that
 * distinguishes a code editor from any other multi-line text area, so nothing
 * here produces `"editor"`; an IDE source is what will report that.
 */
function mapRole(role: string): ScreenTextFocusRole {
  switch (role) {
    case "AXTextField":
    case "AXTextArea":
      return "text_input";
    case "AXButton":
      return "button";
    case "AXLink":
      return "link";
    default:
      return "unknown";
  }
}
