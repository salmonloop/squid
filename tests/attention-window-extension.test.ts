import { describe, expect, it } from "bun:test";
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attentionWindowExtension } from "../src/attention-window-extension.js";

type AgentMessage = ContextEvent["messages"][number];

const WINDOW_MS = 15 * 60_000;
const NOW = Date.parse("2026-09-26T12:00:00.000Z");

function observation(content: string, timestamp: number): AgentMessage {
  return { role: "custom", customType: "observation", content, display: false, timestamp } as unknown as AgentMessage;
}
function sense(content: string): AgentMessage {
  // The sense extension injects the current snapshot as a custom message whose
  // customType is "sense", not "observation", and with timestamp 0.
  return { role: "custom", customType: "sense", content, display: false, timestamp: 0 } as unknown as AgentMessage;
}
function user(content: string): AgentMessage {
  return { role: "user", content } as unknown as AgentMessage;
}
function assistant(content: string): AgentMessage {
  return { role: "assistant", content } as unknown as AgentMessage;
}

/** Drives the extension's one `context` handler through an ExtensionAPI stub. */
function fireContext(windowMs: number, messages: AgentMessage[], now: number = NOW): AgentMessage[] {
  const ext = attentionWindowExtension(windowMs, () => now);
  // InlineExtension is a factory function or an object carrying one.
  const factory = typeof ext === "function" ? ext : ext.factory;
  let handler: ((event: ContextEvent) => { messages: AgentMessage[] } | void) | undefined;
  const pi = {
    on: (event: string, h: unknown) => {
      if (event === "context") handler = h as typeof handler;
    },
  } as unknown as ExtensionAPI;
  factory(pi);
  if (handler === undefined) throw new Error("no context handler registered");
  const result = handler({ type: "context", messages });
  return result?.messages ?? messages;
}

describe("attentionWindowExtension", () => {
  it("drops observations older than the window and keeps everything else", () => {
    const messages = [
      user("start"),
      observation("old file_saved", NOW - WINDOW_MS - 1_000),
      assistant("did something"),
      observation("recent file_saved", NOW - 1_000),
      sense("the world right now"),
      // An undated breadcrumb is kept: the filter never drops what it cannot date.
      observation("undated", 0),
    ];
    const out = fireContext(WINDOW_MS, messages);
    // Only the one stale observation left the view.
    expect(out).toEqual([
      messages[0]!,
      messages[2]!,
      messages[3]!,
      messages[4]!,
      messages[5]!,
    ]);
  });

  it("keeps a breadcrumb exactly at the cutoff (older-than, not at-or-older)", () => {
    const messages = [observation("at the boundary", NOW - WINDOW_MS)];
    // cutoff = NOW - WINDOW_MS; timestamp === cutoff is not < cutoff, so kept.
    expect(fireContext(WINDOW_MS, messages)).toEqual(messages);
  });

  it("leaves the array untouched when nothing is stale", () => {
    const messages = [user("a"), observation("recent", NOW - 5_000), sense("now")];
    // Identity preserved: a no-op hands the next handler exactly what it had.
    expect(fireContext(WINDOW_MS, messages)).toBe(messages);
  });

  it("never touches conversation turns or the snapshot, however old", () => {
    // A user/assistant/sense message far older than the window is kept: only
    // observation breadcrumbs are eligible for the cut.
    const messages = [
      user("ancient prompt"),
      assistant("ancient reply"),
      sense("current snapshot"),
    ];
    expect(fireContext(WINDOW_MS, messages, NOW + 10 * WINDOW_MS)).toBe(messages);
  });

  it("treats a non-positive window as no bound and keeps everything", () => {
    const messages = [observation("old", NOW - WINDOW_MS - 1), observation("older", 1)];
    expect(fireContext(0, messages)).toBe(messages);
    expect(fireContext(-1, messages)).toBe(messages);
  });
});
