import { describe, expect, it } from "bun:test";
import {
  PassthroughCapturePolicy,
  RedactingCapturePolicy,
  type CapturePolicy,
} from "../src/capture-policy.js";
import { InMemoryEventStore } from "../src/event-store.js";
import { FakePredictionProvider, candidate } from "../src/fake-prediction-provider.js";
import { PredictionCoordinator } from "../src/prediction-coordinator.js";
import { createActivityEvent, isActivityEvent, parseActivityEvent } from "../src/protocol.js";
import { PredictionRuntime } from "../src/prediction-runtime.js";
import { SquidCore } from "../src/squid-core.js";
import type {
  ActivityEvent,
  BrowserNavigatedPayload,
  FocusChangedPayload,
  TextContextChangedPayload,
  WindowChangedPayload,
} from "../src/protocol.js";

function createRuntime(capturePolicy: CapturePolicy) {
  const provider = new FakePredictionProvider({
    name: "fake-capture",
    candidates: [candidate("run_tests")],
  });
  const store = new InMemoryEventStore();
  const runtime = new PredictionRuntime(
    new SquidCore(store),
    new PredictionCoordinator({ provider, random: () => "capture-1" }),
    { capturePolicy },
  );
  return { runtime, store };
}

// A captured event must still be a structurally valid event — the redacted
// form is what lands in the store, so a schema break at capture surfaces at
// ingest. Reusing `isActivityEvent` keeps this assertion honest: it runs the
// same validator `core.ingest` does.
function redactWindow(title: string) {
  const policy = new RedactingCapturePolicy();
  return policy.capture(
    createActivityEvent({
      kind: "window_changed",
      payload: { applicationId: "editor", title, bounds: null },
    }),
  );
}

// `createActivityEvent` returns `ActivityEvent<TPayload>`; a loose alias keeps
// the helper readable without threading the payload generic everywhere.
type ActivityEventLike = ActivityEvent;

describe("PassthroughCapturePolicy", () => {
  it("returns an event equal to the input", () => {
    const policy = new PassthroughCapturePolicy();
    const event = createActivityEvent({
      kind: "file_saved",
      payload: { path: "src/main.ts", applicationId: "editor" },
    });

    const captured = policy.capture(event);

    expect(captured).toEqual(event);
  });

  it("does not share the input by reference", () => {
    const policy = new PassthroughCapturePolicy();
    const event = createActivityEvent({
      kind: "window_changed",
      payload: { applicationId: "editor", title: "main.ts", bounds: null },
    });

    const captured = policy.capture(event) as typeof event;
    (captured.payload as WindowChangedPayload).title = "mutated";

    // The input event is untouched because passthrough clones, never aliases.
    expect((event.payload as WindowChangedPayload).title).toBe("main.ts");
  });

  it("leaves the redacted marker absent", () => {
    const policy = new PassthroughCapturePolicy();
    const event = createActivityEvent({
      kind: "file_saved",
      payload: { path: "src/main.ts", applicationId: "editor" },
    });

    expect("redacted" in policy.capture(event)).toBe(false);
  });
});

describe("RedactingCapturePolicy", () => {
  it("redacts a window title that names a password", () => {
    const captured = redactWindow("editor — password = hunter2") as ActivityEventLike;

    expect((captured.payload as WindowChangedPayload).title).toBe("[redacted]");
    expect(captured.redacted).toBe(true);
  });

  it("returns the event unchanged when no credential pattern matches", () => {
    const captured = redactWindow("editor — main.ts") as ActivityEventLike;

    expect((captured.payload as WindowChangedPayload).title).toBe("editor — main.ts");
    expect("redacted" in captured).toBe(false);
  });

  it("matches case-insensitively", () => {
    const captured = redactWindow("EDITOR — SECRET key") as ActivityEventLike;

    expect((captured.payload as WindowChangedPayload).title).toBe("[redacted]");
    expect(captured.redacted).toBe(true);
  });

  it("redacts a PEM private key header", () => {
    const captured = redactWindow("-----BEGIN RSA PRIVATE KEY-----") as ActivityEventLike;

    expect((captured.payload as WindowChangedPayload).title).toBe("[redacted]");
  });

  it("redacts an AWS access key prefix", () => {
    const captured = redactWindow("aws key AKIAIOSFODNN7EXAMPLE") as ActivityEventLike;

    expect((captured.payload as WindowChangedPayload).title).toBe("[redacted]");
  });

  it("redacts a GitHub token prefix", () => {
    const captured = redactWindow("ghp_0123456789abcdef") as ActivityEventLike;

    expect((captured.payload as WindowChangedPayload).title).toBe("[redacted]");
  });

  it("redacts a Bearer auth header", () => {
    const captured = redactWindow("Authorization: Bearer abc.def.ghi") as ActivityEventLike;

    expect((captured.payload as WindowChangedPayload).title).toBe("[redacted]");
  });

  it("redacts every matching text field at once", () => {
    const policy = new RedactingCapturePolicy();
    const event = createActivityEvent({
      kind: "text_context_changed",
      payload: {
        prefix: "const token = ",
        suffix: "\nconst secret =",
        selection: "password",
        language: "typescript",
      },
    });

    const captured = policy.capture(event);
    const payload = captured.payload as TextContextChangedPayload;

    expect(payload.prefix).toBe("[redacted]");
    expect(payload.suffix).toBe("[redacted]");
    expect(payload.selection).toBe("[redacted]");
    expect(captured.redacted).toBe(true);
  });

  it("redacts only the focus fields that match", () => {
    const policy = new RedactingCapturePolicy();
    const event = createActivityEvent({
      kind: "focus_changed",
      payload: {
        applicationId: "editor",
        windowTitle: "main.ts",
        role: "editor",
        label: "api_key field",
      },
    });

    const captured = policy.capture(event);
    const payload = captured.payload as FocusChangedPayload;

    expect(payload.windowTitle).toBe("main.ts");
    expect(payload.label).toBe("[redacted]");
    expect(captured.redacted).toBe(true);
  });

  it("redacts a full URL rather than keeping its origin", () => {
    const policy = new RedactingCapturePolicy();
    const event = createActivityEvent({
      kind: "browser_navigated",
      payload: {
        url: "https://example.com/login?token=s3cr3t",
        title: "Login",
        host: "example.com",
      },
    });

    const captured = policy.capture(event);
    const payload = captured.payload as BrowserNavigatedPayload;

    // Capture is the stricter boundary: unlike egress it keeps no origin, so a
    // token in the query string cannot survive here even in part. The URL field
    // carries a `format: "uri"` constraint, so the redacted form is a reserved
    // `.invalid` placeholder rather than the plain "[redacted]" sentinel.
    expect(payload.url).toBe("https://redacted.invalid/");
    expect(payload.title).toBe("Login");
    expect(captured.redacted).toBe(true);
  });

  it("redacts a browser title that names a credential", () => {
    const policy = new RedactingCapturePolicy();
    const event = createActivityEvent({
      kind: "browser_navigated",
      payload: {
        url: "https://example.com/dashboard",
        title: "GitHub — token ghp_0123456789abcdef",
        host: "example.com",
      },
    });

    const captured = policy.capture(event);
    const payload = captured.payload as BrowserNavigatedPayload;

    // A page title is free text like a window title, so a credential there is
    // redacted while the structural host stays. Egress redacts the page title
    // too — capture must not be the wider boundary.
    expect(payload.url).toBe("https://example.com/dashboard");
    expect(payload.title).toBe("[redacted]");
    expect(payload.host).toBe("example.com");
    expect(captured.redacted).toBe(true);
  });

  it("does not redact a file path named after a secret", () => {
    const policy = new RedactingCapturePolicy();
    const event = createActivityEvent({
      kind: "file_saved",
      payload: { path: "config/password.env", applicationId: "editor" },
    });

    const captured = policy.capture(event);

    // A path is structural, not credential content — the file name is not the
    // secret. Capture and egress agree: neither redacts a path.
    expect((captured.payload as { path: string }).path).toBe("config/password.env");
    expect("redacted" in captured).toBe(false);
  });

  it("produces an event that still passes protocol validation", () => {
    const captured = redactWindow("password=hunter2");

    expect(isActivityEvent(captured)).toBe(true);
  });

  it("round-trips a redacted event through parseActivityEvent", () => {
    const policy = new RedactingCapturePolicy();
    const event = createActivityEvent({
      kind: "window_changed",
      payload: { applicationId: "editor", title: "password=hunter2", bounds: null },
    });

    const captured = policy.capture(event);
    const reparsed = parseActivityEvent(JSON.parse(JSON.stringify(captured)));

    expect(reparsed).toEqual(captured);
    expect(reparsed.redacted).toBe(true);
  });
});

describe("capture at the runtime ingress", () => {
  it("persists the redacted marker through the store", async () => {
    const { runtime, store } = createRuntime(new RedactingCapturePolicy());
    await runtime.ingest(
      createActivityEvent({
        kind: "window_changed",
        payload: { applicationId: "editor", title: "token=abc", bounds: null },
      }),
    );

    const stored = (await store.all())[0];
    const payload = stored.payload as WindowChangedPayload;

    expect(payload.title).toBe("[redacted]");
    expect(stored.redacted).toBe(true);
  });

  it("leaves non-credential events unmarked by default", async () => {
    const { runtime, store } = createRuntime(new RedactingCapturePolicy());
    await runtime.ingest(
      createActivityEvent({
        kind: "file_saved",
        payload: { path: "src/main.ts", applicationId: "editor" },
      }),
    );

    expect("redacted" in (await store.all())[0]).toBe(false);
  });
});
