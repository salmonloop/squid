import { InMemoryEventStore } from "../src/event-store.js";
import { SquidCore } from "../src/squid-core.js";
import type { ActivityEvent } from "../src/protocol.js";
import {
  activityReadings,
  createResidentAgent,
  residentAgentSystemPrompt,
} from "../src/resident-agent.js";
import { evalScenarios } from "./corpus.js";

/**
 * The live consumer of the eval corpus's `reading` field.
 *
 * `tests/eval-corpus.test.ts` proves the corpus projects into a sense prompt
 * that contains each scenario's evidence; this entry closes the remaining gap
 * by asking a real resident agent what the user is doing and printing its
 * answer beside the scenario's expected reading. It is a hand-run harness, not
 * a gate: a live model's judgment is neither deterministic nor fast enough for
 * CI, so the verdicts here are aids for human comparison, not assertions.
 *
 * Each scenario gets a fresh session — an agent that remembered scenario one
 * would be graded on contamination, not on its reading of scenario two. Every
 * session runs with `noTools`: the corpus's scenarios contain no work to do,
 * only a state to read, and a live model left its file tools has demonstrated
 * it will spend minutes trying to investigate a scenario that asks for none.
 */

const QUESTION =
  "Based on the world state you were given, what is the user doing? " +
  `Reply with only the phrase: ${activityReadings.join("; ")} — ` +
  "or the sentence that the state supports none of them. No other words.";

type Verdict = "match" | "mismatch" | "absent" | "claimed";

function judge(expected: string | null, answer: string): Verdict {
  const lowered = answer.toLowerCase();
  if (expected !== null) return lowered.includes(expected) ? "match" : "mismatch";
  // A `null` reading should conclude nothing: the agent fails the scenario by
  // naming any activity the evidence cannot support.
  const named = activityReadings.some((reading) => lowered.includes(reading));
  return named ? "claimed" : "absent";
}

async function projectScenario(id: string, events: readonly ActivityEvent[]) {
  const core = new SquidCore(new InMemoryEventStore());
  let state = core.currentState;
  for (const event of events) {
    const result = await core.ingest(event);
    if (result.disposition !== "accepted") {
      throw new Error(`scenario ${id}: event ${event.kind} was ${result.disposition}, not accepted`);
    }
    state = result.state;
  }
  return state;
}

console.log(`eval:agent — ${evalScenarios.length} scenarios, one fresh resident agent each\n`);

let matched = 0;
for (const [index, scenario] of evalScenarios.entries()) {
  // Header first: a live turn can take minutes, and a silent run is
  // indistinguishable from a hung one.
  console.log(`[${index + 1}/${evalScenarios.length}] ${scenario.id}`);
  const state = await projectScenario(scenario.id, scenario.events);
  const agent = await createResidentAgent({
    systemPrompt: residentAgentSystemPrompt(),
    cwd: process.cwd(),
    noTools: true,
    history: "memory",
  });
  let answer: string;
  try {
    await agent.observe(state);
    await agent.prompt(QUESTION);
    await agent.waitForIdle();
    answer = agent.getLastAssistantText() ?? "(no reply)";
  } finally {
    agent.dispose();
  }

  const expected = scenario.reading;
  const verdict = judge(expected, answer);
  if (verdict === "match" || verdict === "absent") matched += 1;

  const label = expected ?? "(nothing supported)";
  console.log(`  expected: ${label}`);
  console.log(`  answer:   ${answer.trim().replace(/\n+/g, " | ")}`);
  console.log(`  verdict:  ${verdict}\n`);
}

console.log(
  `${matched}/${evalScenarios.length} agreed with the corpus ` +
    "(substring heuristic — human judgment governs; verdicts are aids, not assertions)",
);
