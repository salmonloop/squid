/**
 * What Squid says out loud, and the thing that says it.
 *
 * Every sense in this repository is an input and has a file here. This is the
 * first output, and it exists because the panel was the only surface Squid had:
 * an agent reply reaches `panelAgentLine` and stops at a row in a window nobody
 * is looking at (`src/watch-session.ts`), so a person who closed the panel could
 * not learn that the agent had said anything at all.
 *
 * **A notice is not a decision.** Nothing here carries a prompt, an action, or a
 * button, and that is a decision rather than an unfinished edge. A consequential
 * answer belongs on the confirmation surface, which has one-answer-per-prompt
 * correlation, an expiry, and a decline on close (`ui/src/main.rs`). A second
 * place to say yes would be a second claimant to the same answer, and the panel
 * spent a release making "one decision, one answer" structural.
 *
 * **Failure here is never the caller's problem.** A notice that could not be
 * delivered must not fail the agent turn that produced it: the turn's work is
 * finished and already recorded, and the announcement is a courtesy on top of
 * it. So `notify` returns nothing, throws nothing, blocks nothing, and every
 * failure leaves through `onDiagnostic` — the same posture as a sensor whose
 * host refused a read.
 */

/** One thing worth interrupting a person for. */
export interface DesktopNotice {
  /** The one line a host renders large. Not a sentence of detail. */
  readonly title: string;
  /**
   * The detail under the title.
   *
   * Sanitized by the caller, never here. The privacy boundary in
   * `docs/panel-protocol.md` is upstream of every surface, and a notifier that
   * redacted would be a second policy to keep in agreement with the first.
   */
  readonly body: string;
}

export interface DesktopNoticeDiagnostic {
  /**
   * One kind, because there is one thing that can go wrong from the caller's
   * point of view: the host was asked to say something and did not. Which
   * mechanism failed, and how, is the message's job.
   */
  readonly kind: "notice_error";
  readonly message: string;
  readonly occurredAt: string;
}

export interface DesktopNotifier {
  /** Fire and forget. Never throws, never rejects, never blocks the caller. */
  notify(notice: DesktopNotice): void;
  /**
   * Stops accepting notices and leaves no child behind.
   *
   * A notifier that returned while its helper was still running would leak a
   * process per notice on a busy shutdown, which is the one failure a person
   * cannot see and cannot clean up.
   */
  close(): Promise<void>;
}

export interface DesktopNotifierHooks {
  readonly onDiagnostic: (diagnostic: DesktopNoticeDiagnostic) => void;
}

/**
 * Built once per run, like a reader factory: the resolver chooses the backend
 * and the session supplies the hooks, so nothing that constructs a notifier has
 * to know which host it is on.
 */
export type DesktopNotifierFactory = (hooks: DesktopNotifierHooks) => DesktopNotifier;
