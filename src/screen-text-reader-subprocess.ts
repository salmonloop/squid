import { describeErrorForAudit } from "./audit-text.js";
import type {
  ScreenTextFrame,
  ScreenTextReader,
  ScreenTextReaderFactory,
} from "./screen-text-source.js";

/**
 * The polling loop every subprocess screen-text backend shares.
 *
 * The macOS reader was the first backend of this shape, and its loop — sample
 * without overlap, report errors only on transition, kill the in-flight query on
 * close — was the part worth keeping when a second and third platform arrived.
 * Nothing in that loop is macOS-specific, so it lives here, and a platform file
 * contributes exactly what differs: the command to spawn and the parser that
 * turns its stdout into a neutral frame. The adapter below imports none of the
 * platform files, so a fourth backend is one new file and one resolver line.
 *
 * Testability is the reason for the `run` seam: the loop is driven by a fake
 * sampler in CI, the same contract-not-operating-system posture as the rest of
 * the repository's subprocess code.
 */

/** What one sampler invocation observed. */
export interface SubprocessSample {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * One poll: spawns the platform query and resolves when it finishes. The loop
 * hands back the spawned process so `close()` can kill a query that is still
 * in flight — a poll can outlive the reader that started it, and letting the
 * subprocess outlive the reader leaks both processes and frames.
 */
export type ScreenTextSampler = (
  onSpawned: (process: { kill(): void }) => void,
) => Promise<SubprocessSample>;

export interface PollingScreenTextReaderOptions {
  /** The program name used in error messages, e.g. `"osascript"`. */
  readonly program: string;
  /** Poll interval in milliseconds. */
  readonly pollMs: number;
  readonly run: ScreenTextSampler;
  /** Turns one invocation's stdout into a frame, or null for a quiet observation. */
  readonly parse: (stdout: string, occurredAt: string) => ScreenTextFrame | null;
}

/**
 * Builds a `ScreenTextReaderFactory` from a poll loop and a platform sampler.
 *
 * The returned factory is the same object the macOS reader always returned: it
 * degrades rather than fails — an unreadable field is absence in the frame, and
 * a sample that describes no addressable process is a quiet observation — while
 * repeated identical failures collapse to one diagnostic per transition so a
 * revoked permission does not emit an identical error every second, forever.
 */
export function pollingScreenTextReaderFactory(
  options: PollingScreenTextReaderOptions,
): ScreenTextReaderFactory {
  const { program, pollMs, run, parse } = options;

  return ({ onFrame, onError }) => {
    let closed = false;
    let sampling = false;
    let activeProcess: { kill(): void } | null = null;
    let lastErrorMessage: string | null = null;

    // Failures repeat once per poll — an unresponsive host would otherwise emit
    // an identical diagnostic every interval. Only report transitions, and never
    // after close: a killed subprocess reports a broken pipe that says nothing
    // about the host.
    const reportError = (message: string): void => {
      if (closed || message === lastErrorMessage) return;
      lastErrorMessage = message;
      onError(new Error(message));
    };

    const sample = async (): Promise<void> => {
      // Polls must not overlap: a platform query can block for longer than the
      // interval, and a queued second query would only deepen the backlog.
      if (closed || sampling) return;
      sampling = true;
      const occurredAt = new Date().toISOString();

      try {
        const result = await run((child) => {
          activeProcess = child;
        });
        if (closed) return;

        if (result.exitCode !== 0) {
          reportError(
            `${program} exited ${result.exitCode}: ${result.stderr.trim() || "no stderr output"}`,
          );
          return;
        }

        const frame = parse(result.stdout, occurredAt);
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

    const reader: ScreenTextReader = {
      close: () => {
        closed = true;
        clearInterval(timer);
        // A poll can be mid-flight; killing it keeps the query from outliving
        // the reader that started it.
        activeProcess?.kill();
        activeProcess = null;
      },
    };
    return reader;
  };
}

/**
 * ASCII unit separator. Window titles routinely contain `|`, commas, and tabs,
 * so platform scripts join fields with a control character that UI text does
 * not carry. Kept in sync with the scripts that produce it.
 */
export const FIELD_SEPARATOR = "\u001F";

/**
 * One record per line, and the terminator spelled once.
 *
 * A streaming backend's records are newline-delimited, and the trailing
 * carriage return is stripped rather than tolerated: PowerShell writes CRLF,
 * every other producer here writes LF, and a stray CR at the end of the last
 * field would otherwise ride into a window title or a selection.
 */
const RECORD_TERMINATOR = "\n";
const TRAILING_CARRIAGE_RETURN = /\r$/;

/** One long-lived sampler process, as the streaming loop needs to see it. */
export interface StreamingChild {
  kill(): void;
  /** Resolves when the child exits, whatever the reason. */
  readonly exited: Promise<number>;
  /** Every chunk the child writes to stdout, in order. */
  onStdout(handler: (chunk: string) => void): void;
  onStderr(handler: (chunk: string) => void): void;
}

export interface StreamingScreenTextReaderOptions {
  /** The program name used in error messages, e.g. `"powershell"`. */
  readonly program: string;
  /** Spawns the long-lived sampler. Called once per reader, and again to restart. */
  readonly spawn: () => StreamingChild;
  /** Turns one record into a frame, or null for a quiet observation. One record is one line of stdout. */
  readonly parse: (line: string, occurredAt: string) => ScreenTextFrame | null;
  /** How long to wait before restarting a sampler that exited on its own. */
  readonly restartMs: number;
}

/**
 * The same contract as the polling loop, for a backend that samples *inside* one
 * long-lived process and prints a record per line.
 *
 * Which shape a platform wants is arithmetic, not taste. A per-poll spawn pays
 * whatever the interpreter costs to start, once per sample; on Windows that is
 * most of a second, measured, against roughly forty milliseconds for the UI
 * Automation query itself. Spawning per sample would spend twenty times as much
 * work starting a process as reading the screen, and at a one-second interval it
 * would never be idle. So the interval moves inside the child: it loads its
 * automation client once and prints a line each time it samples.
 *
 * What that buys costs a process this reader owns for its whole life, which is
 * most of the loop below. A child that exits on its own is restarted rather than
 * silently ending the capability — a script killed by a transient failure must not
 * leave a screen source that reports nothing forever and says nothing about why —
 * while a child that exits after `close` is neither restarted nor reported,
 * because that one was asked to go.
 *
 * Errors collapse to one diagnostic per transition, like the polling loop and for
 * the same reason: an unreadable desktop would otherwise emit an identical line
 * every interval, forever.
 */
export function streamingScreenTextReaderFactory(
  options: StreamingScreenTextReaderOptions,
): ScreenTextReaderFactory {
  const { program, spawn, parse, restartMs } = options;

  return ({ onFrame, onError }) => {
    let closed = false;
    let child: StreamingChild | null = null;
    let restartTimer: ReturnType<typeof setTimeout> | null = null;
    let lastErrorMessage: string | null = null;
    let buffer = "";

    const reportError = (message: string): void => {
      if (closed || message === lastErrorMessage) return;
      lastErrorMessage = message;
      onError(new Error(message));
    };

    const consume = (chunk: string): void => {
      if (closed) return;
      buffer += chunk;
      const parts = buffer.split(RECORD_TERMINATOR);
      // The tail is an incomplete record, and it waits for the next chunk rather
      // than being parsed: a record split across two reads is still one record.
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.replace(TRAILING_CARRIAGE_RETURN, "");
        if (line.length === 0) continue;
        const frame = parse(line, new Date().toISOString());
        // A record describing no addressable process — a lock screen, a secure
        // desktop — is a quiet observation, not a failure.
        lastErrorMessage = null;
        if (frame !== null) onFrame(frame);
      }
    };

    const schedule = (): void => {
      if (closed || restartTimer !== null) return;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        start();
      }, restartMs);
    };

    const start = (): void => {
      if (closed) return;
      // A restarted child starts from an empty buffer: whatever the last one left
      // unterminated is not the first half of this one's first record.
      buffer = "";
      let started: StreamingChild;
      try {
        started = spawn();
      } catch (error) {
        reportError(describeErrorForAudit(error));
        schedule();
        return;
      }
      child = started;
      started.onStdout(consume);
      // Stderr is a diagnostic, never a record: a script that complains while
      // still sampling must not have its complaint parsed as a frame.
      started.onStderr((chunk) => {
        const text = chunk.trim();
        if (text.length > 0) reportError(`${program}: ${text}`);
      });
      void started.exited.then((code) => {
        // Ignored when a newer child already replaced this one, so a restart that
        // races the old child's exit cannot cancel itself.
        if (closed || child !== started) return;
        child = null;
        reportError(`${program} exited ${code}; restarting the screen reader`);
        schedule();
      });
    };

    start();

    const reader: ScreenTextReader = {
      close: () => {
        closed = true;
        if (restartTimer !== null) clearTimeout(restartTimer);
        restartTimer = null;
        const running = child;
        child = null;
        running?.kill();
      },
    };
    return reader;
  };
}

/**
 * Parses the three-field identity record the lightweight backends emit:
 * process id, process name, window title.
 *
 * This is the shared counterpart of the macOS parser's six-field record: these
 * backends cannot read focus roles or selected text, so absence of those fields
 * is the honest reading, and `projectFrame` fills in the protocol's neutral
 * values. A missing process id means no addressable process, and the frame is
 * null — a lock screen, again, is quiet rather than an error.
 */
export function parseIdentityFrame(stdout: string, occurredAt: string): ScreenTextFrame | null {
  // The producers end their records differently — osascript and sh print LF,
  // PowerShell prints CRLF — and a stray CR must not become a field.
  const raw = stdout.replace(/\r?\n$/, "");
  const parts = raw.split(FIELD_SEPARATOR);

  const applicationId = parts[0] ?? "";
  if (applicationId.length === 0) return null;

  const applicationName = parts[1] ?? "";
  const windowTitle = parts.slice(2).join(FIELD_SEPARATOR);

  return {
    applicationId,
    occurredAt,
    ...(applicationName.length > 0 ? { applicationName } : {}),
    ...(windowTitle.length > 0 ? { windowTitle } : {}),
  };
}
