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
