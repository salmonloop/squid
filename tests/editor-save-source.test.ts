import { describe, expect, it } from "bun:test";
import {
  EditorSaveActivitySource,
  projectEditorSaveFrame,
  type EditorSaveFrame,
  type EditorSaveReaderFactory,
} from "../src/editor-save-source.js";
import type { ActivityEvent } from "../src/protocol.js";

const ROOT = "/workspace/project";

describe("projectEditorSaveFrame", () => {
  const frame = (overrides: Partial<EditorSaveFrame> = {}): EditorSaveFrame => ({
    path: "/workspace/project/src/a.ts",
    pid: 4242,
    ...overrides,
  });

  it("carries the editor's own pid as the applicationId", () => {
    // The identity the screen reader reports for the foreground is a unix pid;
    // `admitRunTests` pairs them by plain equality, so no translation here.
    expect(projectEditorSaveFrame(frame(), ROOT)).toEqual({
      relativePath: "src/a.ts",
      payload: { path: "src/a.ts", applicationId: "4242" },
    });
  });

  it("emits a root-relative POSIX path matching the filesystem source", () => {
    // Admission resolves both sources' paths against the same working
    // directory; a different shape for the same fact would split the rule's
    // view of one save in two.
    expect(projectEditorSaveFrame(frame({ path: ROOT + "/src/b/c.ts" }), ROOT)?.payload.path)
      .toBe("src/b/c.ts");
  });

  it("refuses a save outside the watched root", () => {
    // An editor can have files from anywhere open; this source only speaks for
    // the watched project.
    const outside = projectEditorSaveFrame(frame({ path: "/elsewhere/x.ts" }), ROOT);
    expect(outside).toBeNull();

    // The traversal forms too: a plugin bug or a hostile line must not widen
    // the root by pretending to be inside it.
    expect(projectEditorSaveFrame(frame({ path: "/workspace/project/../secret.ts" }), ROOT))
      .toBeNull();
  });

  it("refuses frames without a usable pid", () => {
    for (const pid of [Number.NaN, 0, -1, 1.5]) {
      expect(projectEditorSaveFrame(frame({ pid }), ROOT)).toBeNull();
    }
  });

  it("refuses relative or empty paths", () => {
    // A relative path would be resolved against *our* cwd, not the editor's —
    // resolving it here would invent a location the writer never named.
    expect(projectEditorSaveFrame(frame({ path: "src/relative.ts" }), ROOT)).toBeNull();
    expect(projectEditorSaveFrame(frame({ path: "   " }), ROOT)).toBeNull();
  });
});

/**
 * Drives the real source with an injected factory, so what is verified is the
 * source's own behavior — lifecycle guards, serialized delivery, event shape —
 * not a fake pipeline.
 */
function harness() {
  let push: ((frame: EditorSaveFrame) => void) | null = null;
  const readerFactory: EditorSaveReaderFactory = ({ onFrame }) => {
    push = onFrame;
    return { close: () => undefined };
  };

  async function collect(): Promise<{
    source: EditorSaveActivitySource;
    events: ActivityEvent[];
    emit(frame: EditorSaveFrame): Promise<void>;
    stop(): Promise<void>;
  }> {
    const source = new EditorSaveActivitySource({
      readerFactory,
      root: ROOT,
      sessionId: "editor-save-test",
    });
    const events: ActivityEvent[] = [];
    await source.start(async (event) => {
      events.push(event);
      await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    });
    return {
      source,
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

describe("EditorSaveActivitySource", () => {
  it("emits file_saved with kind ide and the projected payload", async () => {
    const h = await harness();
    await h.emit({ path: "/workspace/project/src/a.ts", pid: 4242 });

    expect(h.events).toHaveLength(1);
    const event = h.events[0]!;
    expect(event.kind).toBe("file_saved");
    expect(event.payload).toEqual({ path: "src/a.ts", applicationId: "4242" });
    expect(event.source).toEqual({ kind: "ide", instanceId: "editor-save-host" });
    expect(event.sessionId).toBe("editor-save-test");
    expect(event.sequence).toBe(0);
    await h.stop();
  });

  it("advances sequence only for delivered events", async () => {
    // A refused frame is not an observation; counting it toward the sequence
    // would leave gaps that suggest events were dropped after validation.
    const h = await harness();
    await h.emit({ path: "relative.ts", pid: 4242 } as EditorSaveFrame);
    await h.emit({ path: "/workspace/project/src/a.ts", pid: 4242 });

    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.sequence).toBe(0);
    await h.stop();
  });

  it("keeps emitting after one malformed frame", async () => {
    // One bad report must not wedge delivery: the editor keeps saving.
    const h = await harness();
    try {
      push!({} as EditorSaveFrame); // reaches deliver, projection throws/refuses
    } catch {
      // handleFrame serializes through the tail, so nothing escapes
    }
    await h.emit({ path: "/workspace/project/src/a.ts", pid: 7 });
    expect(h.events).toHaveLength(1);
    await h.stop();
  });

  it("discards frames after stop", async () => {
    const h = await harness();
    await h.stop();
    await h.emit({ path: "/workspace/project/src/a.ts", pid: 4242 });
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

  it("requires an absolute root at start", async () => {
    const source = new EditorSaveActivitySource({
      readerFactory: () => ({ close: () => undefined }),
      root: "relative/root",
    });
    await expect(source.start(async () => undefined)).rejects.toThrow(/absolute path/);
  });
});
