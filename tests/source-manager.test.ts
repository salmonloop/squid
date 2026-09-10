import { describe, expect, it } from "bun:test";
import type {
  ActivityEventEmitter,
  ActivitySource,
  SourceEntry,
} from "../src/activity-source.js";
import type { ActivityEvent } from "../src/protocol.js";
import { SourceManager } from "../src/source-manager.js";

/**
 * Unit tests for the source manager in isolation — no session, no store, no
 * socket. The fakes here exist to make lifecycle *observable*: which instance a
 * recipe built, when start and stop ran, and what a stop's tail emissions did.
 * The wiring tests in `watch-session.test.ts` cover the same contract through a
 * real panel connection; this file covers the manager's own rules directly.
 */

/** A fake observer that records its own lifecycle and can emit on demand. */
class FakeSource implements ActivitySource {
  public started = false;
  public stopped = false;
  public emit: ActivityEventEmitter | undefined = undefined;
  /** Events buffered but not yet delivered, drained one per `stop` tick. */
  public readonly buffered: ActivityEvent[] = [];
  /** Resolved when `stop` has fully drained; tests await it for the drain contract. */
  public drained: Promise<void> = Promise.resolve();
  /** What `diagnostics` hands back; the snapshot's `detail` reads its last item. */
  public recordedDiagnostics: { readonly message: string }[] | undefined = undefined;
  private drainedNotify: (() => void) | undefined = undefined;

  public constructor(
    public readonly id: string,
    private readonly failOnStart: Error | undefined = undefined,
  ) {}

  /** The optional property the snapshot reads; undefined means "never records". */
  public get diagnostics(): { readonly message: string }[] | undefined {
    return this.recordedDiagnostics;
  }

  public async start(emit: ActivityEventEmitter): Promise<void> {
    if (this.failOnStart !== undefined) throw this.failOnStart;
    this.started = true;
    this.emit = emit;
  }

  public async stop(): Promise<void> {
    // Deliver buffered events one at a time, then resolve — the same
    // drain-then-quiet shape the real sources promise. Each await here is a
    // microtask boundary a tail event can slip through, which is exactly the
    // window the "tail events are not lost" test exercises.
    for (const event of this.buffered.splice(0)) {
      await this.emit?.(event);
    }
    this.stopped = true;
    this.drainedNotify?.();
  }

  /** Marks that one event is pending; `stop` resolves the promise after it lands. */
  public holdEvent(event: ActivityEvent): void {
    this.buffered.push(event);
    this.drained = new Promise<void>((resolve) => {
      this.drainedNotify = resolve;
    });
  }
}

/** A stub emitter: the manager tests care about delivery happening, not where. */
const emit: ActivityEventEmitter = async (_event: ActivityEvent) => undefined;

const buildCounters = (): Map<string, number> => new Map();

/** A recipe that counts builds and hands back the given fake. */
const recipe = (id: string, source: FakeSource, builds: Map<string, number>): SourceEntry => ({
  id,
  label: id,
  create: () => {
    builds.set(id, (builds.get(id) ?? 0) + 1);
    return source;
  },
});

describe("SourceManager", () => {
  it("refuses duplicate ids in the constructor", () => {
    // Two entries sharing a key would make the dump lie about one of them;
    // that is a declaration bug, so it fails loudly at construction.
    expect(
      () =>
        new SourceManager({
          entries: [
            { id: "alpha", label: "A", create: () => new FakeSource("alpha") },
            { id: "alpha", label: "A again", create: () => new FakeSource("alpha") },
          ],
          emit,
          log: () => undefined,
          logError: () => undefined,
        }),
    ).toThrow(`Duplicate source id in the catalog: "alpha".`);
  });

  it("reports unsupported for entries without a create, and running/stopped for the rest", () => {
    const manager = new SourceManager({
      entries: [
        { id: "alpha", label: "A" },
        { id: "beta", label: "B", create: () => new FakeSource("beta") },
      ],
      emit,
      log: () => undefined,
      logError: () => undefined,
    });
    // The dump shows the whole truth: the unconfigured capability exists but
    // this run cannot start it, so it reads `unsupported`, never `stopped`.
    expect(manager.snapshot()).toEqual([
      { id: "alpha", label: "A", state: "unsupported" },
      { id: "beta", label: "B", state: "stopped" },
    ]);
  });

  it("starts a fresh instance per toggle, never resurrecting a stopped one", async () => {
    const builds = buildCounters();
    const first = new FakeSource("alpha");
    let current = first;
    const manager = new SourceManager({
      entries: [
        // Second observer: the floor rule stays out of this resurrection test.
        { id: "beta", label: "B", create: () => new FakeSource("beta") },
        {
          id: "alpha",
          label: "A",
          create: () => {
            builds.set("alpha", (builds.get("alpha") ?? 0) + 1);
            return current;
          },
        },
      ],
      emit,
      log: () => undefined,
      logError: () => undefined,
    });

    await manager.startAll();
    expect(first.started).toBe(true);
    // Off then on: the stop removes the entry, and the second start builds a
    // NEW instance because `start` refuses a stopped one — resurrection is not
    // a thing a source can do.
    expect(await manager.stop("alpha")).toEqual({ ok: true, state: "stopped" });
    expect(first.stopped).toBe(true);
    const second = new FakeSource("alpha");
    current = second;
    expect(await manager.start("alpha")).toEqual({ ok: true, state: "running" });
    expect(builds.get("alpha")).toBe(2);
    expect(second.started).toBe(true);
  });

  /**
   * The snapshot's `detail` is how a source that runs but cannot observe
   * becomes visible to the panel. A screen reader without its accessibility
   * permission keeps polling and keeps being refused: the state says
   * `running` because it is, and the newest diagnostic is the one sentence
   * separating "watching" from "running but blind". Three properties matter:
   * it is the *newest* message (a description of now, not a history), it is
   * absent for stopped and unsupported entries (whose reasons the card
   * already carries), and a source that never records diagnostics reads as
   * absent rather than as an empty string — the wire omits what it lacks.
   */
  it("carries the newest diagnostic of a running source into the snapshot", async () => {
    const screen = new FakeSource("screen-text-host");
    screen.recordedDiagnostics = [
      { message: "first refusal" },
      { message: "xdotool exited 1: no DISPLAY" },
    ];
    const manager = new SourceManager({
      entries: [
        { id: "screen-text-host", label: "Screen", create: () => screen },
        { id: "ghost", label: "G" },
      ],
      emit,
      log: () => undefined,
      logError: () => undefined,
    });
    await manager.startAll();
    expect(manager.snapshot()).toEqual([
      // The last diagnostic, verbatim; a healthy sibling stays lean.
      { id: "screen-text-host", label: "Screen", state: "running", detail: "xdotool exited 1: no DISPLAY" },
      { id: "ghost", label: "G", state: "unsupported" },
    ]);
  });

  it("drops the detail when the source stops, and a fresh start begins clean", async () => {
    const first = new FakeSource("alpha");
    first.recordedDiagnostics = [{ message: "extension disconnected" }];
    const manager = new SourceManager({
      entries: [
        { id: "alpha", label: "A", create: () => first },
        { id: "beta", label: "B", create: () => new FakeSource("beta") },
      ],
      emit,
      log: () => undefined,
      logError: () => undefined,
    });
    await manager.startAll();
    expect(manager.snapshot().find((entry) => entry.id === "alpha")?.detail).toBe("extension disconnected");
    await manager.stop("alpha");
    // Stopped means stopped: an entry that observes nothing by choice carries
    // no explanation, or the card would narrate a failure the person ended.
    expect(manager.snapshot().find((entry) => entry.id === "alpha")).toEqual({
      id: "alpha",
      label: "A",
      state: "stopped",
    });
  });

  it("refuses to start an unknown id", async () => {
    const manager = new SourceManager({
      entries: [{ id: "alpha", label: "A", create: () => new FakeSource("alpha") }],
      emit,
      log: () => undefined,
      logError: () => undefined,
    });
    expect(await manager.start("nope")).toEqual({ ok: false, error: `Unknown source "nope".` });
    expect(await manager.stop("nope")).toEqual({ ok: false, error: `Unknown source "nope".` });
  });

  it("refuses toggles on an unsupported entry", async () => {
    const manager = new SourceManager({
      entries: [{ id: "alpha", label: "A" }],
      emit,
      log: () => undefined,
      logError: () => undefined,
    });
    expect(await manager.start("alpha")).toEqual({
      ok: false,
      error: `Source "alpha" is not available in this run.`,
    });
    expect(await manager.stop("alpha")).toEqual({
      ok: false,
      error: `Source "alpha" is not available in this run.`,
    });
  });

  it("refuses a second start while running and a stop while not running", async () => {
    const manager = new SourceManager({
      entries: [
        // Second observer: the floor rule stays out of these state refusals.
        { id: "beta", label: "B", create: () => new FakeSource("beta") },
        { id: "alpha", label: "A", create: () => new FakeSource("alpha") },
      ],
      emit,
      log: () => undefined,
      logError: () => undefined,
    });
    await manager.startAll();
    expect(await manager.start("alpha")).toEqual({
      ok: false,
      error: `Source "alpha" is already running.`,
    });
    await manager.stop("alpha");
    expect(await manager.stop("alpha")).toEqual({
      ok: false,
      error: `Source "alpha" is not running.`,
    });
  });

  it("refuses an instance that reports an id other than its catalog key", async () => {
    const manager = new SourceManager({
      entries: [{ id: "alpha", label: "A", create: () => new FakeSource("beta") }],
      emit,
      log: () => undefined,
      logError: () => undefined,
    });
    // A recipe reporting a different identity splits the catalog key from the
    // event metadata; the manager refuses rather than serve two truths.
    expect(await manager.start("alpha")).toEqual({
      ok: false,
      error: `Source "alpha" built an instance reporting itself as "beta".`,
    });
  });

  it("serializes a toggle storm per id: the queued start sees the stop's verdict", async () => {
    const manager = new SourceManager({
      entries: [
        // A second observer keeps the floor rule out of the way: this test is
        // about per-id serialization, not the last-observer refusal.
        { id: "beta", label: "B", create: () => new FakeSource("beta") },
        { id: "alpha", label: "A", create: () => new FakeSource("alpha") },
      ],
      emit,
      log: () => undefined,
      logError: () => undefined,
    });
    await manager.startAll();
    // Fire both without awaiting: the stop and the start race for the same id's
    // chain. Serialization means the second start queues behind the stop and
    // then runs on a fresh instance.
    const stopPromise = manager.stop("alpha");
    const startPromise = manager.start("alpha");
    expect(await stopPromise).toEqual({ ok: true, state: "stopped" });
    expect(await startPromise).toEqual({ ok: true, state: "running" });
    // The chain re-checked under the lock: at dequeue time the source was not
    // running, so it started again instead of refusing with "already running".
  });

  it("refuses to stop the last running observer, counting running not declared", async () => {
    const manager = new SourceManager({
      entries: [
        { id: "alpha", label: "A", create: () => new FakeSource("alpha") },
        { id: "beta", label: "B", create: () => new FakeSource("beta") },
        { id: "gamma", label: "C", create: () => new FakeSource("gamma") },
      ],
      emit,
      log: () => undefined,
      logError: () => undefined,
    });
    await manager.startAll();
    await manager.stop("alpha");
    await manager.stop("beta");
    // Three declared, two already stopped: the floor counts *running* sources,
    // so stopping gamma would take the session to zero observers and must
    // refuse — the exact state startup refuses with a zero-source catalog.
    expect(await manager.stop("gamma")).toEqual({
      ok: false,
      error: `Source "gamma" is the only observer; a watch session needs at least one.`,
    });
    // The refusal is not destructive: gamma is still running.
    expect(manager.snapshot().find((entry) => entry.id === "gamma")?.state).toBe("running");
  });

  it("keeps the source in the catalog until stop resolves, delivering tail events", async () => {
    const delivered: string[] = [];
    const source = new FakeSource("alpha");
    const manager = new SourceManager({
      entries: [
        // Second observer keeps the floor rule out of the way of the drain test.
        { id: "beta", label: "B", create: () => new FakeSource("beta") },
        { id: "alpha", label: "A", create: () => source },
      ],
      emit: async (event) => {
        delivered.push(event.kind);
      },
      log: () => undefined,
      logError: () => undefined,
    });
    await manager.startAll();
    source.holdEvent({ kind: "file_saved" } as unknown as ActivityEvent);
    const stopped = manager.stop("alpha");
    // The stop's promise lands only after the drain; awaiting both proves the
    // tail event was emitted BEFORE the caller learned the source stopped.
    await Promise.all([source.drained, stopped]);
    expect(delivered).toEqual(["file_saved"]);
    expect(source.stopped).toBe(true);
  });

  it("survives a stop that rejects: the source is still removed for a retry", async () => {
    const errors: string[] = [];
    const wedged = new FakeSource("alpha");
    // One of two running, so the floor allows the stop.
    const manager = new SourceManager({
      entries: [
        {
          id: "alpha",
          label: "A",
          create: () => ({
            id: "alpha",
            start: async () => undefined,
            // A stop contract break: rejects instead of resolving quietly.
            stop: async () => {
              throw new Error("wedged");
            },
          }),
        },
        { id: "beta", label: "B", create: () => new FakeSource("beta") },
      ],
      emit,
      log: () => undefined,
      logError: (line) => errors.push(line),
    });
    await manager.startAll();
    const result = await manager.stop("alpha");
    // The manager surfaces the failure in its error log but still removes the
    // entry: a wedged stop must not leave the panel unable to try again.
    expect(result).toEqual({ ok: true, state: "stopped" });
    expect(errors.some((line) => line.includes("wedged"))).toBe(true);
    expect(manager.snapshot().find((entry) => entry.id === "alpha")?.state).toBe("stopped");
  });

  it("starts all startable entries in declaration order, skipping unsupported", async () => {
    const lifecycle: string[] = [];
    const manager = new SourceManager({
      entries: [
        { id: "alpha", label: "A", create: () => new FakeSource("alpha") },
        { id: "ghost", label: "G" },
        { id: "beta", label: "B", create: () => new FakeSource("beta") },
      ],
      emit,
      log: (line) => lifecycle.push(line),
      logError: () => undefined,
    });
    await manager.startAll();
    // The manager cannot see the session's logger order across async starts in
    // general, but two sequential awaits resolve in declaration order here.
    expect(manager.snapshot()).toEqual([
      { id: "alpha", label: "A", state: "running" },
      { id: "ghost", label: "G", state: "unsupported" },
      { id: "beta", label: "B", state: "running" },
    ]);
    // One log line per start; the unsupported entry produces nothing.
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle[0]).toBe(JSON.stringify({ source: "alpha", started: true }));
  });

  it("reverse-stops what started when a later start fails", async () => {
    const lifecycle: string[] = [];
    const alpha = new FakeSource("alpha");
    const manager = new SourceManager({
      entries: [
        { id: "alpha", label: "A", create: () => alpha },
        {
          id: "beta",
          label: "B",
          create: () => new FakeSource("beta", new Error("no hardware")),
        },
      ],
      emit,
      log: () => lifecycle.push("log"),
      logError: () => undefined,
    });
    // startAll rethrows the failure so the session's existing failure path can
    // dispose the rest of the pipeline exactly as it did before the manager.
    await expect(manager.startAll()).rejects.toThrow(`Source "beta" failed to start: no hardware`);
    // The partial start is undone, in reverse: alpha was started and is now stopped.
    expect(alpha.started).toBe(true);
    expect(alpha.stopped).toBe(true);
    expect(manager.snapshot().every((entry) => entry.state !== "running")).toBe(true);
  });

  it("stops everything in reverse order on stopAll", async () => {
    const order: string[] = [];
    const alpha = new FakeSource("alpha");
    const beta = new FakeSource("beta");
    const originalBetaStop = beta.stop.bind(beta);
    beta.stop = async () => {
      order.push("stop:beta");
      await originalBetaStop();
    };
    const originalAlphaStop = alpha.stop.bind(alpha);
    alpha.stop = async () => {
      order.push("stop:alpha");
      await originalAlphaStop();
    };
    const manager = new SourceManager({
      entries: [
        { id: "alpha", label: "A", create: () => alpha },
        { id: "beta", label: "B", create: () => beta },
      ],
      emit,
      log: () => undefined,
      logError: () => undefined,
    });
    await manager.startAll();
    await manager.stopAll();
    // Teardown is reverse start order: a later source never emits into one
    // already torn down.
    expect(order).toEqual(["stop:beta", "stop:alpha"]);
  });
});
