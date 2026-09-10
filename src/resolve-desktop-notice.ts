import { createLinuxDesktopNotifier } from "./desktop-notice-linux.js";
import { createMacosDesktopNotifier } from "./desktop-notice-macos.js";
import { createWindowsDesktopNotifier } from "./desktop-notice-windows.js";
import type { DesktopNotifierFactory } from "./desktop-notice.js";

/**
 * Chooses how Squid speaks up, from the environment.
 *
 * The default is **on**, wherever a backend exists. Nothing here observes
 * anything, so there is no capture to consent to; a notice repeats on the
 * desktop what the panel already showed, and the run that would have been
 * interrupted by a panel left open is interrupted the same way with it closed.
 * The setting exists to turn that off, and `SQUID_NOTIFY=off` is how — spelled
 * out rather than implied by an unset variable, because a default that lives in
 * someone's memory of a variable name is not a default, it is a trap.
 *
 * Three outcomes: unset (or `off`) with a backend means Squid speaks through
 * it, the exact string `desktop` is the same thing said explicitly, and
 * anything else is a startup configuration error. On a host with no backend the
 * two paths split: unasked, the run starts quiet — a default has to be
 * livable on every host, and one that exits a machine it never observed is
 * the value-a-form-cannot-satisfy defect, not strictness. Asked for by name,
 * the resolution is a refusal naming what is missing rather than a silent
 * fallback to quiet — a run that expected to interrupt and did not looks
 * exactly like a run whose daemon is asleep.
 *
 * There are three backends — `notify-send` on a freedesktop desktop, a
 * `Shell_NotifyIcon` balloon through Windows PowerShell on win32, and
 * Notification Center through `osascript` on darwin. The refusals
 * below say what each of the *others* is actually missing rather than quietly
 * resolving to nothing, which is the shape the browser reader has for the
 * platforms it never got: a capability that names its own absence can be
 * fixed, and one that answers "off" to a run that asked for it cannot.
 */
export type DesktopNoticeResolution =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly noticeKind: "desktop";
      readonly notifierFactory: DesktopNotifierFactory;
    }
  | { readonly configError: string };

export interface ResolveDesktopNoticeOptions {
  readonly env?: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
}

/** The one spelling that silences a backend the host actually has. */
export const DESKTOP_NOTICE_OFF = "off";

export function resolveDesktopNotice(
  options: ResolveDesktopNoticeOptions = {},
): DesktopNoticeResolution {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const kind = env.SQUID_NOTIFY;
  if (kind === DESKTOP_NOTICE_OFF) {
    // Spelled out, so it wins over everything, on every host: the one value
    // that means "quiet" rather than "whatever the host and the default say".
    return { enabled: false };
  }
  if (kind === undefined) {
    return resolveDefault(platform, { asked: false });
  }
  if (kind !== "desktop") {
    return {
      configError: 'SQUID_NOTIFY must be unset, "off", or exactly "desktop".',
    };
  }
  return resolveDefault(platform, { asked: true });
}

/**
 * Backend by host, shared by the explicit and the default path so the two can
 * never disagree about what a host supports.
 *
 * `asked` is what separates a silent off from a refusal: unset on a host with
 * no backend starts the run quiet (a default that exited the machines it never
 * observed would be a trap set by the installer), while `desktop` spelled out
 * on that same host is a request, and a request names what it is missing.
 */
function resolveDefault(
  platform: NodeJS.Platform,
  asked: { readonly asked: boolean },
): DesktopNoticeResolution {
  if (platform === "linux") {
    return {
      enabled: true,
      noticeKind: "desktop",
      // The platform travels with the choice rather than being read again inside
      // the backend, so this seam decides construction as well as validation —
      // the half-connected version of it is what made a Windows-host default
      // untestable anywhere but Windows.
      notifierFactory: createLinuxDesktopNotifier({ platform }),
    };
  }
  if (platform === "win32") {
    return {
      enabled: true,
      noticeKind: "desktop",
      // Same seam, same reason as the Linux arm: the platform travels with the
      // choice rather than being read again inside the backend, so the resolver
      // decides construction as well as validation — and the suite can assert
      // that from any host.
      notifierFactory: createWindowsDesktopNotifier({ platform }),
    };
  }
  if (platform === "darwin") {
    // The messenger is visible — Notification Center attributes the notice to
    // osascript's own bundle, not to Squid — and the Windows balloon accepted
    // the same visible-messenger trade for the same no-installer reason, so
    // the two agree rather than one platform silently staying quiet.
    return {
      enabled: true,
      noticeKind: "desktop",
      notifierFactory: createMacosDesktopNotifier({ platform }),
    };
  }
  return asked.asked
    ? { configError: `SQUID_NOTIFY=desktop has no backend for ${platform}.` }
    : { enabled: false };
}
