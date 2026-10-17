# Architecture Design and Development Plan: Proactive Input Suggestion & Auto-typing

## 1. Executive Summary & Requirements Overview

The user requested strengthening Squid's proactive behavior in a specific desktop interaction scenario:
1. **Trigger Mechanism (触发机制):** When the user focuses (e.g. mouse click/focus) on a text input field, Squid pops up a prompt, triggers programmatic reasoning to predict what the user intends to input, and offers this suggestion with an option for the user to trigger/accept it.
2. **Interaction Detail (交互细节):** If the user chooses to accept the suggested input text, Squid must directly type/input the text into the focused field on behalf of the user, rather than merely displaying the suggestion.
3. **GUI Control Toggle (控制开关):** Because this proactive behavior can be intrusive if unwanted, provide a toggle switch in the GUI settings panel, enabled by default (`default: on`).
4. **Development & Review Process (开发与测试流程):**
   - Formulate an elegant and clean design and development plan, reviewed by a subagent.
   - Step-by-step implementation, with each step reviewed by a subagent.
   - After completion, run virtual desktop smoke tests (including visual smoke test on X11/Xvfb), and open a PR linked via `link_pull_request`.

---

## 2. Architecture & Design

### 2.1 Focus Detection & Ingest Pipeline
- **Observation Source:** Screen text sources (`screen-text-source.ts`, `screen-text-reader-linux.ts`, `screen-text-reader-windows.ts`, `screen-text-reader-synthetic.ts`) produce `focus_changed` activity events with `payload: { applicationId, windowTitle, role, label }`.
- **Trigger Condition:**
  1. `event.kind === "focus_changed"`
  2. `event.payload.role === "text_input" || event.payload.role === "editor"`
  3. Feature switch `isInputSuggestionsEnabled()` is true.
  4. De-duplication / Cooldown: Prevent repeated prompts for the same input control unless focus moves away and returns (keyed by `${applicationId}:${windowTitle}:${role}:${label}`).

### 2.2 Suggestion Generation ("Thinking")
Squid creates an `InputSuggestionService` (`src/input-suggestion.ts`):
- Context inputs:
  - Focused element details: `applicationId`, `windowTitle`, `role`, `label`
  - Text context if available: `prefix`, `suffix`, `selection`
  - Episodic world state: `recentActions`, `lastEvent`
  - Recent timeline events from `EventStore`
- Generation strategy:
  - **With Live LLM / Resident Agent:** Ask model for focused text completion prediction in the context of the focused field, returning `{ text: string, why: string }`.
  - **Fallback / Heuristics (Offline / Tests / CI):** Contextual prediction based on active window (e.g., terminal command suggestion like `bun test` or `git status`, editor completion, or search phrase).

### 2.3 Proactive Prompt & Confirmation Card ("我们的方式提供建议")
- Integrates with Squid's existing confirmation surface (`ActionConfirmationPolicy` and `PanelConfirmationSurface`).
- A prompt message is dispatched to the panel:
  - `type: "prompt"`
  - `kind: "type_input"`
  - `summary: suggestion.text`
  - `why: suggestion.why`
  - `denyConsequence: "No text will be typed into the active input."`
  - `expiresAt: timestamp (30s timeout)`
- The Slint panel renders `ConfirmationCard`:
  - Clearly displays the suggested text in the monospaced card summary.
  - Explains why the suggestion was made.
  - Offers three distinct actions: **Allow** (Accept), **Decline**, **Later** (Defer).

### 2.4 Auto-typing Injection Engine ("直接帮用户输入进去")
When the user clicks "Allow", `SerialConfirmationPolicy` resolves to `accepted` (`user_accepted`).
Squid executes `DesktopInputInjector` / `TextTypingService` (`src/text-typing-service.ts`):
- **Linux (X11):**
  Uses `xdotool`:
  `xdotool type --delay 12 --clearmodifiers -- "<text>"`
- **Windows:**
  Uses PowerShell script with `[System.Windows.Forms.SendKeys]::SendWait(...)` / UI Automation.
- **macOS:**
  Uses `osascript` with `keystroke`.
- **Testability:**
  All platform command executions go through an injectable subprocess runner, allowing comprehensive offline unit tests without actual GUI or keyboard interference.

### 2.5 GUI Configuration Switch (默认开启)
1. **Config Schema (`src/config-schema.ts`):**
   - Key: `inputSuggestions`
   - Env: `SQUID_INPUT_SUGGESTIONS`
   - Label: `"Input suggestions"`
   - Group: `"Screen"`
   - Kind: `"enum"`, values: `["on", "off"]`
   - Description: `"Whether Squid proactively proposes text suggestions when focusing on an input field. Defaults to on."`
   - Default: unset means `"on"` (enabled).
2. **GUI Slint Widget (`ui/settings.slint`):**
   - For enum settings with values `on;off`, render an interactive Slint `Switch` toggle widget showing `Enabled`/`Disabled` state.
   - Defaults to checked/Enabled when value is not `"off"`.
   - Clicking toggles and dispatches `config_set` immediately.
3. **Protocol & Wiring:**
   - Seamlessly works over existing `config_get` / `config_set` protocol without breaking schema invariants.

---

## 3. Development Plan (Step-by-Step)

### Step 1: Configuration Schema & GUI Switch
- Add `inputSuggestions` to `src/config-schema.ts` with `env: "SQUID_INPUT_SUGGESTIONS"`, `group: "Screen"`, `kind: "enum"`, `values: ["on", "off"]`.
- Enhance `ui/settings.slint` with an explicit `Switch` for on/off enum settings.
- Write unit tests in `tests/config.test.ts`.
- **Review Checkpoint 1:** Invoke subagent to review Step 1 changes.

### Step 2: Cross-Platform Text Typing Service (`TextTypingService`)
- Create `src/text-typing-service.ts` with Linux (`xdotool`), Windows (PowerShell), macOS (`osascript`) implementations.
- Include proper escaping, `--` termination, error handling, and timeout protection.
- Write unit tests in `tests/text-typing-service.test.ts` covering argument building and mock execution.
- **Review Checkpoint 2:** Invoke subagent to review Step 2 changes.

### Step 3: Suggestion Engine & Ingest Trigger in Watch Session
- Create `src/input-suggestion.ts` to manage reasoning and heuristics from context.
- Integrate into `src/watch-session.ts`:
  - Hook on `focus_changed` when `role` is `text_input` or `editor`.
  - Check `isInputSuggestionsEnabled()`.
  - Generate suggestion and invoke `actionConfirmation.confirm(...)`.
  - On `accepted`, trigger `textTypingService.typeText(...)`.
- Write unit tests in `tests/input-suggestion.test.ts` and `tests/watch-session.test.ts`.
- **Review Checkpoint 3:** Invoke subagent to review Step 3 changes.

### Step 4: Verification, Virtual Desktop Smoke Testing & PR
- Run full test suite: `bun test` and `cargo test`.
- Build release UI binary: `cargo build --release --manifest-path ui/Cargo.toml`.
- Run virtual desktop smoke test: `bun run ui:smoke`.
- Verify visual output screenshots in `/tmp/squid-ui-smoke-*/`.
- **Review Checkpoint 4:** Final subagent review before PR.
- Commit changes, push branch, open PR via `gh pr create`, and link with `link_pull_request`.
