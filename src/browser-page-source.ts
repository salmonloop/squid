import type {
  ActivityEventEmitter,
  ActivitySource,
  ActivitySourceDiagnostic,
} from "./activity-source.js";
import { describeErrorForAudit } from "./audit-text.js";
import {
  createActivityEvent,
  type ActivityEvent,
  type BrowserNavigatedPayload,
  type ForegroundOwner,
} from "./protocol.js";

const DEFAULT_DEBOUNCE_MS = 200;

/**
 * One neutral sample of a browser's current page, as any browser backend can
 * describe it.
 *
 * Deliberately the same shape of contract as `ScreenTextFrame`: the adapter
 * imports no backend, so an extension, a CDP attachment, and a future
 * accessibility-based reader are each one factory and zero adapter changes.
 *
 * `url` is the only required field. A backend that cannot read the tab title
 * omits `title` rather than sending `""`, because the reducer stores whatever it
 * is given and an invented empty title is a claim about the page. The owner is
 * optional for the same reason — see `BrowserPageActivitySourceOptions.owner`.
 */
export interface BrowserPageFrame {
  readonly url: string;
  readonly title?: string;
  /**
   * Which window is showing this page. Absent when the backend cannot tell.
   *
   * This matters more than it looks: `admitSearch` requires the page owner, the
   * selection owner, and the foreground owner to agree, and refuses when the
   * page carries no owner. A backend that guesses an owner it cannot observe
   * would defeat that check rather than satisfy it.
   */
  readonly owner?: ForegroundOwner;
  /** ISO timestamp of the sample. Defaults to delivery time when absent. */
  readonly occurredAt?: string;
}

export interface BrowserPageReader {
  close(): void;
}

/**
 * Injection seam for a browser backend. Mirrors `ScreenTextReaderFactory`: the
 * backend pushes samples and errors and owns nothing else.
 */
export type BrowserPageReaderFactory = (input: {
  onFrame: (frame: BrowserPageFrame) => void;
  onError: (error: Error) => void;
}) => BrowserPageReader;

export interface BrowserPageActivitySourceOptions {
  /**
   * Required rather than defaulted, for the same reason the screen source
   * requires its reader: there is no platform-neutral way to observe a browser,
   * so a default would have to import a concrete backend and couple this
   * adapter to it.
   */
  readerFactory: BrowserPageReaderFactory;
  sourceId?: string;
  /** Defaults to a fresh identity per instance; see the constructor. */
  sessionId?: string;
  /** Collapses backend bursts: only the last frame in a window is projected. */
  debounceMs?: number;
  onDiagnostic?: (diagnostic: ActivitySourceDiagnostic) => void;
}

type SourceLifecycle = "idle" | "started" | "stopped";

/**
 * Projects one frame onto a `browser_navigated` payload, or refuses it.
 *
 * Returns null for anything it cannot describe honestly. A URL that does not
 * parse has no host, and `host` is required by the protocol — synthesizing one
 * would put a guess into an append-only store. Note that this only derives the
 * host; it does not decide what a *predictor* may see of the URL, which is
 * `RedactingContextPolicy`'s job at the egress boundary.
 */
export function projectBrowserFrame(frame: BrowserPageFrame): BrowserNavigatedPayload | null {
  if (typeof frame.url !== "string" || frame.url.length === 0) return null;
  let host: string;
  try {
    host = new URL(frame.url).host;
  } catch {
    return null;
  }
  // A `data:` or `blob:` URL parses but has an empty host, and the protocol
  // requires a non-empty one. Refusing is correct rather than unfortunate: a
  // page with no origin is not something a selection can be attributed to.
  if (host.length === 0) return null;
  return {
    url: frame.url,
    title: frame.title ?? "",
    host,
    owner: frame.owner === undefined
      ? null
      : { applicationId: frame.owner.applicationId, windowTitle: frame.owner.windowTitle },
  };
}

/**
 * Turns browser page samples into `browser_navigated` activity events.
 *
 * This is the source `search_selection` was blocked on. `admitSearch` requires
 * `state.currentBrowserPage`, which only a `browser_navigated` event can set, so
 * without this adapter every search candidate was refused with
 * `browser_page_missing` no matter how the world actually looked.
 *
 * The reducer independently drops an owner that does not match the current
 * foreground, so a backend reporting a stale or wrong owner degrades to
 * `owner: null` and search stays refused. The failure mode is safe by
 * construction, not by this source being careful.
 */
export class BrowserPageActivitySource implements ActivitySource {
  public readonly id: string;
  /** Part of this source's event identity, alongside `id`; see the constructor. */
  public readonly sessionId: string;

  private readonly readerFactory: BrowserPageReaderFactory;
  private readonly debounceMs: number;
  private readonly onDiagnostic: ((diagnostic: ActivitySourceDiagnostic) => void) | undefined;

  private readonly recordedDiagnostics: ActivitySourceDiagnostic[] = [];
  /**
   * Fingerprint of the last payload emitted. The payload is the dedupe key, so a
   * backend polling an unchanged tab emits once rather than once per tick and
   * does not burn a sequence number each time.
   *
   * `JSON.stringify` over a payload built only by `projectBrowserFrame`, whose
   * object literal fixes key order — so string equality is payload equality.
   */
  private lastEmitted: string | null = null;

  private lifecycle: SourceLifecycle = "idle";
  private reader: BrowserPageReader | null = null;
  private emit: ActivityEventEmitter | null = null;
  private pendingFrame: { frame: BrowserPageFrame; timer: ReturnType<typeof setTimeout> } | null = null;
  private deliveryTail: Promise<void> = Promise.resolve();
  private sequence = 0;

  public constructor(options: BrowserPageActivitySourceOptions) {
    this.readerFactory = options.readerFactory;
    this.id = options.sourceId ?? "browser-page-host";
    // `sequence` restarts at 0 for every instance, so the session must be the
    // part of the identity tuple that changes. A constant default would make
    // every run re-emit (host, <id>, <session>, 0) and collide with its own
    // history in any store that enforces source-local identity.
    this.sessionId = options.sessionId ?? `browser-page-${crypto.randomUUID()}`;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.onDiagnostic = options.onDiagnostic;
  }

  public get diagnostics(): readonly ActivitySourceDiagnostic[] {
    return this.recordedDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  public async start(emit: ActivityEventEmitter): Promise<void> {
    if (this.lifecycle !== "idle") {
      throw new Error(
        `Browser page source ${this.id} cannot start from lifecycle state ${this.lifecycle}.`,
      );
    }

    this.emit = emit;
    // Set before constructing the reader so a backend that pushes its first
    // frame synchronously is not dropped by the lifecycle guard.
    this.lifecycle = "started";
    try {
      this.reader = this.readerFactory({
        onFrame: (frame) => this.handleFrame(frame),
        // A reader is this source's watcher, so its failures land on the existing
        // diagnostic kind rather than widening the union.
        onError: (error) => this.record("watcher_error", error),
      });
    } catch (error) {
      // A backend that cannot initialize must leave the source where it began,
      // or a caller that fixes the cause and retries hits "cannot start from
      // lifecycle state started" on a source with no reader.
      this.lifecycle = "idle";
      this.emit = null;
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.lifecycle !== "started") {
      this.lifecycle = "stopped";
      await this.deliveryTail;
      return;
    }

    this.lifecycle = "stopped";
    this.reader?.close();
    this.reader = null;

    // Flush the debounce window rather than discarding it: the last frame before
    // shutdown is real observation, and dropping it would lose the final page.
    const pending = this.pendingFrame;
    if (pending !== null) {
      clearTimeout(pending.timer);
      this.pendingFrame = null;
      this.enqueue(pending.frame);
    }

    await this.deliveryTail;
    this.emit = null;
  }

  private handleFrame(frame: BrowserPageFrame): void {
    if (this.lifecycle !== "started") return;

    // One pending slot: a frame is a whole-page sample, so a newer frame
    // supersedes an older one outright. Dedupe then decides whether anything
    // actually changed, which makes debounce purely a burst guard.
    if (this.pendingFrame !== null) clearTimeout(this.pendingFrame.timer);
    const timer = setTimeout(() => {
      this.pendingFrame = null;
      this.enqueue(frame);
    }, this.debounceMs);
    this.pendingFrame = { frame, timer };
  }

  /** Serializes delivery so per-source sequence stays monotonic. */
  private enqueue(frame: BrowserPageFrame): void {
    this.deliveryTail = this.deliveryTail.then(() => this.deliver(frame));
  }

  private async deliver(frame: BrowserPageFrame): Promise<void> {
    const emit = this.emit;
    if (emit === null) return;

    // Reading the frame is itself fallible: a backend that pushes a non-object
    // makes every field access throw. An escaping throw would reject the shared
    // delivery tail, which then rejects every later frame and leaves `stop()`
    // rejecting too.
    let payload: BrowserNavigatedPayload | null;
    let occurredAt: string | undefined;
    try {
      payload = projectBrowserFrame(frame);
      occurredAt = frame.occurredAt;
    } catch (error) {
      this.record("delivery_error", error);
      return;
    }
    if (payload === null) return;

    const fingerprint = JSON.stringify(payload);
    if (this.lastEmitted === fingerprint) return;

    const event = createActivityEvent<BrowserNavigatedPayload>({
      kind: "browser_navigated",
      payload,
      source: { kind: "host", instanceId: this.id },
      sessionId: this.sessionId,
      sequence: this.sequence,
      ...(occurredAt === undefined ? {} : { occurredAt }),
    }) as ActivityEvent;

    try {
      await emit(event);
    } catch (error) {
      // A rejected event is not recorded as emitted, so the next identical frame
      // retries it rather than being deduped away as already delivered.
      this.record("delivery_error", error);
      return;
    }
    this.lastEmitted = fingerprint;
    this.sequence += 1;
  }

  private record(kind: ActivitySourceDiagnostic["kind"], error: unknown): void {
    const diagnostic: ActivitySourceDiagnostic = {
      kind,
      message: describeErrorForAudit(error),
      occurredAt: new Date().toISOString(),
    };
    this.recordedDiagnostics.push(diagnostic);
    this.onDiagnostic?.(diagnostic);
  }
}
