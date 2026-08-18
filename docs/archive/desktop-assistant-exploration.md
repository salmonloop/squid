# Archived: Capability-First Always-On Desktop AI Assistant

> **Historical exploration draft. Not an execution plan.**
>
> This predates the current implementation and conflicts with it. It assumes a
> Rust workspace, DXGI capture, Direct2D overlay, and a four-week path to full
> desktop capability. Squid is instead built as a Bun/TypeScript cognitive core
> (validated Chronicle → world state → prediction → replay evaluation), with a
> native host deferred until an integrity-first pipeline and a real evaluation
> baseline exist. The language and API choices below were never validated by a
> spike; treat them as untested assumptions.
>
> Kept for the module decomposition and latency-budget reasoning, which remain
> useful input to a future native-host design. See `README.md` for what actually
> exists and the plan file for the current phase order.

## 1. Module Breakdown (Windows-First)

| Module | Responsibility |
|--------|----------------|
| **`sentry`** | Global low-latency capture: screen pixels (DxGI), window handles (Win32), UIA tree, browser DOM (CDP), IDE events (LSP/editor plugins). Emits structured `CaptureFrame` events. |
| **`orchestrator`** | Manages capture scheduling, dedup, priority queuing, and dispatch to action pipeline. |
| **`interpreter`** | Maps captured context to intent; produces `ActionPlan` (API calls, UIA interactions, visual fallback). |
| **`executor`** | Executes actions in priority: 1) Native APIs (Win32/COM), 2) UIA patterns, 3) visual CV/OCR fallback. |
| **`overlay`** | Renders non-intrusive HUD (Direct2D) for status, text insertion candidates, and confirmation prompts. |
| **`bridge`** | Bi‑directional IPC to IDE (VS Code plugin, JetBrains plugin) for DOM/editor event injection and command responses. |

## 2. Interface Events (Strongly Typed)

```typescript
interface CaptureFrame {
  timestamp: number;          // high-res
  windowHandle?: string;
  uiaRoot?: UIANode;
  screenshot?: ImageData;     // only on change or demand
  domSnapshot?: DOMNode[];    // from CDP
  editorContext?: EditorState; // cursor, selections, open file
}

interface ActionPlan {
  id: string;
  priority: 'immediate' | 'deferred';
  steps: ActionStep[];
}

type ActionStep =
  | { type: 'api'; target: string; params: Record<string, any> }
  | { type: 'uia'; selector: UIAQuery; action: 'click' | 'setText' | 'scroll' }
  | { type: 'visual'; roi: Rect; action: 'click' | 'type'; text?: string };
```

## 3. Latency Budgets (99th %ile)

- **Capture → Frame ready**: ≤ 16 ms (60 fps) for screen, ≤ 50 ms for UIA/ DOM.
- **Interpretation → ActionPlan**: ≤ 200 ms (local SLM/rule engine).
- **Execution (API)**: ≤ 50 ms.
- **Execution (UIA)**: ≤ 150 ms.
- **Execution (Visual fallback)**: ≤ 500 ms (with caching).
- **Overlay render**: ≤ 8 ms.

Total end‑to‑end for common actions (e.g., click UI element) ≤ 400 ms.

## 4. Test Gates (per Pull Request)

| Gate | Threshold |
|------|-----------|
| Unit test coverage (critical modules) | ≥ 80% |
| Integration: capture → execute on Notepad/Chrome/VS Code | 100% pass |
| Latency regression (against baseline) | < 10% increase |
| Memory leak (30‑min soak) | < 5 MB growth |
| CPU idle (no capture) | < 1% |
| CPU active (capture + inference) | < 15% |

## 5. Dependency Families (Stable, no fabricated versions)

- **Win32/UIA**: `windows-rs` (WinRT interop), `uia-rs` (community) or `windows` crate with `UI_Automation` feature.
- **Screen capture**: `dxgcap` (DirectX) or `screen-capture-rs` (bindings).
- **Overlay**: `winit` + `d2d` (Direct2D via `windows-rs`).
- **Browser DOM**: `chrome-devtools-protocol` (via WebSocket).
- **IDE events**: LSP client (e.g., `lsp-types` + `jsonrpc`) + plugin-specific WebSocket/named pipes.
- **Visual fallback**: `tesseract` (OCR) + `opencv` (template matching) – both with Rust bindings.
- **IPC**: `interprocess` (named pipes) or `zeromq`.
- **Async runtime**: `tokio`.
- **Serialisation**: `serde` + `rmp` (MessagePack).

## 6. macOS / Linux Deferral

- **macOS**: use `CGImage` capture, `AXUI` for UIA, `Metal` overlay – deferred to phase 2.
- **Linux**: use `X11`/`Wayland` (pipewire for screen), `AT‑SPI` for accessibility – deferred to phase 3.
- **Cross‑platform shims**: abstract `CaptureBackend`, `UIABackend`, `OverlayBackend` – implement stubs that log "unimplemented" on non‑Windows.

## 7. Execution Flow (Sequential)

1. `sentry` wakes on timer/interrupt → captures minimal changed delta.
2. Frame pushed to `orchestrator` queue (prioritised by window focus / user activity).
3. `interpreter` runs against latest frame → produces `ActionPlan` (or no‑op).
4. `executor` tries API → if fails, UIA query → if fails, visual fallback.
5. On success, `overlay` shows transient feedback (green check / text preview). On failure, shows graceful fallback prompt.
6. Text insertion (e.g., code snippet) sent via `bridge` to active editor (or UIA setText as backup).

## 8. Initial Empty Project Setup (No Code)

- Create Rust workspace with subcrates: `sentry`, `orchestrator`, `interpreter`, `executor`, `overlay`, `bridge`, `common`.
- Add CI (GitHub Actions) with Windows runner, gates above.
- Add integration test harness that mocks Windows desktop environment (using `test-double` for UIA/screen).
- Add performance benchmark framework (`criterion`).

## 9. Milestones (4 weeks)

- **Week 1**: capture (screen + UIA for top‑level windows) + overlay skeleton.
- **Week 2**: execution (API → UIA) + simple text insertion into Notepad.
- **Week 3**: browser DOM integration (Chrome) + IDE events (VS Code plugin).
- **Week 4**: visual fallback + all latency gates passing + integration tests.
