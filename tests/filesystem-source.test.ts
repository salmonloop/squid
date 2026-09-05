import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { ActivitySourceDiagnostic } from "../src/activity-source.js";
import { InMemoryEventStore } from "../src/event-store.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { type FilesystemWatchEvent, type FilesystemWatcherFactory } from "../src/filesystem-watcher.js";
import { FilesystemActivitySource } from "../src/filesystem-source.js";
import type { ActivityEvent, FilePayload } from "../src/protocol.js";
import { SquidCore } from "../src/squid-core.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * A scratch directory, handed out already canonical.
 *
 * The `realpath` is not decoration. On Windows `tmpdir()` reports the 8.3 short
 * form of the user profile (`C:\\Users\\RUNNER~1\\...`), while
 * `FilesystemActivitySource.start` canonicalizes its root before watching — so a
 * fixture handing out the short form and then comparing against it is comparing
 * two different spellings of one directory. Measured on the Windows runner: the
 * root-canonicalization test failed on the mismatch, and a probe keyed by
 * `absolutePath.slice(root.length + 1)` sliced at the wrong offset and starved
 * its own `waitFor`. Both are the same fixture bug, and canonicalizing here fixes
 * it once instead of at each call.
 */
async function temporaryRoot(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "squid-fs-source-")));
  temporaryDirectories.push(directory);
  return directory;
}

interface FakeWatcher {
  factory: FilesystemWatcherFactory;
  emit(event: FilesystemWatchEvent): void;
  fail(error: Error): void;
  closeCount(): number;
  observedRoot(): string | null;
}

function fakeWatcher(): FakeWatcher {
  let onEvent: ((event: FilesystemWatchEvent) => void) | null = null;
  let onError: ((error: Error) => void) | null = null;
  let closeCount = 0;
  let observedRoot: string | null = null;

  return {
    factory: (input) => {
      onEvent = input.onEvent;
      onError = input.onError;
      observedRoot = input.root;
      return { close: () => { closeCount += 1; } };
    },
    emit: (event) => onEvent?.(event),
    fail: (error) => onError?.(error),
    closeCount: () => closeCount,
    observedRoot: () => observedRoot,
  };
}

/** Records delivered events, optionally delaying each delivery to expose ordering bugs. */
function recordingEmitter(delayMs = 0) {
  const events: ActivityEvent<FilePayload>[] = [];
  return {
    events,
    emit: async (event: ActivityEvent) => {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      events.push(event as ActivityEvent<FilePayload>);
    },
  };
}

/** A lazy backend whose `ready` can be failed once the source awaits it. Retries get a working backend. */
function lazyWatcher(onSetup?: (input: Parameters<FilesystemWatcherFactory>[0]) => void) {
  const state: { reject: ((error: Error) => void) | null; closes: number } = { reject: null, closes: 0 };
  let first = true;
  return {
    factory: ((input) => {
      if (first) {
        first = false;
        onSetup?.(input);
        return {
          close: () => {
            state.closes += 1;
          },
          ready: new Promise<void>((_resolve, reject) => {
            state.reject = reject;
          }),
        };
      }
      return { close: () => undefined };
    }) satisfies FilesystemWatcherFactory,
    closeCount: () => state.closes,
    /** Waits until the factory has run (start awaits its own setup first), then rejects `ready`. */
    async fail(error: Error): Promise<void> {
      const deadline = Date.now() + 2_000;
      while (state.reject === null) {
        if (Date.now() > deadline) throw new Error("watcher factory never ran");
        await Bun.sleep(1);
      }
      state.reject(error);
    },
  };
}

describe("FilesystemActivitySource startup validation", () => {
  it("rejects a relative root", async () => {
    const root = await temporaryRoot();
    const source = new FilesystemActivitySource({ root: "relative/path" });
    await expect(source.start(async () => undefined)).rejects.toThrow("must be an absolute path");
  });

  it("rejects a missing root", async () => {
    const root = await temporaryRoot();
    const source = new FilesystemActivitySource({ root: join(root, "absent") });
    await expect(source.start(async () => undefined)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a file root", async () => {
    const root = await temporaryRoot();
    const filePath = join(root, "not-a-directory.txt");
    await writeFile(filePath, "x", "utf8");
    const source = new FilesystemActivitySource({ root: filePath });
    await expect(source.start(async () => undefined)).rejects.toThrow("must be a directory");
  });

  it("rejects a second start on the same source", async () => {
    const root = await temporaryRoot();
    const watcher = fakeWatcher();
    const source = new FilesystemActivitySource({ root, watcherFactory: watcher.factory });

    await source.start(async () => undefined);
    await expect(source.start(async () => undefined)).rejects.toThrow("cannot start from lifecycle state started");
    await source.stop();
  });

  it("rejects starting again after stop", async () => {
    const root = await temporaryRoot();
    const watcher = fakeWatcher();
    const source = new FilesystemActivitySource({ root, watcherFactory: watcher.factory });

    await source.start(async () => undefined);
    await source.stop();
    await expect(source.start(async () => undefined)).rejects.toThrow("cannot start from lifecycle state stopped");
  });

  it("rolls back to idle when the watcher factory fails, so a retry can succeed", async () => {
    const root = await temporaryRoot();
    let attempts = 0;
    const source = new FilesystemActivitySource({
      root,
      watcherFactory: () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("no watch slots left"), { code: "ENOSPC" });
        return { close: () => undefined };
      },
    });

    await expect(source.start(async () => undefined)).rejects.toThrow("no watch slots left");
    expect(attempts).toBe(1);

    await source.start(async () => undefined);
    expect(attempts).toBe(2);
    await source.stop();
  });

  it("rolls back to idle when a lazy backend rejects its ready promise", async () => {
    const root = await temporaryRoot();
    const watcher = lazyWatcher();
    const source = new FilesystemActivitySource({ root, watcherFactory: watcher.factory });

    const started = source.start(async () => undefined);
    await watcher.fail(new Error("walk failed"));
    await expect(started).rejects.toThrow("walk failed");
    expect(watcher.closeCount()).toBe(1);
    // The source must be idle again, not wedged in `started`.
    await source.start(async () => undefined);
    await source.stop();
  });

  it("does not report events from a failed start after rollback", async () => {
    const root = await temporaryRoot();
    const emitter = recordingEmitter();
    const captured: { onEvent: ((event: FilesystemWatchEvent) => void) | null } = { onEvent: null };
    const watcher = lazyWatcher((input) => {
      captured.onEvent = input.onEvent;
    });
    const source = new FilesystemActivitySource({ root, watcherFactory: watcher.factory });

    const started = source.start(emitter.emit);
    await watcher.fail(new Error("walk failed"));
    await expect(started).rejects.toThrow("walk failed");
    captured.onEvent?.({ eventType: "change", filename: "late.ts" });
    await source.stop();

    expect(emitter.events).toEqual([]);
  });
});

describe("FilesystemActivitySource event mapping", () => {
  it("maps change to file_saved and a new rename to file_opened", async () => {
    const root = await temporaryRoot();
    const watcher = fakeWatcher();
    const emitter = recordingEmitter();
    const source = new FilesystemActivitySource({
      root,
      watcherFactory: watcher.factory,
      probeFile: async () => true,
    });

    await source.start(emitter.emit);
    watcher.emit({ eventType: "rename", filename: "src/created.ts" });
    watcher.emit({ eventType: "change", filename: "src/edited.ts" });
    await source.stop();

    expect(emitter.events.map((event) => [event.kind, event.payload.path])).toEqual([
      ["file_opened", "src/created.ts"],
      ["file_saved", "src/edited.ts"],
    ]);
    expect(emitter.events.every((event) => event.payload.applicationId === null)).toBe(true);
    expect(emitter.events.every((event) => event.source.kind === "filesystem")).toBe(true);
  });

  it("treats a rename of an already-known file as a save", async () => {
    const root = await temporaryRoot();
    const watcher = fakeWatcher();
    const emitter = recordingEmitter();
    const source = new FilesystemActivitySource({
      root,
      debounceMs: 1,
      watcherFactory: watcher.factory,
      probeFile: async () => true,
    });

    await source.start(emitter.emit);
    watcher.emit({ eventType: "rename", filename: "notes.md" });
    await waitFor(() => emitter.events.length === 1);
    watcher.emit({ eventType: "rename", filename: "notes.md" });
    await source.stop();

    expect(emitter.events.map((event) => event.kind)).toEqual(["file_opened", "file_saved"]);
  });

  it("ignores paths that no longer resolve to a regular file", async () => {
    const root = await temporaryRoot();
    const watcher = fakeWatcher();
    const emitter = recordingEmitter();
    const source = new FilesystemActivitySource({
      root,
      watcherFactory: watcher.factory,
      probeFile: async () => false,
    });

    await source.start(emitter.emit);
    watcher.emit({ eventType: "rename", filename: "removed.ts" });
    watcher.emit({ eventType: "change", filename: "also-removed.ts" });
    await source.stop();

    expect(emitter.events).toEqual([]);
  });

  it("re-reports a file as opened after it disappears and returns", async () => {
    const root = await temporaryRoot();
    const watcher = fakeWatcher();
    const emitter = recordingEmitter();
    const present = new Set<string>(["cycle.ts"]);
    let probeCount = 0;
    const source = new FilesystemActivitySource({
      root,
      debounceMs: 1,
      watcherFactory: watcher.factory,
      probeFile: async (absolutePath) => {
        probeCount += 1;
        return present.has(absolutePath.slice(root.length + 1));
      },
    });

    await source.start(emitter.emit);
    watcher.emit({ eventType: "rename", filename: "cycle.ts" });
    await waitFor(() => probeCount === 1 && emitter.events.length === 1);

    // The file disappears: the source must observe the absence and forget the path.
    present.delete("cycle.ts");
    watcher.emit({ eventType: "rename", filename: "cycle.ts" });
    await waitFor(() => probeCount === 2);
    expect(emitter.events.length).toBe(1);

    present.add("cycle.ts");
    watcher.emit({ eventType: "rename", filename: "cycle.ts" });
    await source.stop();

    expect(emitter.events.map((event) => event.kind)).toEqual(["file_opened", "file_opened"]);
  });

  it("uses the real file probe for paths inside the root", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "present.ts"), "export {};\n", "utf8");
    await mkdir(join(root, "src"));
    const watcher = fakeWatcher();
    const emitter = recordingEmitter();
    const source = new FilesystemActivitySource({ root, watcherFactory: watcher.factory });

    await source.start(emitter.emit);
    watcher.emit({ eventType: "change", filename: "present.ts" });
    watcher.emit({ eventType: "rename", filename: "src" });
    watcher.emit({ eventType: "rename", filename: "absent.ts" });
    await source.stop();

    expect(emitter.events.map((event) => event.payload.path)).toEqual(["present.ts"]);
    expect(source.diagnostics).toEqual([]);
  });
});

describe("FilesystemActivitySource filtering", () => {
  it("drops default artifacts, out-of-root paths, and caller-excluded paths", async () => {
    const root = await temporaryRoot();
    const watcher = fakeWatcher();
    const emitter = recordingEmitter();
    const source = new FilesystemActivitySource({
      root,
      watcherFactory: watcher.factory,
      probeFile: async () => true,
      include: (relativePath) => relativePath.endsWith(".ts"),
    });

    await source.start(emitter.emit);
    watcher.emit({ eventType: "change", filename: "src/keep.ts" });
    watcher.emit({ eventType: "change", filename: "src/skip.md" });
    watcher.emit({ eventType: "change", filename: "node_modules/pkg/index.ts" });
    watcher.emit({ eventType: "change", filename: "../outside.ts" });
    watcher.emit({ eventType: "change", filename: null });
    watcher.emit({ eventType: "change", filename: "" });
    await source.stop();

    expect(emitter.events.map((event) => event.payload.path)).toEqual(["src/keep.ts"]);
  });

  it("canonicalizes the watched root before watching", async () => {
    const root = await temporaryRoot();
    const watcher = fakeWatcher();
    const source = new FilesystemActivitySource({
      root: join(root, "src", "..", "."),
      watcherFactory: watcher.factory,
    });

    await mkdir(join(root, "src"));
    await source.start(async () => undefined);
    await source.stop();

    expect(watcher.observedRoot()).toBe(root);
  });
});

describe("FilesystemActivitySource delivery discipline", () => {
  it("coalesces repeated notifications for the same path", async () => {
    const root = await temporaryRoot();
    const watcher = fakeWatcher();
    const emitter = recordingEmitter();
    const source = new FilesystemActivitySource({
      root,
      watcherFactory: watcher.factory,
      probeFile: async () => true,
    });

    await source.start(emitter.emit);
    for (let index = 0; index < 5; index += 1) {
      watcher.emit({ eventType: "change", filename: "busy.ts" });
    }
    await source.stop();

    expect(emitter.events.length).toBe(1);
    expect(emitter.events[0]!.payload.path).toBe("busy.ts");
  });

  it("preserves order and sequence when the emitter is slow", async () => {
    const root = await temporaryRoot();
    const watcher = fakeWatcher();
    const emitter = recordingEmitter(5);
    const source = new FilesystemActivitySource({
      root,
      watcherFactory: watcher.factory,
      probeFile: async () => true,
    });

    await source.start(emitter.emit);
    watcher.emit({ eventType: "change", filename: "a.ts" });
    watcher.emit({ eventType: "change", filename: "b.ts" });
    watcher.emit({ eventType: "change", filename: "c.ts" });
    await source.stop();

    expect(emitter.events.map((event) => event.payload.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(emitter.events.map((event) => event.sequence)).toEqual([0, 1, 2]);
  });

  it("closes the watcher, drains pending work, and ignores later notifications", async () => {
    const root = await temporaryRoot();
    const watcher = fakeWatcher();
    const emitter = recordingEmitter();
    const source = new FilesystemActivitySource({
      root,
      debounceMs: 10_000,
      watcherFactory: watcher.factory,
      probeFile: async () => true,
    });

    await source.start(emitter.emit);
    watcher.emit({ eventType: "change", filename: "pending.ts" });
    await source.stop();

    expect(watcher.closeCount()).toBe(1);
    expect(emitter.events.map((event) => event.payload.path)).toEqual(["pending.ts"]);

    watcher.emit({ eventType: "change", filename: "after-stop.ts" });
    await source.stop();

    expect(watcher.closeCount()).toBe(1);
    expect(emitter.events.length).toBe(1);
  });
});

describe("FilesystemActivitySource diagnostics", () => {
  it("reports watcher, probe, and delivery failures without throwing", async () => {
    const root = await temporaryRoot();
    const watcher = fakeWatcher();
    const observed: ActivitySourceDiagnostic[] = [];
    const source = new FilesystemActivitySource({
      root,
      watcherFactory: watcher.factory,
      probeFile: async (absolutePath) => {
        if (absolutePath.endsWith("probe-fails.ts")) throw new Error("probe exploded");
        return true;
      },
      onDiagnostic: (diagnostic) => observed.push(diagnostic),
    });

    await source.start(async (event) => {
      if ((event.payload as FilePayload).path === "delivery-fails.ts") throw new Error("ingest rejected");
    });
    watcher.fail(new Error("watch exploded"));
    watcher.emit({ eventType: "change", filename: "probe-fails.ts" });
    watcher.emit({ eventType: "change", filename: "delivery-fails.ts" });
    await source.stop();

    expect(observed.map((diagnostic) => [diagnostic.kind, diagnostic.message])).toEqual([
      ["watcher_error", "watch exploded"],
      ["probe_error", "probe exploded"],
      ["delivery_error", "ingest rejected"],
    ]);
    expect(source.diagnostics.length).toBe(3);
  });
});

describe("FilesystemActivitySource session identity", () => {
  it("gives each instance a distinct default sessionId", async () => {
    const root = await temporaryRoot();
    const first = new FilesystemActivitySource({ root });
    const second = new FilesystemActivitySource({ root });
    expect(first.sessionId).not.toBe(second.sessionId);
  });

});

describe("FilesystemActivitySource with SquidCore", () => {
  it("feeds validated events into the Chronicle projection", async () => {
    const root = await temporaryRoot();
    const watcher = fakeWatcher();
    const store = new InMemoryEventStore();
    const core = new SquidCore(store);
    const source = new FilesystemActivitySource({
      root,
      watcherFactory: watcher.factory,
      probeFile: async () => true,
    });

    await source.start(async (event) => {
      await core.ingest(event);
    });
    watcher.emit({ eventType: "change", filename: "src/squid-core.ts" });
    watcher.emit({ eventType: "change", filename: "README.md" });
    await source.stop();

    const state = core.currentState;
    expect(state.recentFiles).toEqual(["README.md", "src/squid-core.ts"]);
    expect(state.recentActions.map((action) => action.kind)).toEqual(["file_saved", "file_saved"]);
    expect((await store.all()).map((event) => event.source.kind)).toEqual(["filesystem", "filesystem"]);
    expect(await core.restore()).toEqual(state);
  });
});

describe("FilesystemActivitySource durable restart", () => {
  it("watches the same SQLite store twice without an identity collision", async () => {
    const root = await temporaryRoot();
    const databasePath = join(root, ".squid", "events.db");

    // One call is one process's worth of watching: restore history, observe one
    // write, drain, close. Both calls emit sequence 0 for the same source id, so
    // only a per-instance sessionId keeps their identities distinct.
    async function watchOnce(): Promise<void> {
      const store = new SqliteEventStore(databasePath);
      const core = new SquidCore(store);
      await core.restore();
      const watcher = fakeWatcher();
      const source = new FilesystemActivitySource({
        root,
        watcherFactory: watcher.factory,
        probeFile: async () => true,
      });
      await source.start(async (event) => {
        await core.ingest(event);
      });
      watcher.emit({ eventType: "change", filename: "a.ts" });
      await source.stop();
      store.close();
    }

    await watchOnce();
    await watchOnce();

    const store = new SqliteEventStore(databasePath);
    const events = await store.all();
    expect(events.length).toBe(2);
    expect(events.every((event) => event.sequence === 0)).toBe(true);
    expect(new Set(events.map((event) => event.sessionId)).size).toBe(2);
    store.close();
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for source activity.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
