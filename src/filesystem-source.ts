import { watch } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ActivityEventEmitter, ActivitySource, ActivitySourceDiagnostic } from "./activity-source.js";
import { createActivityEvent, type ActivityEvent, type FilePayload } from "./protocol.js";

const DEFAULT_DEBOUNCE_MS = 25;
const DEFAULT_EXCLUDED_SEGMENTS = new Set([".git", "node_modules", "dist", "build", ".cache"]);
const DEFAULT_EXCLUDED_FILES = new Set([".DS_Store"]);

/** A single raw watcher notification, normalized across watcher backends. */
export interface FilesystemWatchEvent {
  eventType: "rename" | "change";
  filename: string | null;
}

export interface FilesystemWatcher {
  close(): void;
}

export type FilesystemWatcherFactory = (input: {
  root: string;
  onEvent: (event: FilesystemWatchEvent) => void;
  onError: (error: Error) => void;
}) => FilesystemWatcher;

export interface FilesystemActivitySourceOptions {
  /** Absolute directory to observe. Canonicalized at start. */
  root: string;
  sourceId?: string;
  /** Defaults to a fresh identity per instance; see the constructor. */
  sessionId?: string;
  /** Narrows the default artifact filter; receives a root-relative POSIX path. */
  include?: (relativePath: string) => boolean;
  debounceMs?: number;
  onDiagnostic?: (diagnostic: ActivitySourceDiagnostic) => void;
  /** Injection seam for tests; defaults to a recursive `node:fs` watcher. */
  watcherFactory?: FilesystemWatcherFactory;
  /** Injection seam for tests; resolves whether a path is a regular file. */
  probeFile?: (absolutePath: string) => Promise<boolean>;
}

type SourceLifecycle = "idle" | "started" | "stopped";

interface PendingChange {
  timer: ReturnType<typeof setTimeout>;
  sawRename: boolean;
}

/**
 * Emits validated `file_opened` / `file_saved` activity for one project root.
 *
 * Filesystem writes identify a path, not an application, so every event carries
 * `applicationId: "filesystem"`. Correlating a write with the editor that made
 * it requires a future IDE or native source.
 */
export class FilesystemActivitySource implements ActivitySource {
  public readonly id: string;
  /** Part of this source's event identity, alongside `id`; see the constructor. */
  public readonly sessionId: string;

  private readonly debounceMs: number;
  private readonly include: (relativePath: string) => boolean;
  private readonly watcherFactory: FilesystemWatcherFactory;
  private readonly probeFile: (absolutePath: string) => Promise<boolean>;
  private readonly onDiagnostic: ((diagnostic: ActivitySourceDiagnostic) => void) | undefined;
  private readonly configuredRoot: string;

  private readonly recordedDiagnostics: ActivitySourceDiagnostic[] = [];
  private readonly pendingChanges = new Map<string, PendingChange>();
  private readonly knownFiles = new Set<string>();

  private lifecycle: SourceLifecycle = "idle";
  private canonicalRoot: string | null = null;
  private watcher: FilesystemWatcher | null = null;
  private emit: ActivityEventEmitter | null = null;
  private deliveryTail: Promise<void> = Promise.resolve();
  private sequence = 0;

  public constructor(options: FilesystemActivitySourceOptions) {
    this.configuredRoot = options.root;
    this.id = options.sourceId ?? "filesystem-local";
    // `sequence` restarts at 0 for every instance, so the session must be the
    // part of the identity tuple that changes. A constant default would make
    // every run re-emit (filesystem, <id>, <session>, 0) and collide with its
    // own history in any store that enforces source-local identity.
    this.sessionId = options.sessionId ?? `filesystem-${crypto.randomUUID()}`;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.include = options.include ?? (() => true);
    this.watcherFactory = options.watcherFactory ?? defaultWatcherFactory;
    this.probeFile = options.probeFile ?? defaultProbeFile;
    this.onDiagnostic = options.onDiagnostic;
  }

  public get diagnostics(): readonly ActivitySourceDiagnostic[] {
    return this.recordedDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  public async start(emit: ActivityEventEmitter): Promise<void> {
    if (this.lifecycle !== "idle") {
      throw new Error(`Filesystem source ${this.id} cannot start from lifecycle state ${this.lifecycle}.`);
    }
    if (!isAbsolute(this.configuredRoot)) {
      throw new Error(`Filesystem source root must be an absolute path: ${this.configuredRoot}`);
    }

    const canonicalRoot = await realpath(this.configuredRoot);
    const rootStats = await stat(canonicalRoot);
    if (!rootStats.isDirectory()) {
      throw new Error(`Filesystem source root must be a directory: ${canonicalRoot}`);
    }

    this.canonicalRoot = canonicalRoot;
    this.emit = emit;
    this.lifecycle = "started";
    this.watcher = this.watcherFactory({
      root: canonicalRoot,
      onEvent: (event) => this.handleWatchEvent(event),
      onError: (error) => this.record("watcher_error", error),
    });
  }

  public async stop(): Promise<void> {
    if (this.lifecycle !== "started") {
      this.lifecycle = "stopped";
      await this.deliveryTail;
      return;
    }

    this.lifecycle = "stopped";
    this.watcher?.close();
    this.watcher = null;

    for (const [relativePath, pending] of [...this.pendingChanges]) {
      clearTimeout(pending.timer);
      this.pendingChanges.delete(relativePath);
      this.enqueue(relativePath, pending.sawRename);
    }

    await this.deliveryTail;
    this.emit = null;
  }

  private handleWatchEvent(event: FilesystemWatchEvent): void {
    if (this.lifecycle !== "started") return;

    const relativePath = this.normalize(event.filename);
    if (relativePath === null) return;

    const pending = this.pendingChanges.get(relativePath);
    if (pending) clearTimeout(pending.timer);

    const sawRename = (pending?.sawRename ?? false) || event.eventType === "rename";
    const timer = setTimeout(() => {
      this.pendingChanges.delete(relativePath);
      this.enqueue(relativePath, sawRename);
    }, this.debounceMs);
    this.pendingChanges.set(relativePath, { timer, sawRename });
  }

  /** Serializes probing and delivery so per-source event order is stable. */
  private enqueue(relativePath: string, sawRename: boolean): void {
    this.deliveryTail = this.deliveryTail.then(() => this.deliver(relativePath, sawRename));
  }

  private async deliver(relativePath: string, sawRename: boolean): Promise<void> {
    const emit = this.emit;
    const canonicalRoot = this.canonicalRoot;
    if (emit === null || canonicalRoot === null) return;

    let isRegularFile: boolean;
    try {
      isRegularFile = await this.probeFile(resolve(canonicalRoot, relativePath));
    } catch (error) {
      this.record("probe_error", error);
      return;
    }

    if (!isRegularFile) {
      this.knownFiles.delete(relativePath);
      return;
    }

    const isNewFile = sawRename && !this.knownFiles.has(relativePath);
    this.knownFiles.add(relativePath);

    try {
      await emit(this.buildEvent(isNewFile ? "file_opened" : "file_saved", relativePath));
    } catch (error) {
      this.record("delivery_error", error);
    }
  }

  private buildEvent(kind: "file_opened" | "file_saved", relativePath: string): ActivityEvent<FilePayload> {
    return createActivityEvent<FilePayload>({
      kind,
      payload: { path: relativePath, applicationId: "filesystem" },
      source: { kind: "filesystem", instanceId: this.id },
      sessionId: this.sessionId,
      sequence: this.sequence++,
    });
  }

  /** Returns a root-relative POSIX path, or null when the path is out of scope. */
  private normalize(filename: string | null): string | null {
    const canonicalRoot = this.canonicalRoot;
    if (filename === null || filename.length === 0 || canonicalRoot === null) return null;

    const absolutePath = resolve(canonicalRoot, filename);
    const relativePath = relative(canonicalRoot, absolutePath);
    if (relativePath.length === 0 || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
      return null;
    }

    const posixPath = relativePath.split(sep).join("/");
    return isDefaultIncluded(posixPath) && this.include(posixPath) ? posixPath : null;
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

export function isDefaultIncluded(relativePosixPath: string): boolean {
  const segments = relativePosixPath.split("/");
  const filename = segments.at(-1) ?? "";
  if (DEFAULT_EXCLUDED_FILES.has(filename)) return false;
  return !segments.some((segment) => DEFAULT_EXCLUDED_SEGMENTS.has(segment));
}

const defaultWatcherFactory: FilesystemWatcherFactory = ({ root, onEvent, onError }) => {
  const watcher = watch(root, { recursive: true, persistent: true });
  watcher.on("change", (eventType, filename) => {
    onEvent({
      eventType: eventType === "rename" ? "rename" : "change",
      filename: typeof filename === "string" ? filename : filename?.toString() ?? null,
    });
  });
  watcher.on("error", (error) => onError(error instanceof Error ? error : new Error(String(error))));
  return { close: () => watcher.close() };
};

async function defaultProbeFile(absolutePath: string): Promise<boolean> {
  try {
    return (await stat(absolutePath)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}
