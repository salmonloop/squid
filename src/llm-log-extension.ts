import type { InlineExtension } from "./pi-session-factory.js";
import { sanitizeLlmPreview } from "./audit-text.js";

/**
 * Metadata captured for each LLM provider request.
 *
 * Privacy note: this captures request *metadata* — model id, message count,
 * approximate payload size, HTTP status, duration — plus one deliberately
 * bounded exception: `preview`, a capped, control-stripped, credential-redacted
 * excerpt of the request content for the debug viewer (see `sanitizeLlmPreview`
 * / `LLM_PREVIEW_MAX_LENGTH`). It does NOT capture the full payload, API keys, or
 * response bodies. Those stay inside Pi's session.
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
  /**
   * A bounded, scrubbed excerpt of the request content (most-recent messages) for
   * the debug viewer. Present on both the pending and completed lines so it
   * survives the panel's by-id upsert. See `sanitizeLlmPreview`.
   */
  readonly preview?: string;
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
  // followed by one after per request, so a stack matches them. The stashed
  // fields (model/counts/preview) are re-emitted on the response line, because
  // the panel upserts a row by id wholesale — a completed line without them
  // would blank the finished row.
  const inflight: Array<{
    id: number;
    requestedAt: number;
    model?: string;
    messageCount?: number;
    promptChars?: number;
    preview?: string;
  }> = [];

  return {
    name: "squid-llm-log",
    hidden: true,
    factory: (pi) => {
      pi.on("before_provider_request", (event) => {
        const id = nextId++;
        const now = Date.now();

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

        // A bounded, scrubbed excerpt of what is being sent, for the debug
        // viewer's details dialog. Built here — the one hook that has the
        // payload — and carried through completion via `inflight`.
        const preview =
          messages !== undefined ? sanitizeLlmPreview(buildRequestPreview(messages)) : undefined;

        inflight.push({
          id,
          requestedAt: now,
          ...(model !== undefined ? { model } : {}),
          ...(messages !== undefined ? { messageCount: messages.length } : {}),
          ...(promptChars !== undefined ? { promptChars } : {}),
          ...(preview !== undefined ? { preview } : {}),
        });

        listener({
          id,
          requestedAt: new Date(now).toISOString(),
          ...(model !== undefined ? { model } : {}),
          ...(messages !== undefined ? { messageCount: messages.length } : {}),
          ...(promptChars !== undefined ? { promptChars } : {}),
          ...(preview !== undefined ? { preview } : {}),
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
          // Re-emitted from the stashed request: the panel replaces a row by id
          // wholesale, so the finished line carries the same model/counts/preview
          // the pending line did — otherwise a completed request blanks them.
          ...(req.model !== undefined ? { model: req.model } : {}),
          ...(req.messageCount !== undefined ? { messageCount: req.messageCount } : {}),
          ...(req.promptChars !== undefined ? { promptChars: req.promptChars } : {}),
          ...(req.preview !== undefined ? { preview: req.preview } : {}),
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

/**
 * A bounded, human-readable excerpt of the request messages, most-recent-first
 * kept: the tail (recent observations, the current snapshot, the turn prompt) is
 * what a reader inspecting "what is this request about" wants, and it is what
 * changes per turn. `sanitizeLlmPreview` scrubs and hard-caps whatever this
 * returns, so the budgets here only keep one huge message from crowding out the
 * rest before that final cap.
 */
function buildRequestPreview(messages: readonly unknown[]): string {
  const rendered = messages.map((message) => {
    const msg = message as { role?: unknown; content?: unknown };
    const role = typeof msg.role === "string" ? msg.role : "?";
    return `[${role}] ${previewContent(msg.content)}`;
  });
  const body = rendered.join(" · ");
  // Keep the last stretch — the most recent context — with a leading marker so a
  // truncated preview reads as one rather than as a request that began mid-word.
  const TAIL = 1600;
  const tail = body.length > TAIL ? `…${body.slice(-TAIL)}` : body;
  return `(${rendered.length} msgs) ${tail}`;
}

/**
 * One message's text content, flattened across content-block shapes and capped
 * per message so a single 100 KB message cannot hide every other in the excerpt.
 */
function previewContent(content: unknown): string {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block !== null && typeof block === "object") {
          const part = block as { type?: string; text?: string; thinking?: string; name?: string };
          if (typeof part.text === "string") return part.text;
          if (typeof part.thinking === "string") return `[thinking] ${part.thinking}`;
          if (part.type === "toolCall" && typeof part.name === "string") return `[tool: ${part.name}]`;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  } else {
    text = "";
  }
  const PER_MESSAGE = 300;
  return text.length > PER_MESSAGE ? `${text.slice(0, PER_MESSAGE)}…` : text;
}
