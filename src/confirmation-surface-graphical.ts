import {
  SerialConfirmationPolicy,
  type ConfirmationAnswer,
  type ConfirmationPrompt,
  type ConfirmationSurface,
} from "./action-confirmation.js";

/**
 * The wire payload the UI process receives — one JSON object per line over its
 * stdin. Same four safe fields as `ConfirmationPrompt`, as a *separate* type so
 * the wire schema is named in one place the Rust binary can mirror without
 * importing a TypeScript port type it cannot see. The two cannot drift through
 * a shared type if there is no shared type — only a shared shape, spelled out
 * here and in `ui/src/main.rs`.
 *
 * `arguments` is absent on purpose: a surface that never receives the selection
 * cannot render it, and this payload is everything the UI is allowed to show.
 */
export interface GraphicalPromptPayload {
  readonly candidateId: string;
  readonly kind: ConfirmationPrompt["kind"];
  readonly summary: string;
  readonly expiresAt: string;
}

export function toGraphicalPayload(prompt: ConfirmationPrompt): GraphicalPromptPayload {
  return {
    candidateId: prompt.candidateId,
    kind: prompt.kind,
    summary: prompt.summary,
    expiresAt: prompt.expiresAt,
  };
}

/**
 * How the surface talks to a UI process.
 *
 * Injected rather than hardcoded: conformance drives the surface with a stub
 * transport (no Rust toolchain needed), and production supplies the stdio
 * transport that spawns the Slint binary. Swapping the wire — a socket, a pipe,
 * a different process model — never touches the surface or the engine, because
 * the surface sees only this interface.
 *
 * A transport that loses the UI rejects with an Error whose message includes
 * `"surface closed"`, so `SerialConfirmationPolicy` maps a vanished window to
 * `input_closed` rather than propagating a defect. Anything else the transport
 * throws propagates as a defect — a programming error must not look like a user
 * who went away.
 */
export interface GraphicalTransport {
  /** Whether the UI is reachable right now. Checked per request, never cached. */
  available(): boolean;
  /** Send the prompt and await the human's answer. May reject with `"surface closed"`. */
  ask(payload: GraphicalPromptPayload, signal: AbortSignal): Promise<ConfirmationAnswer>;
  /** Closes the UI process. */
  close?(): Promise<void>;
}

export interface GraphicalConfirmationSurfaceOptions {
  /** The transport the surface talks to. Required — without one there is no UI. */
  readonly transport: GraphicalTransport;
}

/**
 * A non-terminal place a human can be asked a yes/no question.
 *
 * Everything that used to be hard — the serial queue, the deadline race, expiry
 * versus timeout, the fail-closed matrix — lives in `SerialConfirmationPolicy`,
 * inherited unchanged from the terminal surface. What remains here is the part
 * that is genuinely about a window: mapping the port type to the wire payload,
 * and knowing whether the UI is there to ask.
 *
 * The surface is a thin adapter on purpose. Unlike the terminal, there is no
 * freeform answer to normalize — the UI has buttons, not a keyboard, so the
 * answer is already `"approved"` or `"declined"`. The work the surface does is
 * the type boundary: the engine speaks `ConfirmationPrompt`, the wire speaks
 * `GraphicalPromptPayload`, and this is where the two meet.
 */
export class GraphicalConfirmationSurface implements ConfirmationSurface {
  public readonly id = "graphical";

  private readonly transport: GraphicalTransport;

  public constructor(options: GraphicalConfirmationSurfaceOptions) {
    this.transport = options.transport;
  }

  public available(): boolean {
    // Delegated per call, never cached at construction. A window can close
    // between two suggestions — the same property the terminal surface
    // guarantees by reading `isTTY` per call — and a surface that froze this
    // answer would report a vanished UI as present.
    return this.transport.available();
  }

  public ask(prompt: ConfirmationPrompt, signal: AbortSignal): Promise<ConfirmationAnswer> {
    // The surface owns the port→wire mapping; the transport owns byte movement.
    // Splitting them means a transport swap never touches the engine's contract,
    // and the wire schema is named once, here, for the Rust binary to mirror.
    return this.transport.ask(toGraphicalPayload(prompt), signal);
  }

  public async close(): Promise<void> {
    // The engine's close() calls surface.close?.() — without this, the spawned
    // UI process would outlive the watcher. Delegated to the transport because
    // the surface does not own the child; it only owns the type boundary.
    await this.transport.close?.();
  }
}

export interface GraphicalActionConfirmationOptions {
  readonly transport: GraphicalTransport;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

/**
 * The graphical surface behind the shared policy.
 *
 * A function rather than a subclass, identical in shape to
 * `createTerminalActionConfirmation`: there is exactly one confirmation engine,
 * and a surface composes with it instead of extending it. That is what keeps a
 * second surface from being able to override a fail-closed rule.
 */
export function createGraphicalActionConfirmation(
  options: GraphicalActionConfirmationOptions,
): SerialConfirmationPolicy {
  const { transport, timeoutMs, now } = options;
  return new SerialConfirmationPolicy({
    surface: new GraphicalConfirmationSurface({ transport }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(now === undefined ? {} : { now }),
  });
}
