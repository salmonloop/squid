import type { InlineExtension } from "./pi-session-factory.js";

/**
 * Metadata captured for each LLM provider request.
 *
 * Privacy note: this captures *metadata* only — model id, message count,
 * approximate payload size, HTTP status, duration. It does NOT capture message
 * content, API keys, or response bodies. Those stay inside Pi's session.
 */
export interface LlmLogEntry {
  /** Monotonically increasing, for correlation between request & response. */
  readonly id: number;
  /** ISO timestamp when the request was dispatched. */
  readonly requestedAt: string;
  /** ISO timestamp when the response arrived. Absent until response. */
  readonly respondedAt?: string;
  /** The model id from the payload. */
  readonly model?: string;
  /** Number of messages in the prompt. */
  readonly messageCount?: number;
  /** Approximate prompt size in characters (for visibility, not billing). */
  readonly promptChars?: number;
  /** HTTP status code from the response. */
  readonly httpStatus?: number;
  /** Duration in milliseconds. */
  readonly durationMs?: number;
  /** "pending" | "ok" | "error" */
  readonly outcome: "pending" | "ok" | "error";
  /** Error description if outcome is "error". */
  readonly error?: string;
}

export type LlmLogListener = (entry: LlmLogEntry) => void;

/**
 * Creates the inline extension that captures LLM request/response metadata.
 *
 * The listener is called once with outcome "pending" when the request fires,
 * and once more with "ok" or "error" when the response arrives. The `id`
 * correlates the two: the panel updates the pending row in place.
 *
 * The hooks come from Pi's extension system:
 * - `before_provider_request` fires immediately before the HTTP dispatch,
 *   providing the full payload (messages array, model id, parameters).
 * - `after_provider_response` fires when the HTTP response headers arrive,
 *   providing status and headers.
 *
 * The hooks fire synchronously relative to each request — one before followed
 * by one after — so a simple stack correlates them without Pi exposing a
 * request token.
 */
export function llmLogExtension(listener: LlmLogListener): InlineExtension {
  let nextId = 1;
  // In-flight requests, correlated by order: the hooks fire one before
  // followed by one after per request, so a stack matches them.
  const inflight: Array<{ id: number; requestedAt: number }> = [];

  return {
    name: "squid-llm-log",
    hidden: true,
    factory: (pi) => {
      pi.on("before_provider_request", (event) => {
        const id = nextId++;
        const now = Date.now();
        inflight.push({ id, requestedAt: now });

        const payload = event.payload as Record<string, unknown> | undefined;
        const model =
          typeof payload?.model === "string" ? payload.model : undefined;
        const messages = Array.isArray(payload?.messages)
          ? (payload.messages as unknown[])
          : undefined;

        let promptChars: number | undefined;
        try {
          promptChars = JSON.stringify(payload).length;
        } catch {
          // Circular or non-serializable payload — skip size measurement.
        }

        listener({
          id,
          requestedAt: new Date(now).toISOString(),
          ...(model !== undefined ? { model } : {}),
          ...(messages !== undefined ? { messageCount: messages.length } : {}),
          ...(promptChars !== undefined ? { promptChars } : {}),
          outcome: "pending",
        });

        // Return the payload unchanged — this hook can transform it and the
        // caller expects whatever we return to be the effective payload.
        return event.payload;
      });

      pi.on("after_provider_response", (event) => {
        const req = inflight.pop();
        if (req === undefined) return;

        const now = Date.now();
        const httpStatus =
          typeof event.status === "number" ? event.status : undefined;
        const isError = httpStatus === undefined || httpStatus >= 400;

        listener({
          id: req.id,
          requestedAt: new Date(req.requestedAt).toISOString(),
          respondedAt: new Date(now).toISOString(),
          ...(httpStatus !== undefined ? { httpStatus } : {}),
          durationMs: now - req.requestedAt,
          outcome: isError ? "error" : "ok",
          ...(isError
            ? { error: `HTTP ${httpStatus ?? "no response"}` }
            : {}),
        });
      });
    },
  };
}
