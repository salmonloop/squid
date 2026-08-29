import { describe, expect, test } from "bun:test";
import { InMemoryEventStore } from "../src/event-store.js";
import { createActivityEvent, type ActivityEvent } from "../src/protocol.js";
import { agentCustomTools, queryRecentEventsTool } from "../src/agent-tools.js";

function event(
  kind: ActivityEvent["kind"],
  occurredAt: string,
  payload: Record<string, unknown> = {},
): ActivityEvent {
  return createActivityEvent({ kind, occurredAt, payload });
}

async function storeWith(...events: ActivityEvent[]): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore();
  for (const event of events) await store.append(event);
  return store;
}

// The tool surface Pi hands the model: execute(args) against a real store.
function call(
  tool: ReturnType<typeof queryRecentEventsTool>,
  args: Record<string, unknown>,
): Promise<{ text: string; count: number }> {
  return tool
    .execute("call-1", args as never, undefined, undefined, undefined as never)
    .then((result) => ({
      text: result.content[0]?.type === "text" ? result.content[0].text : "",
      count: result.details.count,
    }));
}

describe("queryRecentEventsTool", () => {
  const t1 = "2026-08-29T10:00:00.000Z";
  const t2 = "2026-08-29T10:01:00.000Z";
  const t3 = "2026-08-29T10:02:00.000Z";
  const events = [
    event("application_activated", t1, { applicationId: "editor", applicationName: "Editor" }),
    event("focus_changed", t2, {
      applicationId: "editor",
      windowTitle: "draft.md",
      role: "editor",
      label: "Document",
    }),
    event("text_context_changed", t3, {
      prefix: "a",
      suffix: "b",
      selection: "",
      language: "en",
    }),
  ];

  test("returns the most recent events in store order, capped by limit", async () => {
    const result = await call(queryRecentEventsTool(await storeWith(...events)), { limit: 2 });
    expect(result.count).toBe(2);
    const parsed = JSON.parse(result.text) as ActivityEvent[];
    expect(parsed.map((e) => e.kind)).toEqual(["focus_changed", "text_context_changed"]);
  });

  test("defaults to the last 20 events when no limit is given", async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      event("focus_changed", new Date(Date.parse(t1) + i * 1000).toISOString(), {
        applicationId: "editor",
        windowTitle: `draft-${i}.md`,
        role: "editor",
        label: "Document",
      }),
    );
    const result = await call(queryRecentEventsTool(await storeWith(...many)), {});
    expect(result.count).toBe(20);
  });

  test("filters by kind without losing the most-recent cap", async () => {
    const mixed = [
      event("application_activated", t1, { applicationId: "editor", applicationName: "Editor" }),
      event("focus_changed", t2, {
        applicationId: "editor",
        windowTitle: "draft.md",
        role: "editor",
        label: "Document",
      }),
      event("application_activated", t3, { applicationId: "terminal", applicationName: "Terminal" }),
    ];
    const result = await call(queryRecentEventsTool(await storeWith(...mixed)), {
      kind: "application_activated",
      limit: 1,
    });
    const parsed = JSON.parse(result.text) as ActivityEvent[];
    expect(result.count).toBe(1);
    expect(parsed[0]?.occurredAt).toBe(t3);
  });

  test("honours since as an inclusive lower bound", async () => {
    const result = await call(queryRecentEventsTool(await storeWith(...events)), {
      since: t2,
    });
    const parsed = JSON.parse(result.text) as ActivityEvent[];
    expect(parsed.map((e) => e.occurredAt)).toEqual([t2, t3]);
  });

  test("an empty store answers with zero events, not an error", async () => {
    const result = await call(queryRecentEventsTool(new InMemoryEventStore()), {});
    expect(result.count).toBe(0);
    expect(JSON.parse(result.text)).toEqual([]);
  });

  test("a kind that matches nothing answers with zero events", async () => {
    const result = await call(queryRecentEventsTool(await storeWith(...events)), {
      kind: "browser_page_changed",
    });
    expect(result.count).toBe(0);
  });
});

describe("agentCustomTools", () => {
  test("exposes the sensory-history surface under stable names", () => {
    const tools = agentCustomTools(new InMemoryEventStore());
    expect(tools.map((t) => t.name)).toEqual(["query_recent_events"]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.label.length).toBeGreaterThan(0);
    }
  });
});
