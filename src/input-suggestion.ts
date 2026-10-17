/**
 * Proactive Input Suggestion Service.
 *
 * Proactively triggers when the user's focus moves to an input field (text_input,
 * editor, or terminal). Infers/predicts what the user likely intends to enter,
 * presents the proposed text to the user via Squid's native ConfirmationCard,
 * and upon user acceptance ("Allow"), automatically types the suggested text
 * into the target field using TextTypingService.
 *
 * Honors the GUI switch / environment variable (SQUID_INPUT_SUGGESTIONS !== "off").
 */

import type {
  ActionConfirmationPolicy,
  ActionConfirmationRequest,
} from "./action-confirmation.js";
import type { FocusChangedPayload, WorldState } from "./protocol.js";
import type { TextTypingService } from "./text-typing-service.js";

export interface InputSuggestion {
  readonly text: string;
  readonly why: string;
}

export interface SuggestionContext {
  readonly payload: FocusChangedPayload;
  readonly worldState: WorldState | null;
}

export interface InputSuggestionServiceOptions {
  readonly isEnabled: () => boolean;
  readonly confirmationPolicy: ActionConfirmationPolicy;
  readonly textTypingService: TextTypingService;
  readonly predictSuggestion?: ((context: SuggestionContext) => Promise<InputSuggestion | null> | InputSuggestion | null) | undefined;
  readonly cooldownMs?: number | undefined;
  readonly promptTimeoutMs?: number | undefined;
  readonly log?: ((line: string) => void) | undefined;
  readonly logError?: ((line: string) => void) | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * Checks if the focused element is a text input field or interactive editor/terminal.
 */
export function isTextInputTarget(payload: FocusChangedPayload): boolean {
  if (payload.role === "button" || payload.role === "link") {
    return false;
  }
  if (payload.role === "text_input" || payload.role === "editor") {
    return true;
  }
  const app = (payload.applicationId ?? "").toLowerCase();
  const title = (payload.windowTitle ?? "").toLowerCase();
  // Terminals often report role "unknown" in accessibility trees
  if (
    app.includes("terminal") ||
    app.includes("konsole") ||
    app.includes("alacritty") ||
    app.includes("kitty") ||
    app.includes("wezterm") ||
    title.includes("bash") ||
    title.includes("zsh") ||
    title.includes("terminal")
  ) {
    return true;
  }
  return false;
}

/**
 * Default heuristic suggestion engine when no external LLM predictor is supplied
 * or when the LLM call times out.
 */
export function heuristicSuggestInput(context: SuggestionContext): InputSuggestion | null {
  const { payload, worldState } = context;
  const app = (payload.applicationId ?? "").toLowerCase();
  const title = (payload.windowTitle ?? "").toLowerCase();
  const label = (payload.label ?? "").toLowerCase();

  // 1. Search box in browser or app
  if (label.includes("search") || label.includes("find") || label.includes("query")) {
    const query = worldState?.recentFiles?.[0]
      ? `find ${worldState.recentFiles[0]}`
      : "search documentation";
    return {
      text: query,
      why: `Focused on search field in ${payload.applicationId || "application"}.`,
    };
  }

  // 2. Terminal prompt
  if (
    app.includes("terminal") ||
    app.includes("konsole") ||
    app.includes("alacritty") ||
    app.includes("kitty") ||
    app.includes("wezterm") ||
    title.includes("bash") ||
    title.includes("zsh") ||
    title.includes("terminal")
  ) {
    // If recent file saved was a test or ts/js file, suggest running tests
    const recentFile = worldState?.recentFiles?.[0] ?? "";
    if (recentFile.endsWith(".test.ts") || recentFile.endsWith(".spec.ts")) {
      return {
        text: "bun test",
        why: `Focused on terminal after modifying ${recentFile}.`,
      };
    }
    if (recentFile.endsWith(".rs")) {
      return {
        text: "cargo test",
        why: `Focused on terminal after modifying Rust source ${recentFile}.`,
      };
    }
    return {
      text: "git status",
      why: `Focused on terminal in ${payload.windowTitle || "workspace"}.`,
    };
  }

  // 3. Text editor input
  if (payload.role === "editor") {
    return {
      text: "// TODO: implement next step",
      why: `Focused on code editor in ${payload.windowTitle}.`,
    };
  }

  // 4. General text input field
  const fieldName = payload.label ? `"${payload.label}"` : "text input";
  return {
    text: "Squid auto-suggestion",
    why: `Focused on ${fieldName} in ${payload.applicationId || payload.windowTitle}.`,
  };
}

export class InputSuggestionService {
  private readonly isEnabled: () => boolean;
  private readonly confirmationPolicy: ActionConfirmationPolicy;
  private readonly textTypingService: TextTypingService;
  private readonly predictSuggestion: (context: SuggestionContext) => Promise<InputSuggestion | null>;
  private readonly cooldownMs: number;
  private readonly promptTimeoutMs: number;
  private readonly log?: ((line: string) => void) | undefined;
  private readonly logError?: ((line: string) => void) | undefined;
  private readonly now: () => number;

  private lastTargetKey = "";
  private lastTriggerTime = 0;
  private inFlight = false;

  constructor(options: InputSuggestionServiceOptions) {
    this.isEnabled = options.isEnabled;
    this.confirmationPolicy = options.confirmationPolicy;
    this.textTypingService = options.textTypingService;
    const predictor = options.predictSuggestion ?? heuristicSuggestInput;
    this.predictSuggestion = async (ctx) => predictor(ctx);
    this.cooldownMs = options.cooldownMs ?? 4_000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 25_000;
    this.log = options.log;
    this.logError = options.logError;
    this.now = options.now ?? Date.now;
  }

  /**
   * Called when a focus_changed activity event is ingested.
   */
  async onFocusChanged(
    payload: FocusChangedPayload,
    worldState: WorldState | null,
  ): Promise<void> {
    // 1. Verify feature switch
    if (!this.isEnabled()) {
      return;
    }

    // 2. Validate target is actually an input field (not a button, link, etc.)
    if (!isTextInputTarget(payload)) {
      return;
    }

    // 3. Target identity key & debounce check
    const targetKey = `${payload.applicationId}:${payload.windowTitle}:${payload.role}:${payload.label ?? ""}`;
    const nowMs = this.now();
    if (this.inFlight) {
      return;
    }
    if (targetKey === this.lastTargetKey && nowMs - this.lastTriggerTime < this.cooldownMs) {
      return;
    }

    this.lastTargetKey = targetKey;
    this.lastTriggerTime = nowMs;
    this.inFlight = true;

    try {
      // 4. Generate suggestion
      const suggestion = await this.predictSuggestion({ payload, worldState });
      if (!suggestion || !suggestion.text.trim()) {
        return;
      }

      this.log?.(
        JSON.stringify({
          inputSuggestionTriggered: {
            target: targetKey,
            suggestedText: suggestion.text,
            why: suggestion.why,
          },
        }),
      );

      // 5. Present confirmation card to the user
      const request: ActionConfirmationRequest = {
        candidateId: `suggest-${nowMs}`,
        kind: "input_suggestion",
        summary: `Type: "${suggestion.text}"`,
        why: suggestion.why,
        denyConsequence: "Text will not be typed into the active field.",
        expiresAt: new Date(nowMs + this.promptTimeoutMs).toISOString(),
      };

      const decision = await this.confirmationPolicy.confirm(request);

      if (decision.outcome === "accepted") {
        this.log?.(
          JSON.stringify({
            inputSuggestionAccepted: {
              target: targetKey,
              text: suggestion.text,
            },
          }),
        );

        // 6. User accepted: auto-type into target window
        const typingResult = await this.textTypingService.typeText({
          text: suggestion.text,
          targetWindowTitle: payload.windowTitle,
          targetApplicationId: payload.applicationId,
        });

        if (!typingResult.ok) {
          this.logError?.(
            JSON.stringify({
              inputSuggestionTypingFailed: {
                target: targetKey,
                error: typingResult.error,
              },
            }),
          );
        }
      } else {
        this.log?.(
          JSON.stringify({
            inputSuggestionRejected: {
              target: targetKey,
              decision: decision.outcome,
              reason: decision.reason,
            },
          }),
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logError?.(
        JSON.stringify({
          inputSuggestionFailed: {
            target: targetKey,
            error: message,
          },
        }),
      );
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Resets cooldown state (e.g. on test teardown or explicit session clear).
   */
  reset(): void {
    this.lastTargetKey = "";
    this.lastTriggerTime = 0;
    this.inFlight = false;
  }
}
