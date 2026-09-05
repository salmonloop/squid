import { describe, expect, it } from "bun:test";
import type { ActivitySourceDiagnostic } from "../src/activity-source.js";
import { InMemoryEventStore } from "../src/event-store.js";
import type {
  ActivityEvent,
  ApplicationActivatedPayload,
  FocusChangedPayload,
  TextContextChangedPayload,
  WindowChangedPayload,
} from "../src/protocol.js";
import {
  ScreenTextActivitySource,
  type ScreenTextFrame,
  type ScreenTextReaderFactory,
} from "../src/screen-text-source.js";
import { SquidCore } from "../src/squid-core.js";

interface FakeReader {
  factory: ScreenTextReaderFactory;
  emit(frame: ScreenTextFrame): void;
  fail(error: Error): void;
  closeCount(): number;
}

/**
 * Stands in for every screen-text backend. The adapter is tested only through
 * this seam, so no test depends on an accessibility API, a subprocess, or a
 * timer owned by a real reader.
 */
function fakeReader(): FakeReader {
  let onFrame: ((frame: ScreenTextFrame) => void) | null = null;
  let onError: ((error: Error) => void) | null = null;
  let closeCount = 0;

  return {
    factory: (input) => {
      onFrame = input.onFrame;
      onError = input.onError;
      return { close: () => { closeCount += 1; } };
    },
    emit: (frame) => onFrame?.(frame),
    fail: (error) => onError?.(error),
    closeCount: () => closeCount,
  };
}

/** Records delivered events, optionally delaying each delivery to expose ordering bugs. */
function recordingEmitter(delayMs = 0) {
  const events: ActivityEvent[] = [];
  return {
    events,
    emit: async (event: ActivityEvent) => {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      events.push(event);
    },
  };
}

/**
 * A frame with every field populated, so each test can subtract from a complete
 * sample rather than assemble one.
 */
const fullFrame: ScreenTextFrame = {
  applicationId: "501",
  applicationName: "Terminal",
  windowTitle: "bash — squid",
  focusedRole: "editor",
  focusedLabel: "Editor",
  textContext: { prefix: "const ", suffix: ";", selection: "value", language: "typescript" },
  occurredAt: "2026-08-20T10:00:00.000Z",
};

const allKinds: ActivityEvent["kind"][] = [
  "application_activated",
  "window_changed",
  "focus_changed",
  "text_context_changed",
];

function harness(options: { delayMs?: number; debounceMs?: number } = {}) {
  const reader = fakeReader();
  const emitter = recordingEmitter(options.delayMs ?? 0);
  const source = new ScreenTextActivitySource({
    readerFactory: reader.factory,
    debounceMs: options.debounceMs ?? 1,
  });
  return {
    reader,
    emitter,
    source,
    start: () => source.start(emitter.emit),
    kinds: () => emitter.events.map((event) => event.kind),
    /**
     * Emits a frame and waits until exactly `expectedTotal` events have been
     * delivered. Settling on a count rather than a delay keeps these tests free
     * of timing slack; a frame expected to change nothing is instead settled by
     * `stop()`, which flushes the debounce window and drains delivery.
     */
    async settle(frame: ScreenTextFrame, expectedTotal: number): Promise<void> {
      reader.emit(frame);
      await waitFor(() => emitter.events.length === expectedTotal);
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for source activity.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("ScreenTextActivitySource lifecycle", () => {
  it("rejects a second start on the same source", async () => {
    const h = harness();
    await h.start();
    await expect(h.start()).rejects.toThrow("cannot start from lifecycle state started");
    await h.source.stop();
  });

  it("rejects starting again after stop", async () => {
    const h = harness();
    await h.start();
    await h.source.stop();
    await expect(h.start()).rejects.toThrow("cannot start from lifecycle state stopped");
  });

  it("closes the reader exactly once across repeated stops", async () => {
    const h = harness();
    await h.start();
    await h.source.stop();
    await h.source.stop();
    expect(h.reader.closeCount()).toBe(1);
  });

  it("stays startable after a backend that fails to initialize", async () => {
    // A reader asked for the wrong platform, or a future one whose permission
    // check fails, must not wedge the source: the caller fixes the cause and
    // retries, which only works if a failed start left the lifecycle at idle.
    const working = fakeReader();
    const emitter = recordingEmitter();
    let failing = true;
    const source = new ScreenTextActivitySource({
      readerFactory: (input) => {
        if (failing) throw new Error("accessibility permission denied");
        return working.factory(input);
      },
      debounceMs: 1,
    });

    await expect(source.start(emitter.emit)).rejects.toThrow("accessibility permission denied");

    failing = false;
    await source.start(emitter.emit);
    working.emit(fullFrame);
    await source.stop();

    expect(emitter.events.map((event) => event.kind)).toEqual(allKinds);
  });
});

describe("ScreenTextActivitySource frame mapping", () => {
  it("maps a complete frame onto four host events in reducer order", async () => {
    const h = harness();
    await h.start();
    h.reader.emit(fullFrame);
    await h.source.stop();

    expect(h.kinds()).toEqual(allKinds);
    expect(h.emitter.events.every((event) => event.source.kind === "host")).toBe(true);
    expect(h.emitter.events.every((event) => event.source.instanceId === "screen-text-host")).toBe(true);
    expect(h.emitter.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
    // One sample is one instant, so every event it produced shares its timestamp.
    expect(h.emitter.events.every((event) => event.occurredAt === fullFrame.occurredAt)).toBe(true);

    expect(h.emitter.events[0]!.payload as ApplicationActivatedPayload).toEqual({
      applicationId: "501",
      applicationName: "Terminal",
    });
    expect(h.emitter.events[1]!.payload as WindowChangedPayload).toEqual({
      applicationId: "501",
      title: "bash — squid",
      bounds: null,
    });
    expect(h.emitter.events[2]!.payload as FocusChangedPayload).toEqual({
      applicationId: "501",
      windowTitle: "bash — squid",
      role: "editor",
      label: "Editor",
    });
    expect(h.emitter.events[3]!.payload as TextContextChangedPayload).toEqual({
      prefix: "const ",
      suffix: ";",
      selection: "value",
      language: "typescript",
    });
  });
});

describe("ScreenTextActivitySource change detection", () => {
  it("emits nothing for a repeated identical frame", async () => {
    const h = harness();
    await h.start();
    await h.settle(fullFrame, 4);

    h.reader.emit(fullFrame);
    await h.source.stop();

    expect(h.kinds()).toEqual(allKinds);
  });

  it("reports a title-only change as both a window and a focus change", async () => {
    const h = harness();
    await h.start();
    await h.settle(fullFrame, 4);

    // `focus.windowTitle` is carried forward by `text_context_changed` in the
    // reducer, so leaving it stale here would mislabel later text events.
    h.reader.emit({ ...fullFrame, windowTitle: "bash — squid/src" });
    await h.source.stop();

    expect(h.kinds().slice(4)).toEqual(["window_changed", "focus_changed", "text_context_changed"]);
  });

  it("reports a role-only change as a focus change alone", async () => {
    const h = harness();
    await h.start();
    await h.settle(fullFrame, 4);

    h.reader.emit({ ...fullFrame, focusedRole: "text_input" });
    await h.source.stop();

    expect(h.kinds().slice(4)).toEqual(["focus_changed"]);
  });

  it("reports a selection-only change as a text context change alone", async () => {
    const h = harness();
    await h.start();
    await h.settle(fullFrame, 4);

    h.reader.emit({
      ...fullFrame,
      textContext: { ...fullFrame.textContext!, selection: "other" },
    });
    await h.source.stop();

    expect(h.kinds().slice(4)).toEqual(["text_context_changed"]);
  });

  it("never invents text context for a frame that carries none", async () => {
    const h = harness();
    const { textContext: _omitted, ...withoutText } = fullFrame;
    await h.start();
    h.reader.emit(withoutText);
    await h.source.stop();

    expect(h.kinds()).toEqual(["application_activated", "window_changed", "focus_changed"]);
  });
});

describe("ScreenTextActivitySource degradation", () => {
  it("emits nothing when the backend could not identify the foreground application", async () => {
    const h = harness();
    const { applicationId: _omitted, ...withoutApplication } = fullFrame;
    await h.start();
    h.reader.emit(withoutApplication);
    await h.source.stop();

    expect(h.emitter.events).toEqual([]);
  });

  it("treats an empty application id as no application at all", async () => {
    const h = harness();
    await h.start();
    h.reader.emit({ ...fullFrame, applicationId: "" });
    await h.source.stop();

    expect(h.emitter.events).toEqual([]);
  });

  it("skips only the activation event when the application name is missing", async () => {
    const h = harness();
    const { applicationName: _omitted, ...withoutName } = fullFrame;
    await h.start();
    h.reader.emit(withoutName);
    await h.source.stop();

    expect(h.kinds()).toEqual(["window_changed", "focus_changed", "text_context_changed"]);
  });

  it("fills missing focus attributes with the protocol's neutral values", async () => {
    const h = harness();
    const { windowTitle: _title, focusedRole: _role, focusedLabel: _label, ...sparse } = fullFrame;
    await h.start();
    h.reader.emit(sparse);
    await h.source.stop();

    // A missing title suppresses `window_changed` — claiming `title: ""` would
    // state something false — but focus is still a fact worth reporting.
    expect(h.kinds()).toEqual(["application_activated", "focus_changed", "text_context_changed"]);
    expect(h.emitter.events[1]!.payload as FocusChangedPayload).toEqual({
      applicationId: "501",
      windowTitle: "",
      role: "unknown",
      label: null,
    });
  });

  it("reports an empty window title as a real title when the backend sends one", async () => {
    const h = harness();
    await h.start();
    h.reader.emit({ ...fullFrame, windowTitle: "" });
    await h.source.stop();

    expect(h.kinds()).toEqual(allKinds);
    expect((h.emitter.events[1]!.payload as WindowChangedPayload).title).toBe("");
  });
});

describe("ScreenTextActivitySource delivery discipline", () => {
  it("preserves order and sequence when the emitter is slow", async () => {
    const h = harness({ delayMs: 5 });
    await h.start();
    await h.settle(fullFrame, 4);
    await h.settle({ ...fullFrame, textContext: { ...fullFrame.textContext!, selection: "b" } }, 5);
    h.reader.emit({ ...fullFrame, textContext: { ...fullFrame.textContext!, selection: "c" } });
    await h.source.stop();

    expect(h.kinds()).toEqual([...allKinds, "text_context_changed", "text_context_changed"]);
    expect(h.emitter.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(h.emitter.events.slice(4).map((event) => (event.payload as TextContextChangedPayload).selection))
      .toEqual(["b", "c"]);
  });

  it("collapses a burst of identical frames to nothing new", async () => {
    const h = harness({ debounceMs: 50 });
    await h.start();
    await h.settle(fullFrame, 4);

    for (let index = 0; index < 5; index += 1) h.reader.emit(fullFrame);
    await h.source.stop();

    expect(h.kinds()).toEqual(allKinds);
  });

  it("collapses a burst of changing frames to the last value in the window", async () => {
    const h = harness({ debounceMs: 50 });
    await h.start();
    await h.settle(fullFrame, 4);

    for (const selection of ["a", "b", "c", "d", "e"]) {
      h.reader.emit({ ...fullFrame, textContext: { ...fullFrame.textContext!, selection } });
    }
    await h.source.stop();

    expect(h.kinds().slice(4)).toEqual(["text_context_changed"]);
    expect((h.emitter.events[4]!.payload as TextContextChangedPayload).selection).toBe("e");
  });

  it("closes the reader, flushes the pending frame, and ignores later frames", async () => {
    const h = harness({ debounceMs: 10_000 });
    await h.start();
    h.reader.emit(fullFrame);
    await h.source.stop();

    expect(h.reader.closeCount()).toBe(1);
    expect(h.kinds()).toEqual(allKinds);

    h.reader.emit({ ...fullFrame, windowTitle: "after stop" });
    await h.source.stop();

    expect(h.reader.closeCount()).toBe(1);
    expect(h.kinds()).toEqual(allKinds);
  });
});

describe("ScreenTextActivitySource diagnostics", () => {
  it("records reader and delivery failures without throwing", async () => {
    const reader = fakeReader();
    const observed: ActivitySourceDiagnostic[] = [];
    const delivered: ActivityEvent[] = [];
    let rejectWindowEvents = true;
    const source = new ScreenTextActivitySource({
      readerFactory: reader.factory,
      debounceMs: 1,
      onDiagnostic: (diagnostic) => observed.push(diagnostic),
    });

    await source.start(async (event) => {
      if (rejectWindowEvents && event.kind === "window_changed") throw new Error("ingest rejected");
      delivered.push(event);
    });
    reader.fail(new Error("reader exploded"));
    reader.emit(fullFrame);
    await waitFor(() => delivered.length === 3);

    expect(observed.map((diagnostic) => [diagnostic.kind, diagnostic.message])).toEqual([
      ["watcher_error", "reader exploded"],
      ["delivery_error", "ingest rejected"],
    ]);
    // One rejected event must not suppress the unrelated facts in the same sample.
    expect(delivered.map((event) => event.kind))
      .toEqual(["application_activated", "focus_changed", "text_context_changed"]);

    // The rejected payload was never recorded as emitted, so an unchanged frame
    // retries it — and retries nothing else.
    rejectWindowEvents = false;
    reader.emit(fullFrame);
    await source.stop();

    expect(delivered.map((event) => event.kind)).toEqual([
      "application_activated",
      "focus_changed",
      "text_context_changed",
      "window_changed",
    ]);
    expect(source.diagnostics.length).toBe(2);
  });
});

describe("ScreenTextActivitySource session identity", () => {
  it("gives each instance a distinct default sessionId", () => {
    const first = new ScreenTextActivitySource({ readerFactory: fakeReader().factory });
    const second = new ScreenTextActivitySource({ readerFactory: fakeReader().factory });
    expect(first.sessionId).not.toBe(second.sessionId);
  });
});

describe("ScreenTextActivitySource with SquidCore", () => {
  it("feeds validated events into the Chronicle projection", async () => {
    const reader = fakeReader();
    const store = new InMemoryEventStore();
    const core = new SquidCore(store);
    const source = new ScreenTextActivitySource({
      readerFactory: reader.factory,
      debounceMs: 1,
    });

    await source.start(async (event) => {
      await core.ingest(event);
    });
    reader.emit(fullFrame);
    await waitFor(() => core.currentState.focus !== null);
    reader.emit({
      ...fullFrame,
      applicationId: "742",
      applicationName: "Code",
      windowTitle: "screen-text-source.ts",
      focusedRole: "text_input",
      focusedLabel: null,
    });
    await source.stop();

    const state = core.currentState;
    expect(state.activeApplication).toEqual({ id: "742", name: "Code" });
    expect(state.activeWindow).toEqual({
      applicationId: "742",
      title: "screen-text-source.ts",
      bounds: null,
    });
    expect(state.focus).toEqual({
      applicationId: "742",
      windowTitle: "screen-text-source.ts",
      role: "text_input",
      label: null,
    });
    // The second frame carries the same text again. Its owner changed, so the
    // source must re-emit it instead of letting payload-only dedupe suppress it.
    expect(state.textContext?.owner).toEqual({
      applicationId: "742",
      windowTitle: "screen-text-source.ts",
    });
    expect(state.textContext?.selection).toBe("value");
    expect((await store.all()).every((event) => event.source.kind === "host")).toBe(true);
    expect(await core.restore()).toEqual(state);
  });

  it("stops offering a released selection as the current one", async () => {
    // The leak this exists to prevent: releasing a selection changes nothing else
    // about the frame, so every other emission dedupes away. If the backend
    // answered a released selection with absence instead of an empty reading,
    // there would be no event at all and the agent would keep being told the
    // user has that text selected.
    const reader = fakeReader();
    const core = new SquidCore(new InMemoryEventStore());
    const source = new ScreenTextActivitySource({
      readerFactory: reader.factory,
      debounceMs: 1,
    });

    await source.start(async (event) => {
      await core.ingest(event);
    });
    reader.emit(fullFrame);
    await waitFor(() => core.currentState.textContext?.selection === "value");

    reader.emit({ ...fullFrame, textContext: { ...fullFrame.textContext!, selection: "" } });
    await source.stop();

    const state = core.currentState;
    expect(state.textContext?.selection).toBe("");
    // The owner is still known: nothing about the focus changed, so the empty
    // reading belongs to the same window the selection did.
    expect(state.textContext?.owner).toEqual({
      applicationId: "501",
      windowTitle: "bash — squid",
    });
  });
});

describe("ScreenTextActivitySource frame projection failures", () => {
  it("does not let a malformed frame poison the delivery chain", async () => {
    // Projection reads fields off the frame, so a backend that pushes a
    // non-object (a broken JSON frames file, a reader bug) makes it throw.
    // That throw used to escape `deliver`, rejecting the shared delivery tail —
    // which then rejected every later frame's delivery and left `stop()`
    // rejecting instead of draining.
    const reader = fakeReader();
    const emitter = recordingEmitter();
    const source = new ScreenTextActivitySource({
      readerFactory: reader.factory,
      debounceMs: 0,
    });

    await source.start(emitter.emit);

    reader.emit(null as unknown as ScreenTextFrame);
    await new Promise((resolve) => setTimeout(resolve, 5));

    // A good frame delivered after the bad one must still arrive.
    reader.emit({ applicationId: "742", applicationName: "Code" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await source.stop();

    expect(emitter.events.map((event) => event.kind)).toEqual([
      "application_activated",
      "focus_changed",
    ]);
    expect(source.diagnostics.map((diagnostic) => diagnostic.kind)).toContain("delivery_error");
  });
});
