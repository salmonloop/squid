import { watch, type FSWatcher } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_EXCLUDED_SEGMENTS = new Set([".git", "node_modules", "dist", "build", ".cache"]);
const DEFAULT_EXCLUDED_FILES = new Set([".DS_Store"]);

/** A single raw watcher notification, normalized across watcher backends. */
export interface FilesystemWatchEvent {
  eventType: "rename" | "change";
  filename: string | null;
}

export interface FilesystemWatcher {
  close(): void;
  /**
   * Resolves when the backend has finished its initial registration, so a
   * caller that awaits it can promise "started means fully registered".
   * Optional: a synchronous backend is ready the moment the factory returns.
   */
  ready?: Promise<void>;
}

export type FilesystemWatcherFactory = (input: {
  root: string;
  onEvent: (event: FilesystemWatchEvent) => void;
  onError: (error: Error) => void;
}) => FilesystemWatcher;

/**
 * Decides whether a root-relative POSIX path falls inside the watched tree.
 *
 * This is a registration-time question as much as an event-time one. Linux's
 * inotify spends one watch slot per directory, so a recursive watcher over
 * `$HOME` spends slots on every `node_modules` and `.git` it contains — and
 * then filters their events away. Pruning these subtrees before watching keeps
 * the slots for directories that can actually produce activity; the source's
 * `normalize` keeps applying the same predicate to events as defense in depth.
 */
export function isDefaultIncluded(relativePosixPath: string): boolean {
  const segments = relativePosixPath.split("/");
  const filename = segments.at(-1) ?? "";
  if (DEFAULT_EXCLUDED_FILES.has(filename)) return false;
  return !segments.some((segment) => DEFAULT_EXCLUDED_SEGMENTS.has(segment));
}

export const recursiveWatcherFactory: FilesystemWatcherFactory = ({ root, onEvent, onError }) => {
  const watcher = watch(root, { recursive: true, persistent: true });
  watcher.on("change", (eventType, filename) => {
    onEvent(translateEvent(eventType, filename));
  });
  watcher.on("error", (error) => onError(wrapError(error)));
  return { close: () => watcher.close() };
};

const linuxPrunedWatcherFactory: FilesystemWatcherFactory = ({ root, onEvent, onError }) =>
  new PrunedTreeWatcher(root, onEvent, onError);

/**
 * Backend to watch `root`. Linux gets a per-directory watcher that prunes
 * artifact subtrees; every other platform keeps the single recursive watcher,
 * because ReadDirectoryChangesW and FSEvents are one handle per tree.
 */
export const defaultWatcherFactory: FilesystemWatcherFactory = process.platform === "linux"
  ? linuxPrunedWatcherFactory
  : recursiveWatcherFactory;

function translateEvent(eventType: string, filename: string | Buffer | null): FilesystemWatchEvent {
  return {
    eventType: eventType === "rename" ? "rename" : "change",
    filename: typeof filename === "string" ? filename : filename?.toString() ?? null,
  };
}

function wrapError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Errors that mean "this subtree is gone or locked"; walking past them is fine. */
const BENIGN_ERROR_CODES = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM"]);

function isBenign(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    && BENIGN_ERROR_CODES.has(error.code);
}

function isExhaustion(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOSPC";
}

/**
 * Watches a tree with one non-recursive watcher per included directory.
 *
 * A recursive `fs.watch` cannot skip subtrees before registration, so on Linux
 * the walk must do it: this backend registers directories breadth-first and
 * never descends into excluded ones. Descend-on-create closes the gap the
 * probe measured — a `mkdir` reports exactly one rename from the parent, so
 * writes inside a directory created after start are invisible until that
 * directory is registered. Renames away and deletions release the subtree's
 * watchers; ENOSPC degrades coverage instead of killing it.
 */
class PrunedTreeWatcher implements FilesystemWatcher {
  /** Keyed by root-relative POSIX path; `""` is the root itself. */
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly reconciling = new Set<string>();
  private closed = false;
  private exhausted = false;

  /**
   * Resolves when the initial walk has finished registering, so a source that
   * awaits it can promise "started means fully registered". Rejection means
   * the tree could not be watched at all; partial ENOSPC coverage resolves
   * instead of failing.
   */
  public readonly ready: Promise<void>;

  public constructor(
    private readonly root: string,
    private readonly onEvent: (event: FilesystemWatchEvent) => void,
    private readonly onError: (error: Error) => void,
  ) {
    this.ready = this.walkAndRegister();
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private async walkAndRegister(): Promise<void> {
    const queue: string[] = [""];
    while (queue.length > 0 && !this.closed) {
      const directoryKey = queue.shift()!;
      if (this.register(directoryKey, false) === null) continue;
      for (const child of await this.listIncludedChildren(directoryKey)) queue.push(child);
    }
  }

  /** Child directories worth registering; excluded and file entries are dropped. */
  private async listIncludedChildren(directoryKey: string): Promise<string[]> {
    try {
      const entries = await readdir(join(this.root, directoryKey), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => directoryKey === "" ? entry.name : `${directoryKey}/${entry.name}`)
        .filter(isDefaultIncluded);
    } catch (error) {
      if (!isBenign(error)) this.onError(wrapError(error));
      return [];
    }
  }

  /**
   * Registers one directory. Returns null when the directory is already
   * watched, the budget is spent, or the registration failed benignly.
   */
  private register(directoryKey: string, synthetic: boolean): FSWatcher | null {
    if (this.closed || this.watchers.has(directoryKey)) return null;
    if (this.exhausted) return null;

    let watcher: FSWatcher;
    try {
      watcher = watch(join(this.root, directoryKey), { persistent: true });
    } catch (error) {
      if (isExhaustion(error)) this.markExhausted();
      else if (!isBenign(error)) this.onError(wrapError(error));
      return null;
    }
    this.watchers.set(directoryKey, watcher);
    watcher.on("change", (eventType, filename) => {
      if (typeof filename === "string") this.forward(directoryKey, eventType, filename);
    });
    watcher.on("error", (error) => {
      this.onError(wrapError(error));
      this.watchers.delete(directoryKey);
    });
    if (synthetic) void this.replayNewContents(directoryKey);
    return watcher;
  }

  /**
   * Turns a per-directory notification into a root-relative one. Non-recursive
   * watchers report bare filenames; the source's contract is root-relative.
   * Renames go through reconciliation: the path either appeared as a directory
   * to register, or its old watchers are stale and must be released.
   */
  private forward(directoryKey: string, eventType: string, filename: string): void {
    const rootRelative = directoryKey === "" ? filename : `${directoryKey}/${filename}`;
    // Excluded paths cross neither the wire nor reconciliation: their subtrees
    // are unwatched by construction, so there is nothing to report and nothing
    // to re-register or release.
    if (!isDefaultIncluded(rootRelative)) return;
    this.onEvent(translateEvent(eventType, rootRelative));
    if (eventType === "rename") this.scheduleReconcile(rootRelative);
  }

  private scheduleReconcile(relativePath: string): void {
    if (this.closed || this.reconciling.has(relativePath)) return;
    this.reconciling.add(relativePath);
    void this.reconcile(relativePath).finally(() => this.reconciling.delete(relativePath));
  }

  private async reconcile(relativePath: string): Promise<void> {
    if (this.closed) return;
    // A rename invalidates the path↔inode mapping of every watcher keyed under
    // this name: its directory may have moved elsewhere, and the rename event
    // carries no MOVED_FROM context the old name could reconcile against.
    // Release first; a directory that still lives at this name — re-created or
    // otherwise — is registered fresh below. `lstat` over `stat` keeps a
    // symlink from pulling an out-of-root directory into the watched tree.
    this.releaseUnder(relativePath);
    try {
      const stats = await lstat(join(this.root, relativePath));
      if (stats.isDirectory()) this.register(relativePath, true);
    } catch (error) {
      if (!isBenign(error)) this.onError(wrapError(error));
    }
  }

  /**
   * A directory registered after start replays its current contents as
   * synthetic renames. This closes the created-then-filled race the probe
   * measured (`mkdir d && echo > d/f` lands both events before `d` can be
   * registered): files already inside get the `file_opened` a live watcher
   * would have reported. The initial walk does not replay — at `$HOME` scale
   * that would flood the pipeline with 100k probes at startup.
   */
  private replayNewContents(directoryKey: string): void {
    void (async () => {
      if (this.closed) return;
      let entries;
      try {
        entries = await readdir(join(this.root, directoryKey), { withFileTypes: true });
      } catch (error) {
        if (!isBenign(error)) this.onError(wrapError(error));
        return;
      }
      for (const entry of entries) {
        if (this.closed) return;
        const childKey = directoryKey === "" ? entry.name : `${directoryKey}/${entry.name}`;
        if (!isDefaultIncluded(childKey)) continue;
        if (entry.isDirectory()) this.register(childKey, true);
        else if (entry.isFile()) this.onEvent({ eventType: "rename", filename: childKey });
      }
    })();
  }

  private releaseUnder(prefix: string): void {
    for (const [key, watcher] of this.watchers) {
      if (key === prefix || key.startsWith(`${prefix}/`)) {
        watcher.close();
        this.watchers.delete(key);
      }
    }
  }

  /**
   * ENOSPC means the inotify budget is spent. Coverage stops growing but the
   * registered directories keep reporting, so report once and stay degraded.
   */
  private markExhausted(): void {
    if (this.exhausted) return;
    this.exhausted = true;
    this.onError(new Error(
      "inotify watch slots exhausted; filesystem coverage is partial until watchers are released",
    ));
  }
}
