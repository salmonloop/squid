import { posix as posixPath } from "node:path";

/**
 * Chooses whether this run exposes a control panel.
 *
 * Off by default, like every capability variable. Opening a panel declares that
 * this run can be observed and controlled: the socket shows what the sensors
 * just read and accepts pause and resume, so enabling it is a decision worth
 * asking for rather than assuming.
 *
 * Three outcomes, matching `resolveCaptureGate`: unset means no panel, a valid
 * endpoint for this platform enables it, and anything else is a startup
 * configuration error.
 *
 * The endpoint spelling names the transport, and each platform accepts exactly
 * one spelling. Unix takes an absolute filesystem path for a domain socket.
 * Windows takes a named pipe (`\\.\pipe\<name>`), because `std::os::unix` does
 * not exist there and the Rust panel picks its transport from the build target —
 * so a value either side could read differently would let the two ends
 * disagree about which transport they are on. Refusing the other platform's
 * spelling is what keeps that from happening silently.
 */
export type PanelResolution =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly socketPath: string }
  | { readonly configError: string };

export interface ResolvePanelOptions {
  readonly env?: Record<string, string | undefined>;
  /** Injected in tests; production uses the host platform. */
  readonly platform?: NodeJS.Platform;
}

/** The canonical prefix a Windows panel endpoint is normalized to. */
export const PANEL_PIPE_PREFIX = "\\\\.\\pipe\\";

/**
 * Normalizes a Windows named-pipe endpoint, or returns `null` when the value is
 * not one.
 *
 * The accepted shape mirrors Bun's own `is_valid_pipe_name`
 * (`src/runtime/socket/Listener.rs`), which is what actually decides whether
 * `Bun.listen({ unix })` binds a pipe or falls back to AF_UNIX on Windows:
 * two separators, `.` or `?`, a separator, `pipe`, a separator, and at least
 * one non-separator character of name. Bun accepts either slash and rewrites
 * the prefix to `\\.\pipe\`; this function returns the same normal form so the
 * server, the panel, and any diagnostic all name one string.
 *
 * Accepting either separator is deliberate: `\\.\pipe\x` inside a double-quoted
 * shell string, a JSON config, or a PowerShell assignment each need a different
 * amount of backslash doubling, and a user who lands on `//./pipe/x` has not
 * made a mistake worth a startup failure.
 *
 * `pipe` is matched case-exactly, though, and that asymmetry is not an
 * oversight. Bun compares those four bytes with `strings::eql`, so `\\.\PIPE\x`
 * is *not* a pipe to Bun — it falls through to the AF_UNIX branch. Being more
 * lenient here than Bun is precisely how this gate would come to accept a value
 * that then gets bound as something other than a pipe. The rule is that this
 * function answers exactly one question, with no daylight either way: will Bun
 * bind this string as a named pipe?
 */
export function parsePanelPipeName(value: string): string | null {
  const isSep = (character: string): boolean => character === "\\" || character === "/";
  // > 9 rather than >= 9: index 9 is the first character of the name itself, and
  // a prefix with no name behind it would bind a pipe called nothing.
  if (value.length <= 9) return null;
  if (!isSep(value[0]!) || !isSep(value[1]!)) return null;
  if (value[2] !== "." && value[2] !== "?") return null;
  if (!isSep(value[3]!)) return null;
  if (value.slice(4, 8) !== "pipe") return null;
  if (!isSep(value[8]!)) return null;
  if (isSep(value[9]!)) return null;
  // Only the prefix is normalized. The name itself is passed through untouched,
  // including any separators inside it: the pipe namespace is flat but permits
  // them, and rewriting a caller's name would connect them to a pipe they did
  // not ask for.
  return PANEL_PIPE_PREFIX + value.slice(9);
}

/**
 * Whether this endpoint is a Windows named pipe, and therefore has no
 * filesystem entry.
 *
 * Both inputs matter, and that is the whole point of the function existing.
 * Bun's pipe branch is `#[cfg(windows)]` — on any other platform the same
 * string is just a filename that happens to contain backslashes, and
 * `Bun.listen({ unix })` binds a real socket file for it. So a caller that
 * decided "pipe" from the spelling alone would, on Unix, skip the stale-path
 * check and skip the chmod, leaving a group-readable socket behind.
 *
 * The three things this answers for — do not stat the path, do not chmod it, do
 * not unlink it on close — are all the same question, so they read the same
 * function rather than each re-deriving it.
 */
export function isPanelNamedPipe(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && parsePanelPipeName(socketPath) !== null;
}

const WINDOWS_ENDPOINT_ERROR =
  "On Windows SQUID_PANEL_SOCKET must be a named pipe: \\\\.\\pipe\\<name>.";

export function resolvePanel(options: ResolvePanelOptions = {}): PanelResolution {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const path = env.SQUID_PANEL_SOCKET;
  if (path === undefined) return { enabled: false };

  // An empty value is a configuration error, not a second way to say "off":
  // it reads as an attempt to enable the panel that lost its path along the way,
  // and silently starting without one would hide the mistake.
  if (path.length === 0) {
    return { configError: "SQUID_PANEL_SOCKET must name a path, or be unset (off)." };
  }
  if (platform === "win32") {
    const pipeName = parsePanelPipeName(path);
    if (pipeName === null) return { configError: WINDOWS_ENDPOINT_ERROR };
    // The normalized form, not the value as written: everything downstream — the
    // bind, the panel's connect, a diagnostic naming the endpoint — should be
    // talking about one string.
    return { enabled: true, socketPath: pipeName };
  }
  // A pipe spelling on Unix would bind a socket file with backslashes in its
  // name that the panel binary never looks for, because the Rust side picks its
  // transport from the build target. POSIX `isAbsolute` already refuses it, and
  // it is named here so the reason is on the record.
  //
  // `posix.isAbsolute`, not the platform-sensitive `isAbsolute`: this branch is
  // the *non*-win32 one, so it must judge the path by POSIX rules no matter what
  // host it runs on. The bare export follows `process.platform`, which would make
  // `platform` a half-connected seam — it would pick the branch but not the
  // path semantics inside it, and on a Windows host `\\.\pipe\x` reads as an
  // absolute UNC path, so a caller asking about Linux would be told the pipe
  // spelling is fine there.
  if (!posixPath.isAbsolute(path)) {
    return { configError: "SQUID_PANEL_SOCKET must be an absolute path." };
  }

  return { enabled: true, socketPath: path };
}
