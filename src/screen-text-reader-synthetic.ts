import type { ScreenTextFrame, ScreenTextReaderFactory } from "./screen-text-source.js";

const DEFAULT_INTERVAL_MS = 500;

export interface SyntheticScreenTextReaderOptions {
  /** Frames to replay, in order. */
  readonly frames: readonly ScreenTextFrame[];
  /** Delay between frames. Default 500ms. */
  readonly intervalMs?: number;
  /** Replay from the start after the last frame instead of going quiet. */
  readonly loop?: boolean;
}

/**
 * A `ScreenTextReaderFactory` that replays a scripted list of frames on a timer.
 *
 * Zero OS calls, so it behaves identically on every platform — this is what
 * `bun run watch:screen` uses by default, and what makes the whole screen-text
 * path demonstrable and reproducible on a machine with no accessibility API.
 * It reads no state of its own: a frame list in, frames out.
 */
export function createSyntheticScreenTextReader(
  options: SyntheticScreenTextReaderOptions,
): ScreenTextReaderFactory {
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
 * A short scripted session used when no frame file is supplied, written to
 * exercise every diff rule in `projectFrame`: a first sighting, a title-only
 * change, a role-and-label change, a selection appearing, and an unchanged
 * repeat that must emit nothing.
 */
export const demoScreenTextFrames: readonly ScreenTextFrame[] = [
  {
    applicationId: "501",
    applicationName: "Terminal",
    windowTitle: "bash — squid",
    focusedRole: "text_input",
    focusedLabel: null,
  },
  {
    applicationId: "501",
    applicationName: "Terminal",
    windowTitle: "bash — squid/src",
    focusedRole: "text_input",
    focusedLabel: null,
  },
  {
    applicationId: "742",
    applicationName: "Code",
    windowTitle: "screen-text-source.ts — squid",
    focusedRole: "editor",
    focusedLabel: "Editor",
  },
  {
    applicationId: "742",
    applicationName: "Code",
    windowTitle: "screen-text-source.ts — squid",
    focusedRole: "editor",
    focusedLabel: "Editor",
    textContext: { prefix: "", suffix: "", selection: "projectFrame", language: null },
  },
  {
    applicationId: "742",
    applicationName: "Code",
    windowTitle: "screen-text-source.ts — squid",
    focusedRole: "editor",
    focusedLabel: "Editor",
    textContext: { prefix: "", suffix: "", selection: "projectFrame", language: null },
  },
];
