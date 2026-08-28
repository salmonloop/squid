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
 * absolute path names the Unix socket, and anything else is a startup
 * configuration error. Windows has no `std::os::unix` transport, so it accepts
 * the explicit loopback spelling `tcp://127.0.0.1:<port>` instead. Binding only
 * loopback keeps the panel local; accepting a general host here would turn the
 * unauthenticated control socket into a network service.
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

export interface PanelTcpEndpoint {
  readonly hostname: "127.0.0.1";
  readonly port: number;
}

/** Parses the only TCP endpoint the Windows panel is allowed to use. */
export function parsePanelTcpEndpoint(value: string): PanelTcpEndpoint | null {
  if (!value.startsWith("tcp://")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const port = Number(url.port);
  if (
    url.protocol !== "tcp:"
    || url.hostname !== "127.0.0.1"
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || url.username.length > 0
    || url.password.length > 0
    || url.pathname !== ""
    || url.search.length > 0
    || url.hash.length > 0
  ) {
    return null;
  }
  return { hostname: "127.0.0.1", port };
}

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
    if (parsePanelTcpEndpoint(path) === null) {
      return {
        configError: "On Windows SQUID_PANEL_SOCKET must be tcp://127.0.0.1:<port>.",
      };
    }
    return { enabled: true, socketPath: path };
  }
  if (!isAbsolute(path)) {
    return { configError: "SQUID_PANEL_SOCKET must be an absolute path." };
  }

  return { enabled: true, socketPath: path };
}
