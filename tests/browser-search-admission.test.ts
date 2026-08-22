import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  SEARCH_EGRESS_ALLOW_ID,
  SEARCH_EGRESS_DENY_ID,
  type EgressPolicy,
} from "../src/action-egress.js";
import { BrowserPageActivitySource, type BrowserPageFrame } from "../src/browser-page-source.js";
import { CapabilityDispatcher } from "../src/capability-gateway.js";
import { InMemoryEventStore } from "../src/event-store.js";
import { FakePredictionProvider, candidate } from "../src/fake-prediction-provider.js";
import { McpCapabilityGateway } from "../src/mcp-gateway.js";
import { PredictionCoordinator } from "../src/prediction-coordinator.js";
import { InMemoryPredictionLedger } from "../src/prediction-ledger.js";
import { PredictionRuntime } from "../src/prediction-runtime.js";
import { createActivityEvent, type ActivityEvent } from "../src/protocol.js";
import { SquidCore } from "../src/squid-core.js";
import { dispatchTopCandidate } from "../src/watch-actions.js";

/**
 * The acceptance test for issue #2: a search reaches an MCP call using a page
 * fact produced by the real `BrowserPageActivitySource`, not by a hand-written
 * `browser_navigated` payload.
 *
 * This distinction is the whole point. The existing dispatch tests build the page
 * event literally, which proves admission accepts a well-formed fact but not that
 * anything can produce one. Before this source existed, `admitSearch` refused
 * every real run with `browser_page_missing`.
 */

const SELECTION = "quantum tunneling";
const ALLOW: EgressPolicy = { id: SEARCH_EGRESS_ALLOW_ID, searchEgress: "allow" };
const DENY: EgressPolicy = { id: SEARCH_EGRESS_DENY_ID, searchEgress: "deny" };
const OWNER = { applicationId: "chrome", windowTitle: "Docs — Chrome" };

const nextRequestId = () => {
  let sequence = 0;
  return () => `search-${++sequence}`;
};

async function connectSearchServer(queries: string[]): Promise<Client> {
  const server = new McpServer({ name: "search-server", version: "0.0.1" });
  server.registerTool(
    "search_web",
    { inputSchema: { query: z.string().min(1) } },
    async ({ query }) => {
      queries.push(query);
      return { content: [{ type: "text", text: "results" }] };
    },
  );
  const client = new Client({ name: "squid-test", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

/** The foreground facts a screen source produces, before the page is observed. */
function foreground(): readonly ActivityEvent[] {
  return [
    createActivityEvent({
      kind: "application_activated",
      eventId: "fg-app",
      payload: { applicationId: OWNER.applicationId, applicationName: "Chrome" },
    }),
    createActivityEvent({
      kind: "window_changed",
      eventId: "fg-window",
      payload: { applicationId: OWNER.applicationId, title: OWNER.windowTitle, bounds: null },
    }),
  ];
}

/**
 * The selection facts a screen source produces, after the page is observed.
 *
 * `focus_changed` is not optional decoration. The reducer attributes text context
 * to whoever holds focus, so without it `textContext.owner` is null and the
 * three-way owner check in `admitSearch` cannot pass — the selection would belong
 * to no window at all.
 */
function selectionEvents(selection: string): readonly ActivityEvent[] {
  return [
    createActivityEvent({
      kind: "focus_changed",
      eventId: "fg-focus",
      payload: {
        applicationId: OWNER.applicationId,
        windowTitle: OWNER.windowTitle,
        role: "text_input",
        label: null,
      },
    }),
    createActivityEvent({
      kind: "text_context_changed",
      eventId: "fg-text",
      payload: { prefix: "", suffix: "", selection, language: null },
    }),
  ];
}

interface Harness {
  readonly runtime: PredictionRuntime;
  readonly dispatcher: CapabilityDispatcher;
  readonly queries: string[];
  readonly ledger: InMemoryPredictionLedger;
  dispose(): Promise<void>;
}

async function harness(egressPolicy: EgressPolicy): Promise<Harness> {
  const queries: string[] = [];
  const client = await connectSearchServer(queries);
  const ledger = new InMemoryPredictionLedger();
  const runtime = new PredictionRuntime(
    new SquidCore(new InMemoryEventStore()),
    new PredictionCoordinator({
      provider: new FakePredictionProvider({
        candidates: [candidate("search_selection", 0.9, { selection: SELECTION })],
      }),
      random: nextRequestId(),
    }),
    {
      ledger,
      runtimeSessionId: "browser-session",
      actionTrust: "trusted",
      egressPolicyId: egressPolicy.id,
    },
  );
  const dispatcher = new CapabilityDispatcher({
    runtime,
    gateway: new McpCapabilityGateway({ client }),
    ledger,
  });
  return {
    runtime,
    dispatcher,
    queries,
    ledger,
    dispose: async () => {
      await runtime.dispose();
      await client.close();
    },
  };
}

/**
 * Feeds a world through the real browser source plus the surrounding foreground
 * and selection facts, then dispatches whatever the last prediction produced.
 *
 * Ordering is load-bearing and mirrors what a live `watch:desktop` run does:
 * foreground first, then the page, then the selection. `admitSearch` requires the
 * selection to have been observed *after* the page, because a selection older
 * than the current page was made against a document no longer shown.
 */
async function runSearchFlow(options: {
  readonly harness: Harness;
  readonly pageFrames: readonly BrowserPageFrame[];
  readonly selection?: string;
  readonly egressPolicy: EgressPolicy;
}) {
  const { harness: h } = options;
  let last: Awaited<ReturnType<PredictionRuntime["ingest"]>> | undefined;

  for (const event of foreground()) {
    last = await h.runtime.ingest(event);
  }

  // The real source, driven by a controllable reader rather than a timer.
  let push: ((frame: BrowserPageFrame) => void) | undefined;
  const source = new BrowserPageActivitySource({
    readerFactory: (input) => {
      push = input.onFrame;
      return { close: () => undefined };
    },
    debounceMs: 0,
  });
  await source.start(async (event) => {
    last = await h.runtime.ingest(event);
  });
  for (const frame of options.pageFrames) {
    push!(frame);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await source.stop();

  for (const event of selectionEvents(options.selection ?? SELECTION)) {
    last = await h.runtime.ingest(event);
  }
  await h.runtime.awaitIdle();

  const outcome = last!.prediction === null ? null : await last!.prediction;
  if (outcome === null) return null;
  return dispatchTopCandidate(outcome, outcome.candidates, h.dispatcher, {
    egressPolicy: options.egressPolicy,
    triggerDisposition: last!.ingest.disposition,
  });
}

describe("search admission with a real browser source", () => {
  it("dispatches a search using a page the source produced", async () => {
    const h = await harness(ALLOW);
    try {
      const dispatched = await runSearchFlow({
        harness: h,
        pageFrames: [{ url: "https://example.com/docs", title: "Docs", owner: OWNER }],
        egressPolicy: ALLOW,
      });

      expect(dispatched?.status).toBe("dispatched");
      expect(dispatched?.action?.outcome).toBe("succeeded");
      // The MCP server received the actual selection: the whole chain ran.
      expect(h.queries).toEqual([SELECTION]);
    } finally {
      await h.dispose();
    }
  });

  it("keeps the selection and the URL out of the ledger", async () => {
    const h = await harness(ALLOW);
    try {
      await runSearchFlow({
        harness: h,
        pageFrames: [{ url: "https://example.com/secret-path", title: "Docs", owner: OWNER }],
        egressPolicy: ALLOW,
      });

      // Observing a page must not put browsing history or the query into the
      // decision log; only digests may cross that boundary.
      const serialized = JSON.stringify(await h.ledger.all());
      expect(serialized).not.toContain(SELECTION);
      expect(serialized).not.toContain("secret-path");
    } finally {
      await h.dispose();
    }
  });

  it("refuses when egress is denied even though the page is now observable", async () => {
    const h = await harness(DENY);
    try {
      const dispatched = await runSearchFlow({
        harness: h,
        pageFrames: [{ url: "https://example.com/docs", owner: OWNER }],
        egressPolicy: DENY,
      });

      // Observing a browser is not consent to send text off the machine. The two
      // decisions stay separate: this refusal is the reason `SQUID_BROWSER` and
      // `SQUID_SEARCH_EGRESS` are different variables.
      expect(dispatched?.status).toBe("not_admitted");
      expect(dispatched?.reasonCode).toBe("search_egress_denied");
      expect(h.queries).toEqual([]);
    } finally {
      await h.dispose();
    }
  });

  /**
   * A wrong or missing owner is refused two layers deep, and the second layer is
   * why the reason code is `browser_page_missing` rather than `owner_mismatch`.
   *
   * The reducer first drops an owner that does not match the foreground, leaving
   * `owner: null`. Then the following `focus_changed` discards the page outright,
   * because a page whose owner is not the newly focused window is no longer the
   * page the user is looking at. By the time admission runs there is no page left
   * to compare owners against — a stricter outcome than the owner check, reached
   * without admission having to know anything about it.
   */
  it("refuses when the page owner is not the foreground window", async () => {
    const h = await harness(ALLOW);
    try {
      const dispatched = await runSearchFlow({
        harness: h,
        pageFrames: [{
          url: "https://example.com/docs",
          owner: { applicationId: "firefox", windowTitle: "Other — Firefox" },
        }],
        egressPolicy: ALLOW,
      });

      expect(dispatched?.status).toBe("not_admitted");
      expect(dispatched?.reasonCode).toBe("browser_page_missing");
      expect(h.queries).toEqual([]);
    } finally {
      await h.dispose();
    }
  });

  it("refuses when the source could not attribute the page to a window", async () => {
    const h = await harness(ALLOW);
    try {
      const dispatched = await runSearchFlow({
        harness: h,
        pageFrames: [{ url: "https://example.com/docs" }],
        egressPolicy: ALLOW,
      });

      // A backend that cannot see which window owns a tab omits the owner rather
      // than guessing, and an unattributed page is discarded on the next focus
      // change exactly like a mismatched one. Refusing is the safe direction.
      expect(dispatched?.status).toBe("not_admitted");
      expect(dispatched?.reasonCode).toBe("browser_page_missing");
      expect(h.queries).toEqual([]);
    } finally {
      await h.dispose();
    }
  });

  it("refuses a page whose URL the source could not describe", async () => {
    const h = await harness(ALLOW);
    try {
      const dispatched = await runSearchFlow({
        harness: h,
        // `about:blank` yields no host, so the source emits nothing at all and
        // there is no page for admission to read.
        pageFrames: [{ url: "about:blank", owner: OWNER }],
        egressPolicy: ALLOW,
      });

      expect(dispatched?.status).toBe("not_admitted");
      expect(dispatched?.reasonCode).toBe("browser_page_missing");
      expect(h.queries).toEqual([]);
    } finally {
      await h.dispose();
    }
  });

  it("refuses when the selection changed after the prediction was made", async () => {
    const h = await harness(ALLOW);
    try {
      const dispatched = await runSearchFlow({
        harness: h,
        pageFrames: [{ url: "https://example.com/docs", owner: OWNER }],
        // The provider is scripted to predict on SELECTION; the world now holds
        // something else, so the plan describes text the user is not looking at.
        selection: "something else entirely",
        egressPolicy: ALLOW,
      });

      expect(dispatched?.status).toBe("not_admitted");
      expect(dispatched?.reasonCode).toBe("selection_changed");
      expect(h.queries).toEqual([]);
    } finally {
      await h.dispose();
    }
  });
});
