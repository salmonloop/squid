import type {
  ActivityEventEmitter,
  ActivitySource,
  ActivitySourceDiagnostic,
} from "./activity-source.js";
import {
  createActivityEvent,
  type ActivityEvent,
  type ApplicationActivatedPayload,
  type FocusChangedPayload,
  type TextContextChangedPayload,
  type WindowChangedPayload,
} from "./protocol.js";

const DEFAULT_DEBOUNCE_MS = 200;

/** Reuses the protocol's role union so the seam can never drift from the payload. */
export type ScreenTextFocusRole = FocusChangedPayload["role"];

/**
 * One neutral sample of the foreground window, as any screen-text backend can
 * describe it.
 *
 * Every field is optional on purpose, and absence carries meaning: a missing
 * field is something the backend could not read, while a present-but-empty one
 * is something it read as empty. An accessibility API that exposes window titles
 * reports `windowTitle: ""` for an untitled window; a future OCR backend that
 * cannot see titles at all omits the field entirely. `projectFrame` treats those
 * two cases differently, so backends must respect the distinction.
 */
export interface ScreenTextFrame {
  readonly applicationId?: string;
  readonly applicationName?: string;
  readonly windowTitle?: string;
  readonly focusedRole?: ScreenTextFocusRole;
  readonly focusedLabel?: string | null;
  /** Absent when the backend has no caret or selection information at all. */
  readonly textContext?: {
    readonly prefix: string;
    readonly suffix: string;
    readonly selection: string;
    readonly language: string | null;
  };
  /** ISO timestamp of the sample. Defaults to delivery time when absent. */
  readonly occurredAt?: string;
}

export interface ScreenTextReader {
  close(): void;
}

/**
 * Injection seam for a screen-text backend. Mirrors `FilesystemWatcherFactory`:
 * the backend pushes samples and errors and owns nothing else. A macOS
 * accessibility reader, a future OCR reader, and a future Windows UI Automation
 * reader are all just implementations of this one function type — the adapter
 * below imports none of them.
 */
export type ScreenTextReaderFactory = (input: {
  onFrame: (frame: ScreenTextFrame) => void;
  onError: (error: Error) => void;
}) => ScreenTextReader;

export interface ScreenTextActivitySourceOptions {
  /**
   * Required, unlike the filesystem source's watcher factory. Reading foreground
   * text has no platform-neutral implementation, so a default here would have to
   * import concrete backends and couple this adapter to them. The entry point
   * chooses the backend instead.
   */
  readerFactory: ScreenTextReaderFactory;
  sourceId?: string;
  /** Defaults to a fresh identity per instance; see the constructor. */
  sessionId?: string;
  /** Collapses backend bursts: only the last frame in a window is projected. */
  debounceMs?: number;
  onDiagnostic?: (diagnostic: ActivitySourceDiagnostic) => void;
}

type SourceLifecycle = "idle" | "started" | "stopped";

type ScreenTextEmission =
  | { kind: "application_activated"; payload: ApplicationActivatedPayload }
  | { kind: "window_changed"; payload: WindowChangedPayload }
  | { kind: "focus_changed"; payload: FocusChangedPayload }
  | { kind: "text_context_changed"; payload: TextContextChangedPayload };

/**
 * Projects one neutral frame onto the protocol events it can justify, in reducer
 * order. Pure by design: the mapping rules live here, and the dedupe plus
 * delivery concerns live in the class below, so neither can quietly depend on
 * the other's state.
 *
 * `application_activated` and `window_changed` need signal a frame may lack, so
 * they are conditional. `focus_changed` is not: a focused element whose role and
 * label could not be read is still a focus fact, so missing attributes fall back
 * to the protocol's own neutral values. `text_context_changed` is skipped
 * entirely when `textContext` is absent — synthesizing empty caret context would
 * erase real state in the reducer, which carries the previous text forward.
 */
function projectFrame(frame: ScreenTextFrame): ScreenTextEmission[] {
  const applicationId = frame.applicationId;
  if (applicationId === undefined || applicationId.length === 0) {
    // Every payload below is keyed by application and the protocol requires a
    // non-empty id, so without one there is nothing this source can say.
    return [];
  }

  const emissions: ScreenTextEmission[] = [];

  const applicationName = frame.applicationName;
  if (applicationName !== undefined && applicationName.length > 0) {
    emissions.push({
      kind: "application_activated",
      payload: { applicationId, applicationName },
    });
  }

  if (frame.windowTitle !== undefined) {
    emissions.push({
      kind: "window_changed",
      // A text reader observes no geometry, so bounds is null rather than a guess.
      payload: { applicationId, title: frame.windowTitle, bounds: null },
    });
  }

  emissions.push({
    kind: "focus_changed",
    payload: {
      applicationId,
      windowTitle: frame.windowTitle ?? "",
      role: frame.focusedRole ?? "unknown",
      label: frame.focusedLabel ?? null,
    },
  });

  const textContext = frame.textContext;
  if (textContext !== undefined) {
    emissions.push({
      kind: "text_context_changed",
      payload: {
        prefix: textContext.prefix,
        suffix: textContext.suffix,
        selection: textContext.selection,
        language: textContext.language,
      },
    });
  }

  return emissions;
}

/**
 * Emits validated foreground-window activity from any `ScreenTextReader` backend.
 *
 * The source reports what it observed and nothing more: frames carry raw window
 * titles and selections, and credential redaction happens downstream at the
 * capture boundary in `PredictionRuntime`. Source kind is `"host"` because these
 * are host-level accessibility observations, not a new transport.
 */
export class ScreenTextActivitySource implements ActivitySource {
  public readonly id: string;
  /** Part of this source's event identity, alongside `id`; see the constructor. */
  public readonly sessionId: string;

  private readonly readerFactory: ScreenTextReaderFactory;
  private readonly debounceMs: number;
  private readonly onDiagnostic: ((diagnostic: ActivitySourceDiagnostic) => void) | undefined;

  private readonly recordedDiagnostics: ActivitySourceDiagnostic[] = [];
  /**
   * Fingerprint of the last payload emitted per kind: the payload itself is the
   * dedupe key, so two frames that would produce the same event produce one.
   * Backends sample on a cadence, so without this every tick would re-emit an
   * unchanged desktop and burn a sequence number per tick.
   *
   * Fingerprints are `JSON.stringify` of payloads built only by `projectFrame`,
   * whose object literals fix key order — so string equality is payload equality.
   */
  private readonly lastEmitted = new Map<ScreenTextEmission["kind"], string>();

  private lifecycle: SourceLifecycle = "idle";
  private reader: ScreenTextReader | null = null;
  private emit: ActivityEventEmitter | null = null;
  private pendingFrame: { frame: ScreenTextFrame; timer: ReturnType<typeof setTimeout> } | null = null;
  private deliveryTail: Promise<void> = Promise.resolve();
  private sequence = 0;

  public constructor(options: ScreenTextActivitySourceOptions) {
    this.readerFactory = options.readerFactory;
    this.id = options.sourceId ?? "screen-text-host";
    // `sequence` restarts at 0 for every instance, so the session must be the
    // part of the identity tuple that changes. A constant default would make
    // every run re-emit (host, <id>, <session>, 0) and collide with its own
    // history in any store that enforces source-local identity.
    this.sessionId = options.sessionId ?? `screen-text-${crypto.randomUUID()}`;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.onDiagnostic = options.onDiagnostic;
  }

  public get diagnostics(): readonly ActivitySourceDiagnostic[] {
    return this.recordedDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  public async start(emit: ActivityEventEmitter): Promise<void> {
    if (this.lifecycle !== "idle") {
      throw new Error(`Screen text source ${this.id} cannot start from lifecycle state ${this.lifecycle}.`);
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
      // A backend that cannot initialize — one asked for the wrong platform, or
      // a future one whose permission check fails — must leave the source where
      // it began. Otherwise a caller that fixes the cause and retries hits
      // "cannot start from lifecycle state started" on a source with no reader.
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
    // shutdown is real observation, and dropping it would lose the final state.
    const pending = this.pendingFrame;
    if (pending !== null) {
      clearTimeout(pending.timer);
      this.pendingFrame = null;
      this.enqueue(pending.frame);
    }

    await this.deliveryTail;
    this.emit = null;
  }

  private handleFrame(frame: ScreenTextFrame): void {
    if (this.lifecycle !== "started") return;

    // One pending slot, not one per key: a frame is a whole-window sample, so a
    // newer frame supersedes an older one outright. Per-kind dedupe then decides
    // what actually changed, which makes debounce purely a burst guard.
    if (this.pendingFrame !== null) clearTimeout(this.pendingFrame.timer);
    const timer = setTimeout(() => {
      this.pendingFrame = null;
      this.enqueue(frame);
    }, this.debounceMs);
    this.pendingFrame = { frame, timer };
  }

  /** Serializes delivery so per-source sequence stays monotonic. */
  private enqueue(frame: ScreenTextFrame): void {
    this.deliveryTail = this.deliveryTail.then(() => this.deliver(frame));
  }

  private async deliver(frame: ScreenTextFrame): Promise<void> {
    const emit = this.emit;
    if (emit === null) return;

    // Reading the frame is itself fallible: a backend that pushes a non-object
    // — a malformed frames file, a reader bug — makes every field access throw.
    // An escaping throw would reject the shared delivery tail, which then
    // rejects every later frame and leaves `stop()` rejecting instead of
    // draining, so the whole read-and-project step is guarded here.
    let occurredAt: string;
    let emissions: ScreenTextEmission[];
    try {
      // One sample is one instant, so every event it produces shares a timestamp;
      // `sequence` is what orders them.
      occurredAt = frame.occurredAt ?? new Date().toISOString();
      emissions = projectFrame(frame);
    } catch (error) {
      this.record("delivery_error", error);
      return;
    }

    for (const emission of emissions) {
      const fingerprint = JSON.stringify(emission.kind === "text_context_changed"
        ? {
            payload: emission.payload,
            // Text payloads have no owner by protocol design. Include the observed
            // foreground identity in the source-local dedupe key so identical text
            // in two windows is emitted again and can bind to the new focus.
            applicationId: frame.applicationId ?? null,
            windowTitle: frame.windowTitle ?? null,
          }
        : emission.payload);
      if (this.lastEmitted.get(emission.kind) === fingerprint) continue;

      try {
        await emit(this.buildEvent(emission, occurredAt));
      } catch (error) {
        // Leave the fingerprint unrecorded so the next identical frame retries,
        // and keep going: one rejected event must not suppress the unrelated
        // facts observed in the same sample.
        this.record("delivery_error", error);
        continue;
      }
      this.lastEmitted.set(emission.kind, fingerprint);
    }
  }

  private buildEvent(emission: ScreenTextEmission, occurredAt: string): ActivityEvent {
    return createActivityEvent({
      kind: emission.kind,
      payload: emission.payload,
      source: { kind: "host", instanceId: this.id },
      sessionId: this.sessionId,
      sequence: this.sequence++,
      occurredAt,
    });
  }

  private record(kind: ActivitySourceDiagnostic["kind"], error: unknown): void {
    const diagnostic: ActivitySourceDiagnostic = {
      kind,
      message: error instanceof Error ? error.message : String(error),
      occurredAt: new Date().toISOString(),
    };
    this.recordedDiagnostics.push(diagnostic);
    this.onDiagnostic?.(diagnostic);
  }
}
