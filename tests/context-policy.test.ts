import { describe, expect, it } from "bun:test";
import {
  PassthroughContextPolicy,
  RedactingContextPolicy,
  type ContextPolicy,
} from "../src/context-policy.js";
import { PredictionCoordinator } from "../src/prediction-coordinator.js";
import type { PredictionRequest } from "../src/prediction-provider.js";
import type { PredictionCandidate, WorldState } from "../src/protocol.js";
import { buildWorldState } from "../src/world-state.js";

function sensitiveState(): WorldState {
  return {
    ...buildWorldState([]),
    updatedAt: "2026-08-19T10:00:00.000Z",
    lastEventKind: "file_saved",
    activeApplication: { id: "code", name: "Editor" },
    activeWindow: {
      applicationId: "code",
      title: "salary-2026.xlsx — Private",
      bounds: null,
    },
    focus: {
      applicationId: "code",
      windowTitle: "salary-2026.xlsx — Private",
      role: "editor",
      label: "Patient name field",
    },
    textContext: {
      owner: { applicationId: "code", windowTitle: "salary-2026.xlsx — Private" },
      prefix: "PREFIX",
      suffix: "SUFFIX",
      selection: "SELECTED",
      language: "typescript",
      sourceEventId: "text-1",
      observedAt: "2026-08-19T10:00:00.000Z",
      observationOrdinal: 2,
    },
    currentBrowserPage: {
      url: "https://mail.example.com/inbox?token=secret-session-abc#msg-1",
      title: "Re: acquisition terms",
      host: "mail.example.com",
      owner: { applicationId: "code", windowTitle: "salary-2026.xlsx — Private" },
      sourceEventId: "browser-1",
      observedAt: "2026-08-19T09:59:59.000Z",
      observationOrdinal: 1,
    },
    recentFiles: ["/home/alice/private/taxes/return.pdf", "src/main.ts"],
    recentActions: [
      {
        kind: "file_saved",
        occurredAt: "2026-08-19T10:00:00.000Z",
        sourceEventId: "e-1",
        applicationId: "code",
        target: "/home/alice/private/taxes/return.pdf",
        outcome: "succeeded",
      },
    ],
  };
}

describe("PassthroughContextPolicy", () => {
  it("preserves state and does not alias the original", () => {
    const state = sensitiveState();
    const policy = new PassthroughContextPolicy();

    const projected = policy.project(state);

    expect(projected).toEqual(state);
    projected.recentFiles.push("mutated");
    expect(state.recentFiles).toHaveLength(2);
  });
});

describe("RedactingContextPolicy", () => {
  it("redacts window titles while keeping the focused application", () => {
    const projected = new RedactingContextPolicy().project(sensitiveState());

    expect(projected.activeWindow!.title).toBe("[redacted]");
    expect(projected.focus!.windowTitle).toBe("[redacted]");
    expect(projected.activeWindow!.applicationId).toBe("code");
    expect(projected.activeApplication).toEqual({ id: "code", name: "Editor" });
  });

  it("strips URL query strings and fragments but keeps origin and path", () => {
    const projected = new RedactingContextPolicy().project(sensitiveState());

    const url = projected.currentBrowserPage!.url;
    expect(url).toBe("https://mail.example.com/inbox");
    expect(url).not.toContain("secret-session-abc");
    expect(projected.currentBrowserPage!.title).toBe("[redacted]");
    expect(projected.currentBrowserPage!.host).toBe("mail.example.com");
  });

  it("falls back to the host when a URL cannot be parsed", () => {
    const state = sensitiveState();
    state.currentBrowserPage!.url = "not a url?token=leak";

    const projected = new RedactingContextPolicy().project(state);

    expect(projected.currentBrowserPage!.url).toBe("mail.example.com");
    expect(projected.currentBrowserPage!.url).not.toContain("leak");
  });

  it("strips userinfo credentials from a URL", () => {
    const state = sensitiveState();
    state.currentBrowserPage!.url = "https://alice:hunter2@mail.example.com/inbox";

    const projected = new RedactingContextPolicy().project(state);

    expect(projected.currentBrowserPage!.url).toBe("https://mail.example.com/inbox");
    expect(projected.currentBrowserPage!.url).not.toContain("hunter2");
  });

  it.each([
    ["blob:https://mail.example.com/opaque-capability-token", "opaque-capability-token"],
    ["data:text/plain;base64,c2VjcmV0LXBheWxvYWQ=", "c2VjcmV0LXBheWxvYWQ"],
    ["file:///home/alice/private/taxes/return.pdf", "taxes"],
    ["javascript:steal(document.cookie)", "cookie"],
  ])("degrades %s to the host rather than leaking its payload", (url, secret) => {
    // These schemes parse, so a scheme-blind implementation would keep their
    // "path" — which is where their entire payload lives.
    const state = sensitiveState();
    state.currentBrowserPage!.url = url;

    const projected = new RedactingContextPolicy().project(state);

    expect(projected.currentBrowserPage!.url).toBe("mail.example.com");
    expect(projected.currentBrowserPage!.url).not.toContain(secret);
  });

  it("recognizes an uppercase scheme as a web URL and still strips its query", () => {
    // The scheme gate compares against lowercase literals and relies on URL
    // normalizing case. If that ever stopped holding, this would degrade to
    // host — which is safe, but would silently lose the page path.
    const state = sensitiveState();
    state.currentBrowserPage!.url = "HTTPS://mail.example.com/inbox?token=leak";

    const projected = new RedactingContextPolicy().project(state);

    expect(projected.currentBrowserPage!.url).toBe("https://mail.example.com/inbox");
  });

  it("keeps a non-default port, which identifies the page and is not a secret", () => {
    const state = sensitiveState();
    state.currentBrowserPage!.url = "http://localhost:8080/app/dashboard?token=leak";

    const projected = new RedactingContextPolicy().project(state);

    expect(projected.currentBrowserPage!.url).toBe("http://localhost:8080/app/dashboard");
  });

  it("reduces file paths to basenames, keeping the filename signal", () => {
    const projected = new RedactingContextPolicy().project(sensitiveState());

    expect(projected.recentFiles).toEqual(["return.pdf", "main.ts"]);
    expect(projected.recentActions[0].target).toBe("return.pdf");
  });

  it("redacts focus labels and caps text around the cursor", () => {
    const state = sensitiveState();
    state.textContext!.prefix = "a".repeat(20) + "NEAR_CURSOR";
    state.textContext!.suffix = "AFTER_CURSOR" + "b".repeat(20);
    state.textContext!.selection = "c".repeat(40);

    const projected = new RedactingContextPolicy({ maxTextLength: 12 }).project(state);

    // Prefix keeps its tail and suffix keeps its head: both sit at the caret.
    expect(projected.textContext!.prefix).toBe("aNEAR_CURSOR");
    expect(projected.textContext!.prefix).toHaveLength(12);
    expect(projected.textContext!.suffix).toBe("AFTER_CURSOR");
    expect(projected.textContext!.selection).toHaveLength(12);
    expect(projected.focus!.label).toBe("[redacted]");
    expect(projected.textContext!.language).toBe("typescript");
    expect(projected.focus!.role).toBe("editor");
  });

  it("leaves text shorter than the cap untouched", () => {
    const projected = new RedactingContextPolicy().project(sensitiveState());

    expect(projected.textContext!.prefix).toBe("PREFIX");
    expect(projected.textContext!.suffix).toBe("SUFFIX");
    expect(projected.textContext!.selection).toBe("SELECTED");
  });

  it("keeps episode and event shape, which carry no user content", () => {
    const state = sensitiveState();
    state.episode = { id: "ep-1", startedAt: "2026-08-19T10:00:00.000Z", eventCount: 3 };

    const projected = new RedactingContextPolicy().project(state);

    expect(projected.episode).toEqual(state.episode);
    expect(projected.lastEventKind).toBe("file_saved");
    expect(projected.updatedAt).toBe("2026-08-19T10:00:00.000Z");
  });

  it("passes through only the allow-listed fields", () => {
    const state = sensitiveState();
    const projected = new RedactingContextPolicy({
      allow: ["filePaths", "browserUrl"],
    }).project(state);

    expect(projected.recentFiles).toEqual(state.recentFiles);
    expect(projected.currentBrowserPage!.url).toBe(state.currentBrowserPage!.url);
    expect(projected.currentBrowserPage!.title).toBe(state.currentBrowserPage!.title);
    // Not allow-listed, so still redacted.
    expect(projected.activeWindow!.title).toBe("[redacted]");
    expect(projected.focus!.label).toBe("[redacted]");
  });

  it.each([
    ["windowTitle" as const, (s: WorldState) => s.activeWindow!.title],
    ["focusText" as const, (s: WorldState) => `${s.focus!.label}:${s.textContext!.selection}`],
    ["actionTargets" as const, (s: WorldState) => s.recentActions[0].target],
    ["filePaths" as const, (s: WorldState) => s.recentFiles[0]],
  ])("passes %s through when it alone is allow-listed", (field, read) => {
    const state = sensitiveState();

    const allowed = new RedactingContextPolicy({ allow: [field] }).project(state);
    const denied = new RedactingContextPolicy().project(state);

    expect(read(allowed)).toBe(read(state));
    expect(read(denied)).not.toBe(read(state));
  });

  it("does not mutate the state it is given", () => {
    const state = sensitiveState();
    state.episode = { id: "ep-1", startedAt: "2026-08-19T10:00:00.000Z", eventCount: 3 };
    state.activeWindow!.bounds = { x: 0, y: 0, width: 800, height: 600 };
    const before = structuredClone(state);

    new RedactingContextPolicy().project(state);

    expect(state).toEqual(before);
  });

  it("returns a projection that shares no nested object with its input", () => {
    // A shallow clone anywhere in the chain would let a provider-side mutation
    // reach live state; toEqual alone would not catch it.
    const state = sensitiveState();
    const projected = new RedactingContextPolicy().project(state);

    expect(projected.activeWindow).not.toBe(state.activeWindow);
    expect(projected.focus).not.toBe(state.focus);
    expect(projected.textContext).not.toBe(state.textContext);
    expect(projected.textContext!.owner).not.toBe(state.textContext!.owner);
    expect(projected.currentBrowserPage).not.toBe(state.currentBrowserPage);
    expect(projected.currentBrowserPage!.owner).not.toBe(state.currentBrowserPage!.owner);
    expect(projected.recentFiles).not.toBe(state.recentFiles);
    expect(projected.recentActions).not.toBe(state.recentActions);
    expect(projected.recentActions[0]).not.toBe(state.recentActions[0]);
    expect(projected.activeApplication).not.toBe(state.activeApplication);
  });
});

describe("PredictionCoordinator context policy", () => {
  function capturingProvider() {
    const seen: PredictionRequest[] = [];
    return {
      seen,
      provider: {
        name: "capturing",
        predict: async (request: PredictionRequest): Promise<readonly PredictionCandidate[]> => {
          seen.push(structuredClone(request) as PredictionRequest);
          return [];
        },
      },
    };
  }

  it("hands the provider the projected state, not raw state", async () => {
    const { seen, provider } = capturingProvider();
    const coordinator = new PredictionCoordinator({
      provider,
      contextPolicy: new RedactingContextPolicy(),
      random: () => "req-1",
    });

    await coordinator.request(sensitiveState());

    expect(seen).toHaveLength(1);
    const state = seen[0].worldState;
    expect(state.activeWindow!.title).toBe("[redacted]");
    expect(state.currentBrowserPage!.url).toBe("https://mail.example.com/inbox");
    expect(state.recentFiles).toEqual(["return.pdf", "main.ts"]);
  });

  it("defaults to passthrough so an unconfigured coordinator is unchanged", async () => {
    const { seen, provider } = capturingProvider();
    const coordinator = new PredictionCoordinator({ provider, random: () => "req-1" });
    const state = sensitiveState();

    await coordinator.request(state);

    expect(seen[0].worldState).toEqual(state);
  });

  it("preserves request identity and trigger time across projection", async () => {
    const { seen, provider } = capturingProvider();
    const coordinator = new PredictionCoordinator({
      provider,
      contextPolicy: new RedactingContextPolicy(),
      random: () => "req-1",
    });
    const state = sensitiveState();

    const outcome = await coordinator.request(state);

    expect(seen[0].id).toBe(outcome.requestId);
    expect(seen[0].triggeredAt).toBe(state.updatedAt);
    expect(seen[0].episodeId).toBe(state.episode?.id ?? null);
  });

  it("denies egress and answers locally when the policy throws", async () => {
    const { seen, provider } = capturingProvider();
    const diagnostics: string[] = [];
    const exploding: ContextPolicy = {
      id: "exploding",
      project: () => {
        throw new Error("cannot classify field");
      },
    };
    const coordinator = new PredictionCoordinator({
      provider,
      contextPolicy: exploding,
      random: () => "req-1",
      onDiagnostic: (d) => diagnostics.push(d.kind),
    });

    const outcome = await coordinator.request(sensitiveState());

    expect(seen).toHaveLength(0);
    expect(outcome.status).toBe("failed");
    expect(outcome.fallbackReason).toContain("context policy exploding failed");
    expect(diagnostics).toEqual(["context_policy_failed"]);
  });

  it("still runs the local fallback on unredacted state", async () => {
    // The heuristic needs the raw command outcome to suggest inspect_error; a
    // policy that redacts provider egress must not degrade local prediction.
    const state = sensitiveState();
    state.lastCommandOutcome = { commandClass: "test", succeeded: false, exitCode: 1 };
    state.lastEventKind = "terminal_command_completed";
    const coordinator = new PredictionCoordinator({
      provider: {
        name: "failing",
        predict: async () => {
          throw new Error("provider down");
        },
      },
      contextPolicy: new RedactingContextPolicy(),
      random: () => "req-1",
    });

    const outcome = await coordinator.request(state);

    expect(outcome.status).toBe("failed");
    expect(outcome.candidates.map((c) => c.kind)).toContain("inspect_error");
  });
});
