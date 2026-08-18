import { isAbsolute } from "node:path";
import { InMemoryEventStore } from "./event-store.js";
import { FilesystemActivitySource } from "./filesystem-source.js";
import type { FilePayload } from "./protocol.js";
import { SquidCore } from "./squid-core.js";

const root = process.argv[2];
if (root === undefined || !isAbsolute(root)) {
  console.error("Usage: bun run watch:files -- <absolute-project-root>");
  process.exit(2);
}

const core = new SquidCore(new InMemoryEventStore());
const source = new FilesystemActivitySource({
  root,
  onDiagnostic: (diagnostic) => {
    console.error(JSON.stringify({ diagnostic: diagnostic.kind, message: diagnostic.message }));
  },
});

await source.start(async (event) => {
  const result = await core.ingest(event);
  console.log(JSON.stringify({
    kind: event.kind,
    path: (event.payload as FilePayload).path,
    disposition: result.disposition,
    predictions: result.baselinePredictions.map((prediction) => prediction.kind),
  }));
});

console.error(JSON.stringify({ watching: root, source: source.id }));

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Drain buffered events before exiting so no observed write is lost.
    void source.stop().then(() => process.exit(0));
  });
}
