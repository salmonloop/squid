import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ActivityEventEmitter,
  ActivitySource,
  ActivitySourceDiagnostic,
} from "./activity-source.js";
import { SourceDiagnosticLog } from "./source-diagnostics.js";
import {
  createActivityEvent,
  type ActivityEvent,
  type FilePayload,
} from "./protocol.js";

/**
 * One save an editor extension reports about itself.
 *
 * Note what is deliberately absent: file contents, cursor positions, unsaved
 * buffer text. The frame carries a path and the writing process's unix pid,
 * nothing more — capture is irreversible, and buffer content is exactly the
 * text this project exists to avoid storing.
 *
 * `pid` is the *editor's own* `process.pid`, reported by the plugin running
 * inside it. It must not be filled in by anything else: the whole point of
 * this source is that the writer speaks for itself, rather than an observer
 * inferring who wrote from whatever happened to be in front.
 */
export interface EditorSaveFrame {
  /** Absolute path of the saved file, as the editor sees it. */
  readonly path: string;
  /** Unix pid of the editor process performing the save. */
  readonly pid: number;
  /** ISO timestamp of the save. Defaults to delivery time when absent. */
  readonly occurredAt?: string;
}

export interface EditorSaveReader {
  close(): void;
}

/**
 * Injection seam for an editor integration. Mirrors the other reader
 * factories: the backend pushes frames and errors and owns nothing else. A
 * VS Code extension, a JetBrains plugin, and a Neovim autocmd are each one
 * implementation of this one function type.
 */
export type EditorSaveReaderFactory = (input: {
  onFrame: (frame: EditorSaveFrame) => void;
  onError: (error: Error) => void;
}) => EditorSaveReader;

export interface EditorSaveActivitySourceOptions {
  readerFactory: EditorSaveReaderFactory;
  /** Absolute project root; saves outside it are dropped quietly. */
  root: string;
  sourceId?: string;
  /** Defaults to a fresh identity per instance; see the constructor. */
  sessionId?: string;
  onDiagnostic?: (diagnostic: ActivitySourceDiagnostic) => void;
}

type SourceLifecycle = "idle" | "started" | "stopped";

/**
 * Projects a frame onto a `file_saved` payload, or refuses it.
 *
 * Returns the payload plus the resolved root-relative path, or null when the
 * frame describes nothing this source can honestly say: a non-object, an
 * empty path, a missing or non-integer pid, or a file outside the watched
 * root. Every refusal is a quiet observation — a malformed line from one
 * plugin version must not look like an error worth alarming on.
 *
 * The pid becomes the payload's `applicationId` verbatim, because that is the
 * exact identity the screen reader reports for the foreground process —
 * `admitRunTests`'s existing equality check pairs them with no translation
 * layer and no weakening.
 */
export function projectEditorSaveFrame(
  frame: EditorSaveFrame,
  canonicalRoot: string,
): { payload: FilePayload; relativePath: string } | null {
  if (typeof frame !== "object" || frame === null) return null;
  const path = typeof frame.path === "string" ? frame.path.trim() : "";
  const pid = frame.pid;
  if (
    path.length === 0 ||
    !isAbsolute(path) ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0
  ) {
    return null;
  }

  // Root-relative POSIX, matching what the filesystem source emits for the
  // same file: admission resolves both against the working directory, and a
  // source that emitted a different shape for the same fact would split the
  // rule's view of one save into two.
  const absolutePath = resolve(canonicalRoot, path);
  const relativePath = relative(canonicalRoot, absolutePath);
  if (relativePath.length === 0 || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    return null;
  }

  return {
    relativePath: relativePath.split(sep).join("/"),
    payload: { path: relativePath.split(sep).join("/"), applicationId: String(pid) },
  };
}

/**
 * Turns editor-reported saves into `file_saved` events carrying the editor's
 * real identity.
 *
 * This is the source issue #7 was written for: `FilesystemActivitySource`
 * honestly reports `applicationId: null` because a watcher cannot know the
 * writer, and `admitRunTests` correctly refuses unknown owners. An editor
 * plugin *can* know — it performed the save — so this source carries that
 * knowledge instead of guessing it, and the admission rule accepts it with no
 * change: the same equality check that refused the watcher's null now matches
 * the editor's pid against the foreground application.
 *
 * Unlike the filesystem source there is no debounce and no known-file set.
 * The editor has already done the work a watcher approximates: it fires once
 * per actual save, and two saves of one file are two facts, not a repeated
 * observation of one.
 */
export class EditorSaveActivitySource implements ActivitySource {
  public readonly id: string;
  /** Part of this source's event identity, alongside `id`; see the constructor. */
  public readonly sessionId: string;

  private readonly readerFactory: EditorSaveReaderFactory;
  private readonly configuredRoot: string;
  private readonly diagnosticsLog: SourceDiagnosticLog;

  private lifecycle: SourceLifecycle = "idle";
  private reader: EditorSaveReader | null = null;
  private emit: ActivityEventEmitter | null = null;
  private deliveryTail: Promise<void> = Promise.resolve();
  private sequence = 0;

  public constructor(options: EditorSaveActivitySourceOptions) {
    this.readerFactory = options.readerFactory;
    this.configuredRoot = options.root;
    this.id = options.sourceId ?? "editor-save-host";
    // `sequence` restarts at 0 for every instance, so the session must be the
    // part of the identity tuple that changes; see the other sources.
    this.sessionId = options.sessionId ?? `editor-save-${crypto.randomUUID()}`;
    this.diagnosticsLog = new SourceDiagnosticLog(options.onDiagnostic);
  }

  public get diagnostics(): readonly ActivitySourceDiagnostic[] {
    return this.diagnosticsLog.diagnostics;
  }

  public async start(emit: ActivityEventEmitter): Promise<void> {
    if (this.lifecycle !== "idle") {
      throw new Error(`Editor save source ${this.id} cannot start from lifecycle state ${this.lifecycle}.`);
    }
    if (!isAbsolute(this.configuredRoot)) {
      throw new Error(`Editor save source root must be an absolute path: ${this.configuredRoot}`);
    }

    this.emit = emit;
    this.lifecycle = "started";
    try {
      this.reader = this.readerFactory({
        onFrame: (frame) => this.handleFrame(frame),
        onError: (error) => this.record("watcher_error", error),
      });
    } catch (error) {
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
    await this.deliveryTail;
    this.emit = null;
  }

  private handleFrame(frame: EditorSaveFrame): void {
    if (this.lifecycle !== "started") return;
    // Serialized, so per-source sequence stays monotonic under a burst.
    this.deliveryTail = this.deliveryTail.then(() => this.deliver(frame));
  }

  private async deliver(frame: EditorSaveFrame): Promise<void> {
    const emit = this.emit;
    if (emit === null) return;

    let projected: ReturnType<typeof projectEditorSaveFrame>;
    let occurredAt: string | undefined;
    try {
      projected = projectEditorSaveFrame(frame, this.configuredRoot);
      occurredAt = frame.occurredAt;
    } catch (error) {
      // A backend pushing a non-object makes every field access throw. An
      // escaping throw would reject the shared delivery tail and kill every
      // later frame, and `stop()` with it.
      this.record("delivery_error", error);
      return;
    }
    if (projected === null) return;

    const event = createActivityEvent<FilePayload>({
      kind: "file_saved",
      payload: projected.payload,
      source: { kind: "ide", instanceId: this.id },
      sessionId: this.sessionId,
      sequence: this.sequence,
      ...(occurredAt === undefined ? {} : { occurredAt }),
    }) as ActivityEvent;

    try {
      await emit(event);
    } catch (error) {
      this.record("delivery_error", error);
      return;
    }
    this.sequence += 1;
  }

  private record(kind: ActivitySourceDiagnostic["kind"], error: unknown): void {
    this.diagnosticsLog.record(kind, error);
  }
}
