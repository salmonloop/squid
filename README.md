# 🦑 Squid — The Ambient Desktop AI Assistant

<p align="center">
  <strong>An ambient, persistent desktop companion with perception and memory.</strong><br>
  <em>Observes your workspace quietly. Synthesizes context deeply. Acts decisively. Governed by you.</em>
</p>

<p align="center">
  <a href="README.md"><strong>English</strong></a> •
  <a href="README_zh.md"><strong>简体中文</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun%20%3E%3D%201.4.2-F472B6?logo=bun&logoColor=white" alt="Bun">
  <img src="https://img.shields.io/badge/GUI-Rust%20%2B%20Slint%201.17-DEA584?logo=rust&logoColor=white" alt="Slint">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-blue" alt="Platform">
  <img src="https://img.shields.io/badge/agent-Pi%20Coding%20Agent-8A2BE2" alt="Pi Agent">
  <img src="https://img.shields.io/badge/tests-810%2B%20passing%20(offline)-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
</p>

---

## 💡 What is Squid?

Most AI tools today are **passive chat boxes**: you hit an error, copy-paste terminal outputs, re-explain your project architecture for the tenth time, and coax the model into understanding what you were doing.

**Squid flips this paradigm.**

Squid is an **ambient, long-lived desktop AI companion** built on the [Pi agent runtime](https://github.com/earendil-works/pi-ai). Instead of waiting for you to copy-paste context, Squid quietly runs in your background and perceives your workstation activity in real time:
- The project files you save in your editor
- The commands you run in your shell and their exit codes
- The active window, focused UI control, and selected text on your screen
- The API reference or GitHub issue you are reading in your browser

Squid continuously distills these observations into a coherent **episodic world state**. When things go wrong or when assistance is needed, Squid already knows the full story — stepping in with timely insights and actions, while remaining strictly under your control.

---

## 🌟 A Day with Squid: Real-World Scenarios

### 1. ⚡ Terminal Errors? No More Copy-Pasting Stacks
You run a test suite or deployment command in your terminal (`cargo test`, `pytest`, `npm run build`) and hit a compiler error or assertion failure.
> **Without Squid**: You select text in the terminal, switch windows to a browser or chat window, paste the trace, and type *"why did this fail?"*.
>
> **With Squid**: Squid hooks terminal completions. It already knows the command, the failure exit code, and the files you edited right before running it. It synthesizes the root cause immediately without you copying a single line.

### 2. 🔍 Cross-Window Context: It Connects the Dots
You browse an open-source documentation site in Chrome, then switch back to VS Code to implement a function.
> **With Squid**: Squid notices the active browser tab URL and the code you are saving. When asked for suggestions or generating completions, it pulls context from the exact documentation page you were just looking at.

### 3. 🔕 Zero Distraction & Smart Notifications
Nobody likes an AI that interrupts every three seconds like an over-eager assistant.
> **With Squid**: Squid operates under an explicit *permission to do nothing* philosophy. It only triggers a desktop toast notification (Linux `notify-send`, Windows `Shell_NotifyIcon`, macOS `osascript`) **when it has actually executed a real action or file change**. If it is merely reading, thinking, or deciding no action is required, it stays 100% quiet.

### 4. 🛡️ Automatic Privacy Shields
You open your password manager or banking portal to grab an API token or verify a billing detail.
> **With Squid**: Squid detects the foreground application (`1Password`, `Bitwarden`, `KeePassXC`, or custom exclusions via `SQUID_EXCLUDE`). Screen and window capture immediately suspend until you switch back. Secrets, passwords, and tokens are scrubbed at the ingress before ever touching the database.

---

## 🚀 Quick Start

### Option A: Pre-built Release (Recommended for Everyday Users)

Get started in under 60 seconds with no compilers or complex dependencies required:

1. Download the latest release zip for your OS from [GitHub Releases](https://github.com/salmonloop/squid/releases):
   - **Linux**: `squid-x86_64-unknown-linux-gnu.zip`
   - **Windows**: `squid-x86_64-pc-windows-msvc.zip`
2. Extract the archive. You will see two companion binaries:
   - `squid-ui`: The high-performance desktop panel (double-click to open).
   - `squid`: The background sensory engine (supervised automatically by `squid-ui`).
3. Launch `squid-ui`:
   - It will open the sleek Fluent desktop panel and dock an icon in your system tray.
   - On first launch, navigate to **SETTINGS** to connect your favorite LLM provider:
     - **Cloud Providers**: OpenAI, Anthropic, DeepSeek, OpenRouter, etc.
     - **Local & Private Models**: [Ollama](https://ollama.ai/), vLLM, LM Studio, or any OpenAI-compatible `/v1` endpoint.

---

### Option B: Build from Source (For Developers & Contributors)

#### Prerequisites
- [Bun](https://bun.sh) `1.4.2` or later
- [Rust](https://rustup.rs/) (Cargo 1.80+)

```bash
# 1. Clone the repository and install dependencies
git clone https://github.com/salmonloop/squid.git
cd squid
bun install --frozen-lockfile

# 2. Build the native Slint UI desktop panel
cargo build --release --manifest-path ui/Cargo.toml

# 3. Launch Squid
bun run start
```

`bun run start` runs `src/squid-app.ts`: it defaults your home directory as the watch root, sets up the platform domain socket or Windows named pipe, launches the release panel binary, and connects the ambient sensory loop.

---

## 🎛️ The Native Desktop Experience

Squid delivers a native desktop UI built in **Rust with Slint 1.17** that is lightweight, snappy, and respectful of system resources.

```
┌─────────────────────────────────────────────────────────────┐
│ 🦑 SQUID                                     [_] [□] [✕]    │
├─────────────────────────────────────────────────────────────┤
│  STATUS: Active · Watching /home/user/projects              │
│  Agent: Idle (Observed 14 events across 2 episodes)         │
├─────────────────────────────────────────────────────────────┤
│  [ACTIVITY EVIDENCE]                                        │
│  • VS Code: saved src/api-client.ts (2m ago)                │
│  • Terminal: `bun test` exited with code 0 (1m ago)         │
│                                                             │
│  [TRIGGER LEDGER]                                           │
│  Triggered: 3  |  Duplicate: 8  |  Excluded: 1  | Coalesced: 4│
├─────────────────────────────────────────────────────────────┤
│  [LLM REQUEST DEBUGGER]                                     │
│  #12 · deepseek-chat · 200 OK · 1,420ms · [View Preview]    │
├─────────────────────────────────────────────────────────────┤
│  [ SOURCES ]  [ SETTINGS ]  [ PAUSE RECORDING ]             │
└─────────────────────────────────────────────────────────────┘
```

- **Ambient Status Card**: Shows what Squid is watching right now, current activity highlights, and agent status (Idle, Thinking, or Acting).
- **System Tray Keepalive**: Closing the window puts it away to the system tray rather than killing the process. Right-click the tray icon to quickly Pause/Resume, Open Panel, or Quit.
- **LLM Request Debugger & Preview**: Inspect outbound LLM calls, latencies, status codes, and click **Details** to open a scrubbed, sanitized prompt preview modal (`preview`) to see exactly what context was sent.
- **Live Trigger Ledger**: Tracks decisions and filters in real-time (`triggered`, `duplicate`, `excluded`, `coalesced`).
- **Confirmation Modals**: Consequential actions prompt an explicit confirmation modal before executing. You can approve, decline, or defer ("Later").

---

## ⚙️ Configuration Reference

Squid can be configured via the **SETTINGS** tab in the desktop UI, through JSON configuration files (`~/.config/squid/settings.json`), or using environment variables.

### General & Runtime
| Environment Variable | Config Key | Default | Description |
|---|---|---|---|
| `SQUID_WATCH_ROOT` | `watchRoot` | `$HOME` | Directory watched by the filesystem sensor. |
| `SQUID_PANEL_SOCKET` | `panelEndpoint` | Auto | IPC endpoint (`/tmp/squid-panel.sock` or `\\.\pipe\squid-panel`). |
| `SQUID_NOTIFY` | `notify` | `desktop` | Notification mode (`desktop` or `off`). Only alerts when the agent acts. |

### Model & Decision Curation
| Environment Variable | Config Key | Default | Description |
|---|---|---|---|
| `SQUID_MODEL_PROVIDER` | `modelProvider` | `default` | Provider name stored in Pi's `models.json` / `auth.json`. |
| `SQUID_ATTENTION_WINDOW_MINUTES` | `attentionWindowMinutes` | `15` | Minutes of observation history preserved before sliding-window pruning. |
| `SQUID_DECISION_CURATOR` | `decisionCuration` | `on` | `on` / `off`. Enables fast classifier gate before LLM turns. Fails open on errors. |
| `SQUID_DECISION_BASE_URL` | `decisionCuratorBaseUrl` | Chat base URL | `/v1/systemone` endpoint for decision curation (e.g. TypeSafe Jev or local Kev). |
| `SQUID_DECISION_MODEL` | `decisionCuratorModel` | Auto | Decision model id (`jev-latest`, `openjev`, `kev-4b`, etc.). |
| `SQUID_DECISION_THRESHOLD` | `decisionCuratorThreshold` | `0.5` | Sensitivity threshold between `0.0` and `1.0`. |

### Sensors & Privacy Controls
| Environment Variable | Config Key | Default | Description |
|---|---|---|---|
| `SQUID_SCREEN_READER` | `screenReaderBackend` | Host native | Screen reader backend: UI Automation (Windows), `xdotool` (Linux), `synthetic` (test). |
| `SQUID_SCREEN_POLL_MS` | `screenPollIntervalMs` | `1000` | Screen text polling frequency in milliseconds. |
| `SQUID_TERMINAL` | `terminalSource` | `off` | Enable terminal shell integration (`fifo`). |
| `SQUID_TERMINAL_FIFO` | `terminalSourcePath` | — | Path to terminal FIFO or Windows Named Pipe (`\\.\pipe\squid-term`). |
| `SQUID_EDITOR_SAVES` | `editorSaveSource` | `off` | Enable editor save tracking (`fifo`). |
| `SQUID_EDITOR_FIFO` | `editorSavePath` | — | Path to editor save FIFO or Windows Named Pipe (`\\.\pipe\squid-editor`). |
| `SQUID_BROWSER` | `browserSource` | `off` | Enable browser active tab tracking (`darwin` on macOS, or `synthetic`). |
| `SQUID_CONTROL` | `captureGateBackend` | `off` | Enable pause/resume gate (`fifo`). |
| `SQUID_CONTROL_FIFO` | `captureGatePath` | — | Path to pause gate FIFO or Windows Named Pipe (`\\.\pipe\squid-control`). |
| `SQUID_EXCLUDE` | `excludeApplications` | — | Comma-separated list of application names to exclude (e.g. `1Password,Vault`). |
| `SQUID_RETENTION_HOURS`| `retentionHours` | `off` | Hours of activity events retained in SQLite at startup. |

---

## 🛠️ Under the Hood: Architecture & Philosophy

For engineers, contributors, and curious hackers, Squid is built with rigorous local-first and deterministic engineering principles.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Sensory Ingress Adapters                        │
│   Filesystem    Screen Text     Terminal Hook     Editor Saves         │
└───────┬──────────────┬───────────────┬─────────────────┬───────────────┘
        │              │               │                 │
        ▼              ▼               ▼                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│             Capture Policy (Exclusion & Credential Redaction)          │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│           Append-Only Event Store (SQLite WAL / In-Memory)             │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│          Deterministic Episode Segmentation & World State              │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│    Context Filter: Attention Window (15m) + Decision Curator           │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     Resident Agent (Pi Session)                        │
│           Judgement, Tool Invocations, Persistent History              │
└───────┬──────────────────────────┬─────────────────────────────┬───────┘
        │                          │                             │
        ▼                          ▼                             ▼
┌───────────────┐          ┌───────────────┐             ┌───────────────┐
│ Desktop Toast │          │ Confirmation  │             │ Slint Panel & │
│ (Mutations)   │          │ Dialog Modal  │             │ System Tray   │
└───────────────┘          └───────────────┘             └───────────────┘
```

### 1. Ingress Boundary & Credential Redaction
All events enter via [`src/capture-policy.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-cf8f03cb/src/capture-policy.ts). `RedactingCapturePolicy` deterministically scrubs API keys, AWS tokens, GitHub credentials, PEM blocks, and passwords before anything touches SQLite or memory. `ExcludingCapturePolicy` halts observation whenever blacklisted apps take the foreground.

### 2. Append-Only SQLite Event Store & Stable Ordering
Events are stored in SQLite using WAL mode with `synchronous = NORMAL` ([`src/sqlite-event-store.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-cf8f03cb/src/sqlite-event-store.ts)). Events have canonical monotonic ordering ([`src/chronicle-ordering.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-cf8f03cb/src/chronicle-ordering.ts)), making offline replay, crash recovery, and state reconstruction 100% deterministic.

### 3. Episodic World State
Time gaps between bursts of activity delineate discrete episodes ([`src/episode.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-cf8f03cb/src/episode.ts)). Raw events are reduced into a compact `WorldState` snapshot ([`src/world-state.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-cf8f03cb/src/world-state.ts)). The agent inspects this world state rather than querying raw event logs.

### 4. Attention Sliding Window & Fast Decision Curation
- **Attention Window** ([`src/attention-window-extension.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-cf8f03cb/src/attention-window-extension.ts)): Before each turn, observations older than `attentionWindowMinutes` (default 15m) are trimmed from the working context, preventing context exhaustion over days of uptime.
- **Decision Curator** ([`src/decision-curator-extension.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-cf8f03cb/src/decision-curator-extension.ts)): Uses a lightweight classifier (`/v1/systemone` via Jev or Kev) to filter non-essential turns. Fails open on timeout or network error so the agent never hangs.

### 5. Unified Cross-Platform Transport
[`src/endpoint-transport.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-cf8f03cb/src/endpoint-transport.ts) provides a uniform abstraction across operating systems:
- **Unix**: Domain sockets for IPC, FIFOs (`mkfifo`) for shell and editor hooks.
- **Windows**: Full support for Named Pipes (`\\.\pipe\squid-panel`, `\\.\pipe\squid-control`), powered by `Bun.listen({ unix })`.

### 6. Clean Shutdown Sequence
`stop()` executes in strict reverse dependency order:
1. Stop sensory sources (preventing late events during teardown).
2. Drain and complete in-flight agent turns.
3. Dispose resident agent session.
4. Close SQLite store and persist final state.

---

## 🧪 Developer Commands & Testing

Squid features an extensive, offline-first automated test suite:

```bash
# Typecheck TypeScript (src/ and tests/ separately)
bun run typecheck

# Run offline unit and integration test suite (810+ tests)
bun test

# Build TypeScript output
bun run build

# Run end-to-end automated UI smoke test
cargo build --release --manifest-path ui/Cargo.toml
bun run ui:smoke
```

### Visual UI Smoke Harness (`bun run ui:smoke`)
The smoke harness validates that the compiled `squid-ui` binary renders and behaves correctly without human intervention:
- **On Linux**: Spawns an isolated `Xvfb` display, simulates mouse clicks with `xdotool`, and inspects AT-SPI accessibility trees over an isolated private D-Bus session.
- **On Windows**: Uses Windows UI Automation to locate controls by accessible name, executes native clicks, and verifies button hit-testing and status card updates.

---

## 🔒 Security & Privacy Guarantees

1. **100% Offline Core**: Ingestion, state projection, database storage, and the test suite run completely offline with zero telemetry.
2. **Credential Redaction**: Passwords, API tokens, and authorization headers are expunged before persistence.
3. **Application Exclusion**: Sensitive applications (password managers, banking sites) are dropped immediately at the ingress.
4. **Instant Pause Gate**: You can pause and resume recording at any time via the UI, a shell shortcut, or a pipe write.
5. **Human in the Loop**: Sensitive actions require explicit confirmation through modal dialogs.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
