import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  defaultWatcherFactory,
  isDefaultIncluded,
  recursiveWatcherFactory,
  type FilesystemWatcherFactory,
} from "../src/filesystem-watcher.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "squid-fs-watcher-")));
  temporaryDirectories.push(directory);
  return directory;
}

interface WatchHarness {
  events: string[];
  errors: Error[];
  waitForEvent(predicate?: (event: string) => boolean): Promise<void>;
}

/**
 * Starts a backend over `root` and records events as `"eventType filename"`
 * strings. The initial walk completes before the harness returns, so tests may
 * write fixtures right away.
 */
async function startWatcher(
  root: string,
  factory: FilesystemWatcherFactory = defaultWatcherFactory,
): Promise<WatchHarness> {
  const events: string[] = [];
  const errors: Error[] = [];
  const pendingWaits = new Set<() => void>();
  const watcher = factory({
    root,
    onEvent: (event) => {
      events.push(`${event.eventType} ${event.filename}`);
      for (const wake of pendingWaits) wake();
      pendingWaits.clear();
    },
    onError: (error) => errors.push(error),
  });
  const harness: WatchHarness = {
    events,
    errors,
    async waitForEvent(predicate) {
      const matches = (event: string) => predicate === undefined || predicate(event);
      const deadline = Date.now() + 2_000;
      while (!events.some(matches)) {
        if (Date.now() > deadline) throw new Error(`timed out; events=${JSON.stringify(events)}`);
        await new Promise<void>((resolve) => pendingWaits.add(resolve));
      }
    },
  };
  await watcher.ready;
  watchers.push(watcher);
  return harness;
}

const watchers: { close(): void }[] = [];

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.close();
});

/**
 * Counts this process's inotify watch slots by reading `/proc/self/fdinfo`.
 *
 * Bun keeps every inotify fd of a process on one fd; on Bun 1.4.2 a
 * `watcher.close()` retires its kernel watch descriptors, but releases are
 * still asynchronous relative to the call, so these counts are meaningful as
 * registration deltas while watchers are alive, never as a release
 * measurement.
 */
async function inotifyWatchCount(): Promise<number> {
  if (process.platform !== "linux") return -1;
  let count = 0;
  for (const fd of await readdir("/proc/self/fdinfo")) {
    try {
      const fdinfo = await readFile(`/proc/self/fdinfo/${fd}`, "utf8");
      count += fdinfo.split("\n").filter((line) => line.startsWith("inotify wd")).length;
    } catch {
      // The fd vanished between readdir and open; it contributes nothing.
    }
  }
  return count;
}

describe("isDefaultIncluded", () => {
  it("excludes build and VCS artifacts at any depth", () => {
    expect(isDefaultIncluded("src/main.ts")).toBe(true);
    expect(isDefaultIncluded(".git/HEAD")).toBe(false);
    expect(isDefaultIncluded("packages/app/node_modules/x/index.js")).toBe(false);
    expect(isDefaultIncluded("dist/main.js")).toBe(false);
    expect(isDefaultIncluded("src/.DS_Store")).toBe(false);
  });
});

describe("recursiveWatcherFactory", () => {
  // The event *type* is Bun's classification and wobbles under parallel load
  // (a create can arrive as two renames before its change), and the backend
  // intermittently drops an event entirely under bun-test's in-process load.
  // What this backend guarantees is forwarding with root-relative filenames —
  // so the scenario runs on a fresh root per attempt and the assertions cover
  // everything delivered. A regression in our forwarding is deterministic and
  // fails both attempts; only Bun's delivery race is retried away.
  it("forwards events with root-relative filenames", async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const root = await temporaryRoot();
      const harness = await startWatcher(root, recursiveWatcherFactory);

      await writeFile(join(root, "first.txt"), "x", "utf8");
      await writeFile(join(root, "second.txt"), "x", "utf8");
      try {
        await Promise.all([
          harness.waitForEvent((event) => event.endsWith("first.txt")),
          harness.waitForEvent((event) => event.endsWith("second.txt")),
        ]);
      } catch {
        continue;
      }

      for (const event of harness.events) expect(event).toMatch(/^(rename|change) [a-z]+\.txt$/);
      expect(harness.errors).toEqual([]);
      return;
    }
    throw new Error("both attempts hit Bun's recursive-watcher delivery race");
  });
});

describe.skipIf(process.platform !== "linux")("PrunedTreeWatcher on Linux", () => {
  it("reports writes under included directories with root-relative names", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "src"));
    const harness = await startWatcher(root);

    await writeFile(join(root, "src", "main.ts"), "x", "utf8");
    await harness.waitForEvent((event) => event === "rename src/main.ts" || event === "change src/main.ts");

    expect(harness.errors).toEqual([]);
  });

  it("spends no watch slots on excluded subtrees", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
    await mkdir(join(root, ".git", "objects"), { recursive: true });

    const before = await inotifyWatchCount();
    const watcher = defaultWatcherFactory({ root, onEvent: () => undefined, onError: () => undefined });
    watchers.push(watcher);
    await watcher.ready;

    // root + src is the entire included tree; node_modules and .git are skipped
    // before any slot is spent on them.
    const after = await inotifyWatchCount();
    expect(after - before).toBe(2);
  });

  it("never forwards events from excluded subtrees", async () => {
    const root = await temporaryRoot();
    const harness = await startWatcher(root);

    await mkdir(join(root, ".git"));
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "x", "utf8");
    await writeFile(join(root, ".git", "HEAD"), "ref", "utf8");
    // Give any misrouted event time to arrive before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(harness.events).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  it("registers a directory created after start and reports a write inside it", async () => {
    const root = await temporaryRoot();
    const harness = await startWatcher(root);

    await mkdir(join(root, "packages", "app", "src"), { recursive: true });
    await writeFile(join(root, "packages", "app", "src", "new.ts"), "x", "utf8");
    await harness.waitForEvent((event) => event.includes("packages/app/src/new.ts"));

    expect(harness.errors).toEqual([]);
  });

  it("does not report or register a new excluded subtree", async () => {
    const root = await temporaryRoot();
    const harness = await startWatcher(root);

    await mkdir(join(root, "node_modules", "late-pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "late-pkg", "index.js"), "x", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(harness.events).toEqual([]);
  });

  it("registers a reborn directory after the old one moves away", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "project"));
    await mkdir(join(root, "project", "deep"));
    const harness = await startWatcher(root);

    // Releases land asynchronously after close, so the release itself is not
    // measurable via fdinfo here; what is measurable is that reconciliation
    // ran: a directory re-created under the freed prefix is watched again.
    await rename(join(root, "project"), join(root, "moved-away"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "reborn.ts"), "x", "utf8");
    await harness.waitForEvent((event) => event.includes("project/reborn.ts"));

    expect(harness.errors).toEqual([]);
  });

  it("forwards deletions of included files from a registered directory", async () => {
    const root = await temporaryRoot();
    const target = join(root, "doomed.txt");
    await writeFile(target, "x", "utf8");
    const harness = await startWatcher(root);

    await rm(target);
    await harness.waitForEvent((event) => event.includes("doomed.txt"));

    expect(harness.errors).toEqual([]);
  });
});
