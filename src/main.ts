import { InMemoryEventStore } from "./event-store.js";
import { createActivityEvent } from "./protocol.js";
import { SquidCore } from "./squid-core.js";

const core = new SquidCore(new InMemoryEventStore());

const events = [
  createActivityEvent({
    kind: "application_activated",
    payload: { applicationId: "editor", applicationName: "Editor" },
  }),
  createActivityEvent({
    kind: "focus_changed",
    payload: {
      applicationId: "editor",
      windowTitle: "draft.md",
      role: "editor",
      label: "Document",
    },
  }),
  createActivityEvent({
    kind: "text_context_changed",
    payload: {
      prefix: "The next release should",
      suffix: ".",
      selection: "",
      language: "en",
    },
  }),
];

// What the core produces is a projection, not a suggestion. Predictions used to
// be printed here from a rule-based predictor the core owned; the resident agent
// reads the projection and decides for itself now, so what this demo shows is the
// world state a sequence of events builds up.
for (const event of events) {
  const result = await core.ingest(event);
  console.log(JSON.stringify({
    event: event.kind,
    disposition: result.disposition,
    state: result.state,
  }, null, 2));
}
