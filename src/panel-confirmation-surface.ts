import type { ConfirmationAnswer, ConfirmationPrompt, ConfirmationSurface } from "./action-confirmation.js";
import { panelConfirmationCancel, panelConfirmationPrompt, type PanelMessage } from "./panel-view.js";

/** The small part of PanelServer the surface needs, kept structural for tests. */
export interface PanelConfirmationBroadcaster {
  readonly clientCount: number;
  broadcast(message: PanelMessage): void;
}

export interface PanelConfirmationSurfaceOptions {
  /** The server is constructed after this registry, so resolve it at each use. */
  readonly server: () => PanelConfirmationBroadcaster | undefined;
}

/**
 * Correlates panel prompt/answer traffic with ConfirmationSurface asks.
 *
 * This is only a surface adapter. No current Pi custom tool invokes it: those
 * tools are read-only and Pi's sandbox remains the real tool-safety boundary.
 */
export class PanelConfirmationSurface implements ConfirmationSurface {
  public readonly id = "panel";
  private readonly server: () => PanelConfirmationBroadcaster | undefined;
  private nextPromptId = 1;
  private readonly pending = new Map<number, { resolve: (answer: ConfirmationAnswer) => void }>();
  private closed = false;

  public constructor(options: PanelConfirmationSurfaceOptions) {
    this.server = options.server;
  }

  public available(): boolean {
    return !this.closed && (this.server()?.clientCount ?? 0) > 0;
  }

  public ask(prompt: ConfirmationPrompt, signal: AbortSignal): Promise<ConfirmationAnswer> {
    if (this.closed) return Promise.reject(new Error("surface closed"));
    const server = this.server();
    if (server === undefined || server.clientCount === 0) return Promise.reject(new Error("surface unavailable"));
    const promptId = this.allocatePromptId();
    return new Promise<ConfirmationAnswer>((resolve) => {
      const cancel = (): void => {
        if (!this.pending.delete(promptId)) return;
        this.broadcastCancel(promptId);
      };
      this.pending.set(promptId, { resolve });
      signal.addEventListener("abort", cancel, { once: true });
      try {
        server.broadcast(panelConfirmationPrompt({ promptId, ...prompt }));
      } catch {
        // Broadcast implementations normally contain their own errors, but a
        // test or future transport may throw. Leave the request unanswered so
        // the policy's own deadline remains the one fail-closed authority.
        cancel();
      }
    });
  }

  /** Returns false for stale, unknown, or duplicate answers. */
  public onAnswer(promptId: number, answer: ConfirmationAnswer): boolean {
    const pending = this.pending.get(promptId);
    if (pending === undefined) return false;
    this.pending.delete(promptId);
    pending.resolve(answer);
    return true;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [promptId] of this.pending) this.broadcastCancel(promptId);
    this.pending.clear();
  }

  private allocatePromptId(): number {
    const id = this.nextPromptId;
    if (!Number.isSafeInteger(id)) throw new Error("Confirmation prompt ids are exhausted.");
    this.nextPromptId += 1;
    return id;
  }

  private broadcastCancel(promptId: number): void {
    try {
      this.server()?.broadcast(panelConfirmationCancel(promptId));
    } catch {
      // Transport failure is deliberately silent here: the policy deadline is
      // still live and every path other than an explicit matching approval fails closed.
    }
  }
}
