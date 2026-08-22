import type { BrowserPageFrame, BrowserPageReaderFactory } from "./browser-page-source.js";

const DEFAULT_INTERVAL_MS = 500;

export interface SyntheticBrowserPageReaderOptions {
  /** Frames to replay, in order. */
  readonly frames: readonly BrowserPageFrame[];
  /** Delay between frames. Default 500ms. */
  readonly intervalMs?: number;
  /** Replay from the start after the last frame instead of going quiet. */
  readonly loop?: boolean;
}

/**
 * A `BrowserPageReaderFactory` that replays a scripted list of frames on a timer.
 *
 * Zero browser calls, so the whole `search_selection` path is demonstrable and
 * reproducible on a machine with no extension installed — the same posture as
 * the synthetic screen-text reader. It reads no state of its own.
 */
export function createSyntheticBrowserPageReader(
  options: SyntheticBrowserPageReaderOptions,
): BrowserPageReaderFactory {
  const frames = [...options.frames];
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const loop = options.loop ?? false;

  return ({ onFrame }) => {
    if (frames.length === 0) {
      // Nothing to replay: hand back a reader that is already quiet rather than
      // scheduling a timer that would only ever tick past the end of the script.
      return { close: () => undefined };
    }

    let index = 0;
    const timer = setInterval(() => {
      const frame = frames[index];
      if (frame === undefined) {
        // Exhausted and not looping. Stop the timer so the process can exit
        // instead of idling on a tick that will never produce a frame again.
        clearInterval(timer);
        return;
      }
      index = loop ? (index + 1) % frames.length : index + 1;
      onFrame(frame);
    }, intervalMs);

    return { close: () => clearInterval(timer) };
  };
}

/**
 * A scripted session whose owner matches the window `demoScreenTextFrames` ends
 * on, so the two demos together can satisfy `admitSearch`.
 *
 * The owner is not decoration. `admitSearch` requires the page owner, the
 * selection owner, and the current foreground to be the same window, and the
 * reducer discards a page whose owner is not the focused window. The screen demo
 * settles on application `742` / "Code" and only then produces a selection, so a
 * page owned by `742` is the one a later selection can be attributed to.
 *
 * Note what a scripted demo cannot guarantee. Two independent readers on
 * independent timers have no fixed interleaving, and the search rule needs the
 * selection to be observed *after* the page (`observationOrdinal`), because a
 * selection older than the current page was made against a document no longer
 * shown. Whether that ordering happens in a demo run is a race between two
 * timers; nothing here can force it.
 *
 * So this pair demonstrates that a page becomes observable and gets correctly
 * attributed to a window — not that a search will fire on any given run. The
 * end-to-end guarantee is pinned deterministically instead, by
 * `tests/browser-search-admission.test.ts`, which drives the real source through
 * a controllable reader in the order a live desktop produces.
 */
export const demoBrowserPageFrames: readonly BrowserPageFrame[] = [
  {
    url: "https://example.com/docs/getting-started",
    title: "Getting started",
    owner: { applicationId: "742", windowTitle: "screen-text-source.ts — squid" },
  },
  {
    url: "https://example.com/docs/getting-started#install",
    title: "Getting started",
    owner: { applicationId: "742", windowTitle: "screen-text-source.ts — squid" },
  },
  // Repeated deliberately: an unchanged page must emit nothing.
  {
    url: "https://example.com/docs/getting-started#install",
    title: "Getting started",
    owner: { applicationId: "742", windowTitle: "screen-text-source.ts — squid" },
  },
];
