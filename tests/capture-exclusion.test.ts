import { describe, expect, it } from "bun:test";
import {
  ExcludingCapturePolicy,
  parseExclusionList,
  resolveCaptureExclusion,
} from "../src/capture-exclusion.js";
import { RedactingCapturePolicy, type CapturePolicy } from "../src/capture-policy.js";
import { InMemoryEventStore } from "../src/event-store.js";
import { createActivityEvent, type ActivityEvent } from "../src/protocol.js";
import { PredictionRuntime } from "../src/prediction-runtime.js";
import {
  ScreenTextActivitySource,
  type ScreenTextFrame,
} from "../src/screen-text-source.js";
import { SquidCore } from "../src/squid-core.js";

function activated(name: string): ActivityEvent {
  return createActivityEvent({
    kind: "application_activated",
    payload: { applicationId: "1", applicationName: name },
  });
}

function windowTitled(title: string): ActivityEvent {
  return createActivityEvent({
    kind: "window_changed",
    payload: { applicationId: "1", title, bounds: null },
  });
}

describe("parseExclusionList", () => {
  it("parses comma-separated names case-insensitively", () => {
    const rules = parseExclusionList("1Password, Banking");
    expect(typeof rules).toBe("object");
    const parsed = rules as Exclude<typeof rules, string>;
    expect(parsed).toHaveLength(2);
  });

  it("fails closed on an empty list and empty entries", () => {
    // A malformed list must refuse to start rather than silently capture what
    // the user meant to hide — capture is the one boundary that cannot undo.
    expect(typeof parseExclusionList("")).toBe("string");
    expect(typeof parseExclusionList("   ")).toBe("string");
    expect(typeof parseExclusionList("a,,b")).toBe("string");
    expect(typeof parseExclusionList("a,")).toBe("string");
  });
});

describe("ExcludingCapturePolicy", () => {
  function policy(names: string): ExcludingCapturePolicy {
    const rules = parseExclusionList(names) as Exclude<ReturnType<typeof parseExclusionList>, string>;
    return new ExcludingCapturePolicy(rules, new RedactingCapturePolicy());
  }

  it("drops a matched application's event outright", () => {
    // The user asked for the application to be absent from history. Not
    // redacted — absent: even the structural fact of the event would recreate
    // the record being hidden.
    const excluded = policy("1Password").capture(activated("1Password"));
    expect(excluded).toBeNull();
  });

  it("matches case-insensitively on a substring of the name", () => {
    const p = policy("banking");
    expect(p.capture(activated("MyBankingApp"))).toBeNull();
    expect(p.capture(activated("Editor"))).not.toBeNull();
  });

  it("continues excluding id-only events after the app activation", () => {
    const p = policy("vault");
    expect(p.capture(activated("Vault"))).toBeNull();
    expect(p.capture(windowTitled("secret window"))).toBeNull();
    expect(p.capture(createActivityEvent({
      kind: "focus_changed",
      payload: { applicationId: "1", windowTitle: "secret", role: "unknown", label: null },
    }))).toBeNull();
  });

  it("treats regex metacharacters in names literally", () => {
    // An application actually named "a.b" or "c++" must match itself, not
    // everything the pattern would span.
    const p = policy("c++");
    expect(p.capture(activated("c++"))).toBeNull();
    expect(p.capture(activated("caux"))).not.toBeNull();
  });

  it("keeps events that carry no application name", () => {
    // A filesystem save with a null owner belongs to no application; exclusion
    // has nothing to match and redaction still applies below.
    const save = createActivityEvent({
      kind: "file_saved",
      payload: { path: "src/a.ts", applicationId: null },
      source: { kind: "filesystem", instanceId: "watcher" },
    });
    expect(policy("editor").capture(save)).toEqual(new RedactingCapturePolicy().capture(save));
  });

  it("still redacts every event it keeps", () => {
    // Composition, not replacement: exclusion narrows, it never widens. A kept
    // event with a credential in its title comes back redacted by the inner
    // policy exactly as if exclusion were not configured.
    const p = policy("editor");
    const result = p.capture(windowTitled("password=hunter2"));
    expect(result).not.toBeNull();
    expect(result!.redacted).toBe(true);
    expect((result!.payload as { title: string }).title).toBe("[redacted]");
  });

  it("reports counts without naming the application", () => {
    // The diagnostic channel must not become a record of exactly what the user
    // asked to hide.
    let count = 0;
    const rules = parseExclusionList("secret") as Exclude<
      ReturnType<typeof parseExclusionList>,
      string
    >;
    new ExcludingCapturePolicy(rules, new RedactingCapturePolicy(), (n) => {
      count += n;
    }).capture(activated("SecretApp"));
    expect(count).toBe(1);
  });

  it("refuses to construct with no rules", () => {
    expect(() => new ExcludingCapturePolicy([], new RedactingCapturePolicy())).toThrow();
  });
});

describe("resolveCaptureExclusion", () => {
  it("returns plain redaction when unset", () => {
    const resolved = resolveCaptureExclusion(undefined);
    expect(resolved).toBeInstanceOf(RedactingCapturePolicy);
    expect((resolved as RedactingCapturePolicy).id).toBe("redacting");
  });

  it("fails closed on a malformed list instead of capturing everything", () => {
    for (const bad of ["", "a,,b"]) {
      const resolved = resolveCaptureExclusion(bad);
      expect("configError" in resolved).toBe(true);
    }
  });

  it("wraps redaction when configured", () => {
    const resolved = resolveCaptureExclusion("vault");
    expect(resolved).toBeInstanceOf(ExcludingCapturePolicy);
    expect((resolved as ExcludingCapturePolicy).id).toBe("excluding(redacting)");
  });
});

describe("exclusion through the live runtime", () => {
  async function runtimeWith(policy: CapturePolicy) {
    const store = new InMemoryEventStore();
    const runtime = new PredictionRuntime(new SquidCore(store), { capturePolicy: policy });
    return { runtime, store };
  }

  it("keeps an excluded event out of the store and reports nothing about it", async () => {
    // End to end through the real ingress boundary: the excluded application's
    // event never reaches history, and the result says only that nothing was
    // recorded — no stub, no marker, no reason naming the application.
    const rules = parseExclusionList("vault") as Exclude<
      ReturnType<typeof parseExclusionList>,
      string
    >;
    const policy = new ExcludingCapturePolicy(rules, new RedactingCapturePolicy());
    const { runtime, store } = await runtimeWith(policy);

    const refused = await runtime.ingest(
      createActivityEvent({
        kind: "application_activated",
        payload: { applicationId: "9", applicationName: "Vault" },
      }),
    );
    expect(refused.ingest).toBeNull();
    expect(await store.all()).toHaveLength(0);

    const kept = await runtime.ingest(
      createActivityEvent({
        kind: "application_activated",
        payload: { applicationId: "2", applicationName: "Code" },
      }),
    );
    expect(kept.ingest).not.toBeNull();
    expect(await store.all()).toHaveLength(1);
  });

  it("keeps everything an excluded foreground produces out of the store", async () => {
    // The leak this test exists for: one sample of a vault window becomes four
    // events, and only the first of them says the word "Vault". Judging them one
    // at a time dropped that one and stored the window title, the focused
    // control's label, and the selected text — the whole of what the user asked
    // to hide, minus the name of the application hiding it.
    const rules = parseExclusionList("vault") as Exclude<
      ReturnType<typeof parseExclusionList>,
      string
    >;
    const policy = new ExcludingCapturePolicy(rules, new RedactingCapturePolicy());
    const { runtime, store } = await runtimeWith(policy);

    const reader: { onFrame: ((frame: ScreenTextFrame) => void) | null } = { onFrame: null };
    const source = new ScreenTextActivitySource({
      readerFactory: (input) => {
        reader.onFrame = input.onFrame;
        return { close: () => undefined };
      },
      debounceMs: 1,
    });
    await source.start(async (event) => {
      await runtime.ingest(event);
    });

    reader.onFrame?.({
      applicationId: "77",
      applicationName: "Vault",
      windowTitle: "Personal — Vault",
      focusedRole: "text_input",
      focusedLabel: "Recovery phrase",
      textContext: { prefix: "", suffix: "", selection: "Our door code is 8342", language: null },
      occurredAt: "2026-09-05T10:00:00.000Z",
    });
    // The next application releases the latch, which is what proves exclusion is
    // scoped to the foreground rather than latched on for the rest of the run.
    reader.onFrame?.({
      applicationId: "78",
      applicationName: "Code",
      windowTitle: "capture-exclusion.ts",
      focusedRole: "editor",
      focusedLabel: null,
      textContext: { prefix: "", suffix: "", selection: "", language: null },
      occurredAt: "2026-09-05T10:00:01.000Z",
    });
    await source.stop();

    const stored = await store.all();
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain("8342");
    expect(serialized).not.toContain("Vault");
    expect(serialized).not.toContain("Recovery phrase");
    expect(stored.map((event) => event.kind)).toEqual([
      "application_activated",
      "window_changed",
      "focus_changed",
      "text_context_changed",
    ]);
  });
});
