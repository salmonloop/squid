import { describe, expect, test } from "bun:test";
import { InMemoryEventStore } from "../src/event-store.js";
import { SquidCore } from "../src/squid-core.js";
import { sensePromptLines } from "../src/agent-senses.js";
import { activityReadings } from "../src/resident-agent.js";
import { evalScenarios } from "../eval/corpus.js";

/**
 * The corpus's deterministic consumer. The agent-facing judgment ("reading") is
 * deliberately absent from these assertions — a live model's judgment is neither
 * deterministic nor fast enough for CI. What IS asserted is that the corpus and
 * the pipeline agree: every scenario's events project through the real SquidCore
 * and render into a real sense prompt that contains exactly the evidence the
 * scenario claims, and none of what it claims is absent. When a sensor changes
 * its output, this test fails the gate instead of letting the corpus rot.
 */
// The projection is async (the core serializes ingests through a queue), so each
// scenario drives its own core to completion before asserting.
async function promptFor(events: readonly { kind: string }[]): Promise<string> {
  const core = new SquidCore(new InMemoryEventStore());
  let state = core.currentState;
  for (const event of events) {
    const result = await core.ingest(event as never);
    expect(result.disposition).toBe("accepted");
    state = result.state;
  }
  return sensePromptLines(state, undefined).join("\n");
}

describe("eval corpus integrity", () => {
  test("scenario ids are unique", () => {
    const ids = evalScenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every scenario has events and at least one evidence claim", () => {
    for (const scenario of evalScenarios) {
      expect(scenario.events.length).toBeGreaterThan(0);
      expect(scenario.evidence.length).toBeGreaterThan(0);
    }
  });

  test("readings are drawn from the agent's vocabulary, or are honestly null", () => {
    for (const scenario of evalScenarios) {
      if (scenario.reading === null) continue;
      expect(
        (activityReadings as readonly string[]).includes(scenario.reading),
        `scenario ${scenario.id} claims a reading outside the agent's vocabulary`,
      ).toBe(true);
    }
  });
});

describe("eval corpus projects into the sense prompt", () => {
  for (const scenario of evalScenarios) {
    test(`${scenario.id}: evidence visible in what the agent reads`, async () => {
      const prompt = await promptFor(scenario.events);
      for (const fragment of scenario.evidence) {
        expect(prompt, `scenario ${scenario.id} expects to see ${fragment}`).toContain(fragment);
      }
    });

    const absence = scenario.absence;
    if (absence !== undefined) {
      test(`${scenario.id}: claimed absence is genuinely absent`, async () => {
        const prompt = await promptFor(scenario.events);
        for (const fragment of absence) {
          expect(prompt, `scenario ${scenario.id} expects NOT to see ${fragment}`).not.toContain(fragment);
        }
      });
    }
  }
});
