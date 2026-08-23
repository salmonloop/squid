import { describeErrorForAudit } from "./action-egress.js";
import type { BrowserPageFrame, BrowserPageReaderFactory } from "./browser-page-source.js";

const DEFAULT_POLL_MS = 1_000;
/**
 * ASCII unit separator, for the same reason the screen-text reader uses it:
 * tab titles routinely contain `|`, commas, and tabs.
 */
const FIELD_SEPARATOR = "\u001F";
const FIELD_COUNT = 3;

/**
 * One osascript invocation per poll: owning process id, front window title,
 * and active-tab URL. Three fields, nothing more — a frame needs a page
 * identity and an owner, and every extra field is one more way for a browser
 * to disagree about what a poll returned.
 *
 * The script has to cover two families because neither alone observes every
 * browser. Chromium browsers expose the active tab through their AppleScript
 * dictionaries (`URL of active tab of front window`); Safari exposes a document
 * URL instead. Firefox exposes neither — its window title is all an
 * accessibility reader can see, so this backend reports nothing for it and the
 * source stays quiet rather than emitting a frame with a title masquerading as
 * a page identity.
 *
 * The browser-specific queries sit in their own try blocks so an unsupported
 * browser still yields the foreground facts; the owner fields matter on their
 * own, because `admitSearch` attributes a selection to the window that made it
 * and a frame without an owner is dropped by the reducer anyway.
 */
const BROWSER_PAGE_SCRIPT = `
set fields to {"", "", ""}
try
  tell application "System Events"
    set frontProcess to first application process whose frontmost is true
    try
      set item 1 of fields to (unix id of frontProcess) as text
    end try
    try
      set frontWindow to front window of frontProcess
      try
        set item 2 of fields to (title of frontWindow) as text
      end try
    end try
  end tell
end try
try
  using terms from application "Google Chrome"
    tell application "Google Chrome" to if (front window exists) then \\
      set item 3 of fields to (URL of active tab of front window) as text
  end using terms from
end try
try
  using terms from application "Safari"
    tell application "Safari" to if (front document exists) then \\
      set item 3 of fields to (URL of front document) as text
  end using terms from
end try
set output to item 1 of fields
repeat with fieldIndex from 2 to 3
  set output to output & (ASCII character 31) & (item fieldIndex of fields)
end repeat
return output
`;

export interface MacosBrowserPageReaderOptions {
  /** Poll interval. Default 1000ms. */
  readonly pollMs?: number;
}

/**
 * A `BrowserPageReaderFactory` backed by the same macOS accessibility channel
 * the screen-text reader uses — no extension install, no browser restart, no
 * debug port. This is the capture path goldfish.sh runs in production, which is
 * why it is the first real browser backend here.
 *
 * Not testable in CI for the same reason `screen-text-reader-macos.ts` is not:
 * it needs a darwin host with an automation grant. The seam, adapter, and
 * reducer are covered by unit tests against fake readers, and this file's
 * parser by direct unit test; the subprocess half is verified by hand with
 * `SQUID_BROWSER=darwin bun run watch:desktop -- <root>`.
 *
 * Throws immediately off darwin rather than degrading, matching the screen
 * reader: choosing this backend off macOS is a configuration mistake silence
 * would hide.
 *
 * Automation grants are per-application and prompted once per browser by macOS
 * itself; until granted, osascript fails with -1743 and this reader surfaces
 * that as a diagnostic instead of pretending no page exists.
 */
export function createMacosBrowserPageReader(
  options: MacosBrowserPageReaderOptions = {},
): BrowserPageReaderFactory {
  if (process.platform !== "darwin") {
    throw new Error(
      `The macOS browser page reader requires darwin; this process reports ${process.platform}.`,
    );
  }

  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  return ({ onFrame, onError }) => {
    let closed = false;
    let sampling = false;
    let activeProcess: { kill(): void } | null = null;
    let lastErrorMessage: string | null = null;

    /**
     * Report transitions only, exactly like the screen reader: a revoked grant
     * would otherwise emit one identical diagnostic per poll forever.
     */
    const reportError = (message: string): void => {
      if (closed || message === lastErrorMessage) return;
      lastErrorMessage = message;
      onError(new Error(message));
    };

    const sample = async (): Promise<void> => {
      // Polls must not overlap; see screen-text-reader-macos.ts.
      if (closed || sampling) return;
      sampling = true;
      const occurredAt = new Date().toISOString();

      try {
        const child = Bun.spawn(["osascript", "-e", BROWSER_PAGE_SCRIPT], {
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

        const frame = parseBrowserFrame(stdout);
        lastErrorMessage = null;
        // No URL is normal here — most foreground windows are not browsers at
        // all — so absence is quiet, not an error.
        if (frame !== null) onFrame(frame);
      } catch (error) {
        reportError(describeErrorForAudit(error));
      } finally {
        activeProcess = null;
        sampling = false;
      }
    };

    void sample();
    const timer = setInterval(() => void sample(), pollMs);

    return {
      close: () => {
        closed = true;
        clearInterval(timer);
        activeProcess?.kill();
        activeProcess = null;
      },
    };
  };
}

/**
 * Turns one invocation's stdout into a neutral frame, or `null` when there is
 * no page to describe.
 *
 * The rule is "a frame needs a URL and an owning process". A URL without a
 * process cannot be attributed to the foreground (and the reducer would drop
 * the owner anyway), and a process without a URL is not a browser page — it is
 * an editor, a terminal, anything else. Both are quiet observations.
 *
 * Empty optional fields become absent rather than empty strings, because
 * osascript cannot distinguish "unreadable" from "empty": reporting absence is
 * the honest reading of that ambiguity. This mirrors what
 * `projectBrowserFrame` will accept — a missing title stays missing rather than
 * being invented as `""`.
 */
export function parseBrowserFrame(stdout: string): BrowserPageFrame | null {
  const raw = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  const parts = raw.split(FIELD_SEPARATOR);
  if (parts.length < FIELD_COUNT) return null;

  // Positional from both ends: pid is the first field, URL the last, and
  // everything between is the window title rejoined — so a title that itself
  // contains the separator survives instead of shifting the URL.
  const applicationId = parts[0] ?? "";
  const url = parts[parts.length - 1] ?? "";
  const windowTitle = parts.slice(1, -1).join(FIELD_SEPARATOR);

  if (applicationId.length === 0 || url.length === 0) return null;

  return {
    url,
    ...(windowTitle.length > 0 ? { title: windowTitle } : {}),
    owner: {
      applicationId,
      windowTitle,
    },
  };
}
