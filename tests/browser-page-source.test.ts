import { describe, expect, it } from "bun:test";
import { InMemoryEventStore } from "../src/event-store.js";
import { SquidCore } from "../src/squid-core.js";
import {
  BrowserPageActivitySource,
  projectBrowserFrame,
  type BrowserPageFrame,
  type BrowserPageReaderFactory,
} from "../src/browser-page-source.js";
import { createSyntheticBrowserPageReader } from "../src/browser-page-reader-synthetic.js";
import type { ActivityEvent, BrowserNavigatedPayload } from "../src/protocol.js";

const OWNER = { applicationId: "chrome", windowTitle: "Docs — Chrome" };

/** Pushes frames on demand so tests never wait on a real timer. */
function controllableReader(): {
  readonly factory: BrowserPageReaderFactory;
  push(frame: BrowserPageFrame): void;
  fail(error: Error): void;
  readonly closed: () => boolean;
} {
  let onFrame: ((frame: BrowserPageFrame) => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  let closed = false;
  return {
    factory: (input) => {
      onFrame = input.onFrame;
      onError = input.onError;
      return { close: () => { closed = true; } };
    },
    push: (frame) => onFrame?.(frame),
    fail: (error) => onError?.(error),
    closed: () => closed,
  };
}

async function collect(options: { readonly debounceMs?: number } = {}) {
  const reader = controllableReader();
  const events: ActivityEvent[] = [];
  const source = new BrowserPageActivitySource({
    readerFactory: reader.factory,
    debounceMs: options.debounceMs ?? 0,
  });
  await source.start(async (event) => {
    events.push(event);
  });
  return { reader, events, source };
}

/** Lets the debounce timer and the delivery tail settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("projectBrowserFrame", () => {
  it("derives the host and keeps the full URL", () => {
    const payload = projectBrowserFrame({
      url: "https://example.com/docs?q=1#frag",
      title: "Docs",
      owner: OWNER,
    });
    expect(payload).toEqual({
      url: "https://example.com/docs?q=1#frag",
      title: "Docs",
      host: "example.com",
      owner: OWNER,
    });
  });

  it("keeps a non-default port in the host, which distinguishes two origins", () => {
    expect(projectBrowserFrame({ url: "https://example.com:8443/x" })?.host)
      .toBe("example.com:8443");
  });

  it("reports an absent title as empty and an absent owner as null", () => {
    // Absence is not the same as emptiness for the *backend* — a reader that
    // cannot see titles omits the field — but the protocol requires a string, so
    // the projection is where that collapses. The owner stays null, which is what
    // makes admission refuse rather than trust an unobserved window.
    const payload = projectBrowserFrame({ url: "https://example.com/" });
    expect(payload?.title).toBe("");
    expect(payload?.owner).toBeNull();
  });

  /**
   * `host` is required non-empty by the protocol, so a URL with no origin cannot
   * be described honestly. Refusing is correct rather than unfortunate: a page
   * with no origin is not something a text selection can be attributed to, and
   * inventing a host would put a guess into an append-only store.
   */
  it("refuses URLs that cannot yield a host", () => {
    for (const url of [
      "not a url",
      "",
      "data:text/html,<p>hi</p>",
      "about:blank",
      "javascript:void(0)",
    ]) {
      expect(projectBrowserFrame({ url })).toBeNull();
    }
  });

  it("refuses a frame whose url is missing or not a string", () => {
    expect(projectBrowserFrame({} as BrowserPageFrame)).toBeNull();
    expect(projectBrowserFrame({ url: 7 } as unknown as BrowserPageFrame)).toBeNull();
  });

  it("copies the owner rather than aliasing the frame's object", () => {
    const owner = { applicationId: "chrome", windowTitle: "Docs — Chrome" };
    const payload = projectBrowserFrame({ url: "https://example.com/", owner });
    owner.windowTitle = "mutated";
    expect(payload?.owner?.windowTitle).toBe("Docs — Chrome");
  });
});

describe("BrowserPageActivitySource", () => {
  it("emits browser_navigated for a page it can describe", async () => {
    const { reader, events, source } = await collect();
    reader.push({ url: "https://example.com/docs", title: "Docs", owner: OWNER });
    await settle();

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("browser_navigated");
    const payload = events[0]!.payload as BrowserNavigatedPayload;
    expect(payload.host).toBe("example.com");
    expect(payload.owner).toEqual(OWNER);
    await source.stop();
  });

  it("emits nothing for an unchanged page", async () => {
    const { reader, events, source } = await collect();
    const frame = { url: "https://example.com/docs", title: "Docs", owner: OWNER };
    reader.push(frame);
    await settle();
    reader.push({ ...frame });
    await settle();

    // A backend polling a quiet tab must not burn a sequence number per tick.
    expect(events).toHaveLength(1);
    await source.stop();
  });

  it("emits again when the fragment changes, since that is a different page", async () => {
    const { reader, events, source } = await collect();
    reader.push({ url: "https://example.com/docs", owner: OWNER });
    await settle();
    reader.push({ url: "https://example.com/docs#install", owner: OWNER });
    await settle();

    expect(events).toHaveLength(2);
    await source.stop();
  });

  it("emits again when only the owner changes", async () => {
    const { reader, events, source } = await collect();
    reader.push({ url: "https://example.com/docs", owner: OWNER });
    await settle();
    reader.push({
      url: "https://example.com/docs",
      owner: { applicationId: "firefox", windowTitle: "Docs — Firefox" },
    });
    await settle();

    // The same URL in a different window is a different fact: admission compares
    // the page owner against the foreground, so this change is load-bearing.
    expect(events).toHaveLength(2);
    await source.stop();
  });

  it("assigns monotonic sequence numbers only to emitted events", async () => {
    const { reader, events, source } = await collect();
    reader.push({ url: "https://example.com/a", owner: OWNER });
    await settle();
    reader.push({ url: "not a url" });
    await settle();
    reader.push({ url: "https://example.com/b", owner: OWNER });
    await settle();

    expect(events.map((event) => event.sequence)).toEqual([0, 1]);
    await source.stop();
  });

  it("collapses a burst to the last frame", async () => {
    const { reader, events, source } = await collect({ debounceMs: 20 });
    reader.push({ url: "https://example.com/a", owner: OWNER });
    reader.push({ url: "https://example.com/b", owner: OWNER });
    reader.push({ url: "https://example.com/c", owner: OWNER });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(events).toHaveLength(1);
    expect((events[0]!.payload as BrowserNavigatedPayload).url).toBe("https://example.com/c");
    await source.stop();
  });

  it("flushes the pending frame on stop rather than losing it", async () => {
    const { reader, events, source } = await collect({ debounceMs: 500 });
    reader.push({ url: "https://example.com/last", owner: OWNER });
    // Stop well inside the debounce window: the final page before shutdown is
    // real observation, so discarding it would lose the last known state.
    await source.stop();

    expect(events).toHaveLength(1);
    expect((events[0]!.payload as BrowserNavigatedPayload).url).toBe("https://example.com/last");
  });

  it("records a reader failure as a diagnostic instead of throwing", async () => {
    const { reader, source } = await collect();
    reader.fail(new Error("extension disconnected"));
    await settle();

    expect(source.diagnostics.map((d) => d.kind)).toEqual(["watcher_error"]);
    expect(source.diagnostics[0]!.message).toContain("extension disconnected");
    await source.stop();
  });

  it("retries a rejected event rather than deduping it away", async () => {
    const reader = controllableReader();
    let failNext = true;
    const delivered: ActivityEvent[] = [];
    const source = new BrowserPageActivitySource({
      readerFactory: reader.factory,
      debounceMs: 0,
    });
    await source.start(async (event) => {
      if (failNext) {
        failNext = false;
        throw new Error("store rejected");
      }
      delivered.push(event);
    });

    const frame = { url: "https://example.com/docs", owner: OWNER };
    reader.push(frame);
    await settle();
    expect(delivered).toHaveLength(0);
    expect(source.diagnostics.map((d) => d.kind)).toEqual(["delivery_error"]);

    // The identical frame must be retried: a rejected event was never recorded
    // as emitted, so dedupe must not treat it as already delivered.
    reader.push({ ...frame });
    await settle();
    expect(delivered).toHaveLength(1);
    await source.stop();
  });

  it("survives a backend that pushes a non-object frame", async () => {
    const { reader, events, source } = await collect();
    reader.push(null as unknown as BrowserPageFrame);
    await settle();
    // The delivery tail must stay usable: an escaping throw would reject it and
    // silently kill every later frame, and stop() with it.
    reader.push({ url: "https://example.com/after", owner: OWNER });
    await settle();

    expect(events).toHaveLength(1);
    expect(source.diagnostics.some((d) => d.kind === "delivery_error")).toBe(true);
    await source.stop();
  });

  it("closes the reader on stop and is idempotent", async () => {
    const { reader, source } = await collect();
    await source.stop();
    await source.stop();
    expect(reader.closed()).toBe(true);
  });

  it("refuses to start twice and leaves a failed start restartable", async () => {
    const reader = controllableReader();
    const source = new BrowserPageActivitySource({ readerFactory: reader.factory });
    await source.start(async () => {});
    await expect(source.start(async () => {})).rejects.toThrow("cannot start");
    await source.stop();

    // A backend that cannot initialize must leave the source where it began, or a
    // caller that fixes the cause and retries hits "cannot start" on a source
    // that has no reader.
    let attempt = 0;
    const flaky = new BrowserPageActivitySource({
      readerFactory: (input) => {
        attempt += 1;
        if (attempt === 1) throw new Error("no extension host");
        return reader.factory(input);
      },
    });
    await expect(flaky.start(async () => {})).rejects.toThrow("no extension host");
    await flaky.start(async () => {});
    await flaky.stop();
  });

  it("gives each instance a distinct session identity", () => {
    const first = new BrowserPageActivitySource({ readerFactory: controllableReader().factory });
    const second = new BrowserPageActivitySource({ readerFactory: controllableReader().factory });
    // `sequence` restarts at 0 per instance, so the session is what must differ —
    // otherwise a restart re-emits an identity the store already holds.
    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it("ingests end-to-end into a world state that admission can read", async () => {
    const core = new SquidCore(new InMemoryEventStore());
    const reader = controllableReader();
    const source = new BrowserPageActivitySource({
      readerFactory: reader.factory,
      debounceMs: 0,
    });
    await source.start(async (event) => {
      await core.ingest(event);
    });

    reader.push({ url: "https://example.com/docs", title: "Docs", owner: OWNER });
    await settle();
    await source.stop();

    const page = core.currentState.currentBrowserPage;
    expect(page?.host).toBe("example.com");
    // The reducer drops an owner that does not match the current foreground, and
    // nothing has set a foreground here — so the owner is correctly null and a
    // search would still refuse. That is the safe failure mode, not a bug.
    expect(page?.owner).toBeNull();
  });
});

describe("createSyntheticBrowserPageReader", () => {
  it("replays scripted frames and stops at the end", async () => {
    const frames: BrowserPageFrame[] = [
      { url: "https://example.com/a" },
      { url: "https://example.com/b" },
    ];
    const seen: BrowserPageFrame[] = [];
    const reader = createSyntheticBrowserPageReader({ frames, intervalMs: 1 })({
      onFrame: (frame) => seen.push(frame),
      onError: () => {},
    });
    try {
      // Waits for the frames rather than for a stretch of wall clock. A fixed
      // sleep encodes an assumption about timer granularity that is only true on
      // the developer's machine: Windows resolves a timer to roughly 15.6ms, so
      // "sleep 20ms and expect two 1ms ticks" is a coin flip there and this test
      // failed on the Windows runner while passing everywhere else. The deadline
      // below is a failure bound, not the thing being measured.
      const deadline = Date.now() + 5_000;
      while (seen.length < frames.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(seen.map((frame) => frame.url)).toEqual([
        "https://example.com/a",
        "https://example.com/b",
      ]);

      // And then it stops: the script is exhausted and not looping, so no
      // further frame may arrive however long the reader is left open. This is
      // the half the old fixed sleep could only assert by accident — it stopped
      // watching at 20ms.
      const settled = seen.length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(seen.length).toBe(settled);
    } finally {
      reader.close();
    }
  });

  it("stays quiet for an empty script instead of scheduling a dead timer", async () => {
    let called = false;
    const reader = createSyntheticBrowserPageReader({ frames: [], intervalMs: 1 })({
      onFrame: () => { called = true; },
      onError: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    reader.close();
    expect(called).toBe(false);
  });
});
