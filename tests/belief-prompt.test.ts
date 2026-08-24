import { describe, expect, it } from "bun:test";
import {
  beliefSystemPrompt,
  BELIEF_PROMPT_VERSION,
} from "../src/belief-admission.js";
import { evidenceTimeline } from "../src/belief-evidence.js";
import { beliefValues } from "../src/belief-state.js";
import { RedactingContextPolicy } from "../src/context-policy.js";
import { InMemoryEventStore } from "../src/event-store.js";
import { SquidCore } from "../src/squid-core.js";
import { createActivityEvent, type ActivityEvent } from "../src/protocol.js";

/**
 * The parts of the model-backed producer that can be checked without a model.
 *
 * Same split as `tests/pi-runtime.test.ts`, which tests
 * `normalizePredictionCandidate` and never opens a session: the model call belongs to
 * `bun run gate:belief`, which costs minutes of endpoint time. What is checkable here is
 * what the model is *told*, and that is not cosmetic — a prompt that failed to name the
 * citable events would produce a batch refused on every request, which reads as a broken
 * producer rather than as a prompt that never stated the rules.
 */

const source = { kind: "synthetic" as const, instanceId: "pi-belief-test" };

function event<TPayload>(input: {
  eventId: string;
  sequence: number;
  occurredAt: string;
  kind: Parameters<typeof createActivityEvent<TPayload>>[0]["kind"];
  payload: TPayload;
}): ActivityEvent<TPayload> {
  return createActivityEvent({ ...input, source, sessionId: "pi-belief-session" });
}

/** A save in an editor with text under the cursor — a world with citable evidence. */
const editorSaveEvents: readonly ActivityEvent[] = [
  event({
    eventId: "code-app",
    sequence: 0,
    occurredAt: "2026-08-24T09:00:00.000Z",
    kind: "application_activated",
    payload: { applicationId: "com.editor.code", applicationName: "VS Code" },
  }),
  event({
    eventId: "code-text",
    sequence: 1,
    occurredAt: "2026-08-24T09:00:01.000Z",
    kind: "text_context_changed",
    payload: { prefix: "export function run(", suffix: ") {}", selection: "", language: "ts" },
  }),
  event({
    eventId: "code-save",
    sequence: 2,
    occurredAt: "2026-08-24T09:00:02.000Z",
    kind: "file_saved",
    payload: { path: "/repo/src/main.ts", applicationId: "com.editor.code" },
  }),
];

async function projected() {
  const core = new SquidCore(new InMemoryEventStore());
  let last = await core.ingest(editorSaveEvents[0]!);
  for (const next of editorSaveEvents.slice(1)) last = await core.ingest(next);
  // Projected through the policy the live cognition path applies, so the citable set is
  // the one a real run would produce.
  return new RedactingContextPolicy().project(last.state);
}

describe("beliefSystemPrompt", () => {
  it("names every event the model may cite", async () => {
    const timeline = evidenceTimeline(await projected());
    const prompt = beliefSystemPrompt(timeline);

    expect(timeline.size).toBeGreaterThan(0);
    for (const eventId of timeline.keys()) {
      expect(prompt).toContain(eventId);
    }
  });

  it("names the whole closed vocabulary", () => {
    // A value outside the vocabulary is refused by the reducer, so a prompt that omitted
    // one would make an intent unreachable rather than merely unlikely.
    const prompt = beliefSystemPrompt(new Map([["evt-1", "2026-08-24T09:00:00.000Z"]]));
    for (const value of beliefValues) {
      expect(prompt).toContain(value);
    }
  });

  it("tells the model to abstain when nothing is citable", () => {
    // An empty projection has no evidence, so every belief would be refused. Asking for
    // an empty array is the honest instruction; asking for beliefs anyway would produce
    // a batch guaranteed to be rejected.
    const prompt = beliefSystemPrompt(new Map());
    expect(prompt).toContain("empty array");
  });

  it("treats the world state as data rather than instructions", () => {
    // World state carries window titles and file paths the user controls. Without this
    // line, text on someone's screen becomes a prompt.
    const prompt = beliefSystemPrompt(new Map([["evt-1", "2026-08-24T09:00:00.000Z"]]));
    expect(prompt).toContain("data");
  });

  it("is a pure function of the citable set", () => {
    // The prompt is recorded in every batch as `promptVersion`, so two runs over one
    // projection must agree about what produced them.
    const timeline = new Map([["evt-1", "2026-08-24T09:00:00.000Z"]]);
    expect(beliefSystemPrompt(timeline)).toBe(beliefSystemPrompt(timeline));
  });
});

describe("BELIEF_PROMPT_VERSION", () => {
  it("is a non-empty identifier a batch can record", () => {
    // Recorded in every batch so a stored belief names the prompt that produced it —
    // the field exists on `BeliefStateBatch` for exactly this.
    expect(BELIEF_PROMPT_VERSION.length).toBeGreaterThan(0);
  });
});
