import { describe, expect, it } from "bun:test";
import type {
  ActionConfirmationDecision,
  ActionConfirmationPolicy,
  ActionConfirmationRequest,
} from "../src/action-confirmation.js";
import {
  heuristicSuggestInput,
  InputSuggestionService,
  isTextInputTarget,
} from "../src/input-suggestion.js";
import type { FocusChangedPayload } from "../src/protocol.js";
import type { TextTypingResult, TextTypingTarget } from "../src/text-typing-service.js";
import { TextTypingService } from "../src/text-typing-service.js";

describe("isTextInputTarget", () => {
  it("identifies text_input and editor roles", () => {
    expect(
      isTextInputTarget({
        role: "text_input",
        applicationId: "code",
        windowTitle: "main.ts",
        label: "Line 10",
      }),
    ).toBe(true);

    expect(
      isTextInputTarget({
        role: "editor",
        applicationId: "sublime",
        windowTitle: "document.txt",
        label: null,
      }),
    ).toBe(true);

    expect(
      isTextInputTarget({
        role: "button",
        applicationId: "code",
        windowTitle: "dialog",
        label: "Submit",
      }),
    ).toBe(false);
  });

  it("identifies terminal applications even when role is unknown", () => {
    expect(
      isTextInputTarget({
        role: "unknown",
        applicationId: "org.gnome.Terminal",
        windowTitle: "user@host:~",
        label: null,
      }),
    ).toBe(true);

    expect(
      isTextInputTarget({
        role: "unknown",
        applicationId: "kitty",
        windowTitle: "kitty",
        label: null,
      }),
    ).toBe(true);

    expect(
      isTextInputTarget({
        role: "unknown",
        applicationId: "gnome-shell",
        windowTitle: "Desktop",
        label: null,
      }),
    ).toBe(false);

    expect(
      isTextInputTarget({
        role: "button",
        applicationId: "org.gnome.Terminal",
        windowTitle: "Terminal - bash",
        label: "Close Tab",
      }),
    ).toBe(false);
  });
});

describe("heuristicSuggestInput", () => {
  it("suggests test command when terminal is active after a test file was modified", () => {
    const suggestion = heuristicSuggestInput({
      payload: {
        role: "text_input",
        applicationId: "terminal",
        windowTitle: "Terminal - bash",
        label: null,
      },
      worldState: {
        recentFiles: ["src/config.test.ts"],
      } as any,
    });

    expect(suggestion).not.toBeNull();
    expect(suggestion?.text).toBe("bun test");
    expect(suggestion?.why).toContain("config.test.ts");
  });

  it("suggests git status by default in terminal", () => {
    const suggestion = heuristicSuggestInput({
      payload: {
        role: "text_input",
        applicationId: "terminal",
        windowTitle: "Terminal - bash",
        label: null,
      },
      worldState: null,
    });

    expect(suggestion?.text).toBe("git status");
  });

  it("suggests search query when focusing on a search box", () => {
    const suggestion = heuristicSuggestInput({
      payload: {
        role: "text_input",
        applicationId: "google-chrome",
        windowTitle: "GitHub",
        label: "Search or jump to...",
      },
      worldState: null,
    });

    expect(suggestion).not.toBeNull();
    expect(suggestion?.text).toContain("search");
    expect(suggestion?.why).toContain("search field");
  });
});

describe("InputSuggestionService", () => {
  const createMockPolicy = (decision: ActionConfirmationDecision): {
    policy: ActionConfirmationPolicy;
    confirmedRequests: ActionConfirmationRequest[];
  } => {
    const confirmedRequests: ActionConfirmationRequest[] = [];
    const policy: ActionConfirmationPolicy = {
      async confirm(request) {
        confirmedRequests.push(request);
        return decision;
      },
    };
    return { policy, confirmedRequests };
  };

  const createMockTypingService = (): {
    service: TextTypingService;
    typedTargets: TextTypingTarget[];
  } => {
    const typedTargets: TextTypingTarget[] = [];
    const service = new TextTypingService({
      runner: async () => ({ exitCode: 0 }),
    });
    service.typeText = async (target: TextTypingTarget): Promise<TextTypingResult> => {
      typedTargets.push(target);
      return { ok: true };
    };
    return { service, typedTargets };
  };

  it("does nothing when disabled by configuration", async () => {
    const { policy, confirmedRequests } = createMockPolicy({
      outcome: "accepted",
      reason: "user_accepted",
    });
    const { service, typedTargets } = createMockTypingService();

    const suggestionService = new InputSuggestionService({
      isEnabled: () => false,
      confirmationPolicy: policy,
      textTypingService: service,
    });

    await suggestionService.onFocusChanged(
      {
        role: "text_input",
        applicationId: "terminal",
        windowTitle: "bash",
        label: null,
      },
      null,
    );

    expect(confirmedRequests.length).toBe(0);
    expect(typedTargets.length).toBe(0);
  });

  it("prompts user and types text when user accepts", async () => {
    const { policy, confirmedRequests } = createMockPolicy({
      outcome: "accepted",
      reason: "user_accepted",
    });
    const { service, typedTargets } = createMockTypingService();

    const suggestionService = new InputSuggestionService({
      isEnabled: () => true,
      confirmationPolicy: policy,
      textTypingService: service,
      predictSuggestion: async () => ({
        text: "git diff",
        why: "Review recent changes",
      }),
    });

    await suggestionService.onFocusChanged(
      {
        role: "text_input",
        applicationId: "terminal",
        windowTitle: "bash",
        label: null,
      },
      null,
    );

    expect(confirmedRequests.length).toBe(1);
    expect(confirmedRequests[0]?.kind).toBe("input_suggestion");
    expect(confirmedRequests[0]?.summary).toBe('Type: "git diff"');
    expect(confirmedRequests[0]?.why).toBe("Review recent changes");

    expect(typedTargets.length).toBe(1);
    expect(typedTargets[0]?.text).toBe("git diff");
    expect(typedTargets[0]?.targetWindowTitle).toBe("bash");
  });

  it("does NOT type text when user declines or prompt expires", async () => {
    const { policy, confirmedRequests } = createMockPolicy({
      outcome: "rejected",
      reason: "user_rejected",
    });
    const { service, typedTargets } = createMockTypingService();

    const suggestionService = new InputSuggestionService({
      isEnabled: () => true,
      confirmationPolicy: policy,
      textTypingService: service,
    });

    await suggestionService.onFocusChanged(
      {
        role: "text_input",
        applicationId: "terminal",
        windowTitle: "bash",
        label: null,
      },
      null,
    );

    expect(confirmedRequests.length).toBe(1);
    // Crucial: No typing occurred!
    expect(typedTargets.length).toBe(0);
  });

  it("deduplicates rapid focus changes within cooldown window", async () => {
    const { policy, confirmedRequests } = createMockPolicy({
      outcome: "accepted",
      reason: "user_accepted",
    });
    const { service, typedTargets } = createMockTypingService();

    let clock = 1000;
    const suggestionService = new InputSuggestionService({
      isEnabled: () => true,
      confirmationPolicy: policy,
      textTypingService: service,
      cooldownMs: 3000,
      now: () => clock,
    });

    const payload: FocusChangedPayload = {
      role: "text_input",
      applicationId: "terminal",
      windowTitle: "bash",
      label: null,
    };

    // First focus: triggers
    await suggestionService.onFocusChanged(payload, null);
    expect(confirmedRequests.length).toBe(1);

    // Second focus 500ms later: debounced/skipped
    clock += 500;
    await suggestionService.onFocusChanged(payload, null);
    expect(confirmedRequests.length).toBe(1);

    // Third focus after cooldown (3500ms later): triggers
    clock += 3500;
    await suggestionService.onFocusChanged(payload, null);
    expect(confirmedRequests.length).toBe(2);
  });
});
