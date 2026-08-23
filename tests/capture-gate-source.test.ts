import { describe, expect, it } from "bun:test";
import {
  CaptureGateActivitySource,
  type CaptureGateFrame,
  type CaptureGateReaderFactory,
} from "../src/capture-gate-source.js";
import { SquidCore } from "../src/squid-core.js";
import { InMemoryEventStore } from "../src/event-store.js";
import { createActivityEvent } from "../src/protocol.js";
import { buildWorldState } from "../src/world-state.js";

/**
 * Drives the real source with an injected factory, so what is verified is the
 * source's own behavior — lifecycle guards, serialized delivery, event shape —
 * not a fake pipeline.
 */
function harness() {
  let push: ((frame: CaptureGateFrame) => void) | null = null;
  const readerFactory: CaptureGateReaderFactory = ({ onFrame }) => {
    push = onFrame;
    return { close: () => undefined };
  };

  async function collect(): Promise<{
    source: CaptureGateActivitySource;
    results: Awaited<ReturnType<SquidCore["ingest"]>>[];
    events: ActivityEvent[];
    emit(frame: CaptureGateFrame): Promise<void>;
    stop(): Promise<void>;
  }> {
    const source = new CaptureGateActivitySource({
      readerFactory,
      sessionId: "capture-gate-test",
    });
    const core = new SquidCore(new InMemoryEventStore());
    const results: Awaited<ReturnType<SquidCore["ingest"]>>[] = [];
    const events: ActivityEvent[] = [];
    await source.start(async (event) => {
      events.push(event);
      results.push(await core.ingest(event));
    });
    return {
      source,
      results,
      events,
      emit: (frame) => {
        push!(frame);
        return source["deliveryTail"];
      },
      stop: () => source.stop(),
    };
  }

  return collect();
}

describe("CaptureGateActivitySource", () => {
  it("emits capture_gate_changed with host source and the projected payload", async () => {
    const h = await harness();
    await h.emit({ paused: true });

    expect(h.events).toHaveLength(1);
    const event = h.events[0]!;
    expect(event.kind).toBe("capture_gate_changed");
    expect(event.payload).toEqual({ paused: true });
    expect(event.source).toEqual({ kind: "host", instanceId: "capture-gate" });
    expect(event.sessionId).toBe("capture-gate-test");
    expect(event.sequence).toBe(0);

    // The projection is where the pause becomes visible to analysis.
    expect(h.results[0]!.state.captureGate).toEqual({
      paused: true,
      sourceEventId: event.eventId,
      occurredAt: event.occurredAt,
    });
    await h.stop();
  });

  it("keeps the gate across an episode boundary", async () => {
    // A pause that outlives the episode gap must still read as paused after
    // the boundary — otherwise every long pause looks like it silently ended.
    const gateEvent = createActivityEvent({
      kind: "capture_gate_changed",
      payload: { paused: true },
      source: { kind: "host", instanceId: "capture-gate" },
      sessionId: "s",
    });
    const before = new Date(gateEvent.occurredAt).getTime();
    const afterGap = new Date(before + 60 * 60 * 1000).toISOString();
    const state = buildWorldState([
      gateEvent,
      createActivityEvent({
        kind: "application_activated",
        payload: { applicationId: "1", applicationName: "Clock" },
        source: { kind: "synthetic", instanceId: "x" },
        sessionId: "s",
        occurredAt: afterGap,
      }),
    ]);
    expect(state.episode?.eventCount).toBe(1); // the activation opened a new episode
    expect(state.captureGate?.paused).toBe(true);
  });

  it("records resume as its own fact", async () => {
    const h = await harness();
    await h.emit({ paused: true });
    await h.emit({ paused: false });

    expect(h.results.map((r) => r.state.captureGate?.paused)).toEqual([true, false]);
    expect(h.events[1]!.sequence).toBe(1);
    await h.stop();
  });

  it("discards frames after stop", async () => {
    const h = await harness();
    await h.stop();
    await h.emit({ paused: true });
    expect(h.events).toHaveLength(0);
  });

  it("rejects starting twice, and starting again after stopping", async () => {
    // Lifecycle guards are what stop a stopped source from being resurrected
    // with a stale emitter — the same class of bug the other sources guard.
    const h = await harness();
    await expect(h.source.start(async () => undefined)).rejects.toThrow(/lifecycle state started/);
    await h.stop();
    await expect(h.source.start(async () => undefined)).rejects.toThrow(/lifecycle state stopped/);
  });
});
