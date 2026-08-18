import type { PredictionCandidate, WorldState } from "./protocol.js";

export interface Predictor {
  predict(state: WorldState, now?: Date): readonly PredictionCandidate[];
}

export class HeuristicPredictor implements Predictor {
  predict(state: WorldState, now = new Date()): readonly PredictionCandidate[] {
    const expiresAt = new Date(now.getTime() + 20_000).toISOString();
    const candidates: PredictionCandidate[] = [];

    if (state.focus?.role === "text_input" || state.focus?.role === "editor") {
      if (state.focus.prefix.trim().length > 0) {
        candidates.push({
          kind: "draft_completion",
          rationale: "A text input has a non-empty prefix and is eligible for completion.",
          confidence: 0.35,
          expiresAt,
          sourceEventIds: [],
          parameters: {
            prefix: state.focus.prefix,
            suffix: state.focus.suffix,
            language: state.focus.language,
          },
        });
      }
    }

    if (state.lastCommandOutcome?.succeeded === false) {
      candidates.push({
        kind: "inspect_error",
        rationale: "The most recent terminal command failed.",
        confidence: 0.7,
        expiresAt,
        sourceEventIds: [],
        parameters: {
          exitCode: state.lastCommandOutcome.exitCode,
          commandClass: state.lastCommandOutcome.commandClass,
        },
      });
    }

    const latestAction = state.recentActions[0];
    if (latestAction?.kind === "file_saved" && state.activeApplication?.id.includes("code")) {
      candidates.push({
        kind: "run_tests",
        rationale: "A code file was saved while a coding application is active.",
        confidence: 0.3,
        expiresAt,
        sourceEventIds: [latestAction.sourceEventId],
        parameters: { path: latestAction.target },
      });
    }

    const focus = state.focus;
    if (focus && focus.selection.trim().length > 0 && state.currentBrowserPage !== null) {
      candidates.push({
        kind: "search_selection",
        rationale: "Text is selected while a browser page is active.",
        confidence: 0.2,
        expiresAt,
        sourceEventIds: [],
        parameters: { selection: focus.selection },
      });
    }

    return candidates.sort((left, right) => right.confidence - left.confidence);
  }
}
