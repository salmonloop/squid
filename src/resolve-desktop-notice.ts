import { createLinuxDesktopNotifier } from "./desktop-notice-linux.js";
import type { DesktopNotifierFactory } from "./desktop-notice.js";

/**
 * Chooses how Squid speaks up, from the environment.
 *
 * The default is **off**, and for a different reason than the browser reader's.
 * Nothing here observes anything, so there is no capture to consent to; what a
 * notice spends is the person's attention, and every desktop already has more
 * things asking for it than anyone wanted. A run interrupts because it was asked
 * to.
 *
 * `SQUID_NOTIFY` has three outcomes, matching `SQUID_BROWSER`: unset means Squid
 * stays quiet outside the panel, the exact string `desktop` uses the host's own
 * notification mechanism, and anything else is a startup configuration error.
 *
 * There is one backend, because there is one host this can be verified on. The
 * refusals below say what each of the others is actually missing rather than
 * quietly resolving to nothing, which is the shape the browser reader has for
 * the two platforms it never got: a capability that names its own absence can be
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

export function resolveDesktopNotice(
  options: ResolveDesktopNoticeOptions = {},
): DesktopNoticeResolution {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const kind = env.SQUID_NOTIFY;
  if (kind === undefined) return { enabled: false };
  if (kind !== "desktop") {
    return { configError: 'SQUID_NOTIFY must be unset (quiet) or exactly "desktop".' };
  }

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
      configError:
        "SQUID_NOTIFY=desktop has no Windows backend yet; leave it unset. Windows routes a toast by " +
        "an AppUserModelID that a Start Menu shortcut carries, and Squid ships no installer to write one.",
    };
  }
  if (platform === "darwin") {
    return {
      configError:
        "SQUID_NOTIFY=desktop has no macOS backend yet; leave it unset. Notification Center attributes " +
        "a notice to the bundle that sent it, and the panel ships no bundle.",
    };
  }
  return { configError: `SQUID_NOTIFY=desktop has no backend for ${platform}.` };
}
