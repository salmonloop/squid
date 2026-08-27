import { isAbsolute } from "node:path";

/**
 * Chooses whether this run exposes a control panel.
 *
 * Off by default, like every capability variable. Opening a panel declares that
 * this run can be observed and controlled: the socket shows what the sensors
 * just read and accepts pause and resume, so enabling it is a decision worth
 * asking for rather than assuming.
 *
 * Three outcomes, matching `resolveCaptureGate`: unset means no panel, an
 * absolute path names the socket, and anything else is a startup configuration
 * error. A relative path is refused rather than resolved against the working
 * directory — the socket file's mode is the only access boundary there is, and a
 * path that means different files depending on where the process was launched
 * would put that boundary somewhere nobody chose.
 */
export type PanelResolution =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly socketPath: string }
  | { readonly configError: string };

export interface ResolvePanelOptions {
  readonly env?: Record<string, string | undefined>;
}

export function resolvePanel(options: ResolvePanelOptions = {}): PanelResolution {
  const env = options.env ?? process.env;
  const path = env.SQUID_PANEL_SOCKET;
  if (path === undefined) return { enabled: false };

  // An empty value is a configuration error, not a second way to say "off":
  // it reads as an attempt to enable the panel that lost its path along the way,
  // and silently starting without one would hide the mistake.
  if (path.length === 0) {
    return { configError: "SQUID_PANEL_SOCKET must name a path, or be unset (off)." };
  }
  if (!isAbsolute(path)) {
    return { configError: "SQUID_PANEL_SOCKET must be an absolute path." };
  }

  return { enabled: true, socketPath: path };
}
