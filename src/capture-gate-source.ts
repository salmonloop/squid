import { randomUUID } from "node:crypto";
import type { ActivitySource, ActivitySourceDiagnostic } from "./activity-source.js";
import type {
  ActivityEvent,
  CaptureGateChangedPayload,
} from "./protocol.js";
import { createActivityEvent } from "./protocol.js";

/**
 * The seam between a control surface and the timeline.
 *
 * A gate command is not an observation — nothing about the desktop changed.
 * It is the user telling Squid what to record. The source's whole job is to
 * turn that instruction into one durable `capture_gate_changed` event, because
 * a pause that leaves no trace is indistinguishable from an idle machine and
 * any later analysis reads the gap wrong. The event is the trace.
 */
export interface CaptureGateFrame {
  readonly paused: boolean;
}

export interface CaptureGateReader {
  close(): void;
}

export type CaptureGateReaderFactory = (input: {
  onFrame: (frame: CaptureGateFrame) => void;
  onError: (error: Error) => void;
}) => CaptureGateReader;

export interface CaptureGateActivitySourceOptions {
  readonly readerFactory: CaptureGateReaderFactory;
  readonly onDiagnostic?: (diagnostic: ActivitySourceDiagnostic) => void;
  /** Injected in tests; defaults to a fresh id per process. */
  readonly sessionId?: string;
}

type LifecycleState = "idle" | "started" | "stopped";

/**
 * Projects control-surface commands onto `capture_gate_changed` events with
 * `source.kind: "host"`: the command comes from this machine's own control
 * path, not from anything being observed.
 *
 * Lifecycle mirrors the other sources exactly — double-start and
 * start-after-stop refuse rather than resurrect a dead emitter, delivery is
 * serialized through a tail so two commands cannot interleave, and frames are
 * dropped after stop. A refused frame advances no sequence: it was never an
 * observation.
 */
export class CaptureGateActivitySource implements ActivitySource {
  public readonly id = "capture-gate";

  private readonly readerFactory: CaptureGateReaderFactory;
  private readonly onDiagnostic: ((diagnostic: ActivitySourceDiagnostic) => void) | undefined;
  private readonly sessionId: string;
  private lifecycle: LifecycleState = "idle";
  private reader: CaptureGateReader | null = null;
  private sequence = 0;
  private deliveryTail: Promise<void> = Promise.resolve();
  private emit: ((event: ActivityEvent) => Promise<void>) | null = null;

  public constructor(options: CaptureGateActivitySourceOptions) {
    this.readerFactory = options.readerFactory;
    this.onDiagnostic = options.onDiagnostic;
    // Same default-session posture as the other sources: sequence is persisted
    // identity, so a restarted process must not reserve its old numbers again.
    this.sessionId = options.sessionId ?? `capture-gate-${randomUUID()}`;
  }

  public async start(emit: (event: ActivityEvent) => Promise<void>): Promise<void> {
    if (this.lifecycle !== "idle") {
      throw new Error(`CaptureGateActivitySource cannot start from lifecycle state ${this.lifecycle}.`);
    }
    this.lifecycle = "started";
    this.emit = emit;
    this.reader = this.readerFactory({
      onFrame: (frame) => {
        const delivery = this.deliveryTail.then(() => this.deliver(frame));
        // The tail must survive a failed delivery or every later frame queues
        // behind a rejection forever.
        this.deliveryTail = delivery.catch(() => undefined);
      },
      onError: (error) => {
        this.onDiagnostic?.({
          kind: "watcher_error",
          message: error.message,
          occurredAt: new Date().toISOString(),
        });
      },
    });
  }

  public async stop(): Promise<void> {
    if (this.lifecycle !== "started") return;
    this.lifecycle = "stopped";
    this.reader?.close();
    this.reader = null;
    await this.deliveryTail;
  }

  private async deliver(frame: CaptureGateFrame): Promise<void> {
    if (this.lifecycle === "stopped" || this.emit === null) return;
    const payload: CaptureGateChangedPayload = { paused: frame.paused };
    const event = createActivityEvent<CaptureGateChangedPayload>({
      kind: "capture_gate_changed",
      payload,
      source: { kind: "host", instanceId: this.id },
      sessionId: this.sessionId,
      sequence: this.sequence,
    });
    await this.emit(event);
    // Advance only after the event landed, so a failed delivery never leaves a
    // gap in persisted identity.
    this.sequence += 1;
  }
}
