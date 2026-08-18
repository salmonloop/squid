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

for (const event of events) {
  const result = await core.ingest(event);
  console.log(JSON.stringify({ event: event.kind, predictions: result.baselinePredictions }, null, 2));
}
