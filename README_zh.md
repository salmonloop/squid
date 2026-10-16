# 🦑 Squid — 全天候桌面级自主 AI 智能体

<p align="center">
  <strong>具有全天候感知与持续记忆的自主桌面伴侣</strong><br>
  <em>静默感知工作区 · 深度理解上下文 · 关键时刻自主决断 · 一切全由你掌控</em>
</p>

<p align="center">
  <a href="README.md"><strong>English</strong></a> •
  <a href="README_zh.md"><strong>简体中文</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun%20%3E%3D%201.4.2-F472B6?logo=bun&logoColor=white" alt="Bun">
  <img src="https://img.shields.io/badge/GUI-Rust%20%2B%20Slint%201.17-DEA584?logo=rust&logoColor=white" alt="Slint">
  <img src="https://img.shields.io/badge/%E6%93%8D%E4%BD%9C%E7%B3%BB%E7%BB%9F-Windows%20%7C%20Linux%20%7C%20macOS-blue" alt="Platform">
  <img src="https://img.shields.io/badge/agent-Pi%20Coding%20Agent-8A2BE2" alt="Pi Agent">
  <img src="https://img.shields.io/badge/%E6%B5%8B%E8%AF%95-810%2B%20%E9%80%9A%E8%BF%87%20(%E5%85%A8%E7%A6%BB%E7%BA%BF)-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-MIT-green" alt="License">
</p>

---

## 💡 为什么需要 Squid？

现在的绝大多数 AI 编程与桌面助手都是**被动的对话框**：
你在终端跑测试遇到报错，必须手动选中复制错误堆栈，切到浏览器或聊天软件，第十次向它解释项目架构，再小心翼翼地提示它“帮我看看这是为什么”。

**Squid 彻底打破了这种割裂的体验。**

Squid 是一个**长驻本地、具备自主感知能力的桌面 AI 伴侣**，基于 [Pi Agent 运行时](https://github.com/earendil-works/pi-ai) 构建。它不再被动等待你喂送上下文，而是在后台静默、轻量地感知你的日常开发工作：
- 你在编辑器中保存的项目代码文件；
- 你在终端里执行的各种命令与其退出状态码；
- 当前桌面前台的活跃窗口、聚焦控件与选中文本；
- 你在浏览器里正在查阅的 API 文档或 GitHub Issue 讨论。

Squid 将这些持续的感官信号聚合为**连贯的场景化世界状态（Episodic World State）**。当遇到错误或需要帮助时，Squid 已经知晓来龙去脉，无需你做任何复制粘贴即可自主给出诊断或辅助执行 —— 并且全过程严格受你掌控。

---

## 🌟 日常使用场景（A Day with Squid）

### 1. ⚡ 终端报错？告别手动复制长篇堆栈
你在终端运行 `cargo test`、`pytest` 或 `npm run build`，测试失败并抛出大量报错。
> **传统做法**：在终端里长按鼠标选中、复制、切窗口粘贴给 AI、敲键盘问“为什么挂了”。
>
> **Squid 体验**：Squid 通过终端钩子实时感知到该命令失败及非零退出码，并自动关联你刚刚在编辑器中修改的文件。当你需要时，它已理清根本原因，甚至直接准备好修改补丁。

### 2. 🔍 跨窗口联动：洞悉你的真实上下文
你在浏览器里查阅一份开源框架的最新接口文档，切回 VS Code 开始实现具体功能并保存。
> **Squid 体验**：Squid 能同时捕获你刚看的文档网页 URL 和保存的代码。在提供代码建议或解答疑难时，它直接结合你查阅的参考资料进行回答，不再盲目瞎猜。

### 3. 🔕 绝不打扰：智能静默通知
谁都不想要一个每隔三秒就跳出来刷存在感的话痨助手。
> **Squid 体验**：Squid 拥有明确的“无事不扰”哲学。它通过系统通知中心（Linux `notify-send`、Windows `Shell_NotifyIcon` 气泡、macOS `osascript`）提醒你，且**仅当智能体实际执行了产生影响的操作（如修改了文件或执行了修复命令）时才会弹出桌面通知**。若它只是在阅读、思考或判定无需干预，系统保持 100% 静默。

### 4. 🛡️ 智能隐私遮罩：遇到密码自动“闭眼”
你需要切到密码管理器查找数据库密钥，或者打开网银查看账单。
> **Squid 体验**：Squid 自动检测当前前台窗口。一旦进入敏感软件（如 `1Password`、`Bitwarden`、`KeePassXC` 或自定义黑名单），屏幕与文字采集立即自动挂起。各类密码、API Token 在进入数据库前就已被底层正则表达式彻底清洗，绝不落盘。

---

## 🚀 极速上手

### 方式 A：预编译版本解压即用（普通用户首选）

无需安装复杂的编译器与环境，60 秒内快速跑起来：

1. 前往 [GitHub Releases](https://github.com/salmonloop/squid/releases) 下载适合你系统的发布包：
   - **Linux**：`squid-x86_64-unknown-linux-gnu.zip`
   - **Windows**：`squid-x86_64-pc-windows-msvc.zip`
2. 解压压缩包，你会得到两个核心程序：
   - `squid-ui`：高性能原生桌面面板（双击直接运行）。
   - `squid`：后台感知与决策核心（由 `squid-ui` 自动托管）。
3. 启动 `squid-ui`：
   - 桌面将弹出精致的 Fluent 风格控制面板，并在系统托盘常驻图标。
   - 首次使用时，点击面板下方的 **SETTINGS**，配置你常用的大模型提供商：
     - **云端主流模型**：OpenAI、Anthropic Claude、DeepSeek、OpenRouter 等。
     - **本地私有化模型**：支持 [Ollama](https://ollama.ai/)、vLLM、LM Studio 或任意兼容 OpenAI 的本地服务接口。

---

### 方式 B：从源码编译与调试（开发者与极客）

#### 环境要求
- [Bun](https://bun.sh) `1.4.2` 或更高版本
- [Rust](https://rustup.rs/)（Cargo 1.80+）

```bash
# 1. 克隆代码仓库并安装依赖
git clone https://github.com/salmonloop/squid.git
cd squid
bun install --frozen-lockfile

# 2. 编译原生 Slint UI 面板
cargo build --release --manifest-path ui/Cargo.toml

# 3. 启动应用
bun run start
```

`bun run start` 将执行 `src/squid-app.ts`：自动将 `$HOME` 作为监听根目录，建立跨平台通信管道（Linux/macOS 为 Unix Domain Socket，Windows 为 Named Pipe），拉起 UI 面板并启动全套感知系统。

---

## 🎛️ 原生桌面交互体验

Squid 采用 **Rust + Slint 1.17** 打造原生桌面客户端，秒级冷启，极度节省内存与 CPU 开销。

```
┌─────────────────────────────────────────────────────────────┐
│ 🦑 SQUID                                     [_] [□] [✕]    │
├─────────────────────────────────────────────────────────────┤
│  STATUS: Active · 正在监听 /home/user/projects              │
│  智能体状态: 空闲 (在 2 个时间段内累计感知 14 个事件)       │
├─────────────────────────────────────────────────────────────┤
│  [活动证据 (EVIDENCE)]                                      │
│  • VS Code: 保存了 src/api-client.ts (2分钟前)              │
│  • 终端: `bun test` 执行完毕，状态码 0 (1分钟前)             │
│                                                             │
│  [触发账本 (TRIGGER LEDGER)]                                │
│  触发思考: 3  |  去重忽略: 8  |  隐私排除: 1  | 防抖合并: 4 │
├─────────────────────────────────────────────────────────────┤
│  [大模型请求调试器 (LLM DEBUGGER)]                          │
│  #12 · deepseek-chat · 200 OK · 1,420ms · [查看脱敏预览]    │
├─────────────────────────────────────────────────────────────┤
│  [ 感知源开关 ]  [ 系统设置 ]  [ 暂停感知记录 ]             │
└─────────────────────────────────────────────────────────────┘
```

- **实时状态卡片**：直观展示 Squid 当前在观察什么，以及智能体当前是空闲、思考中还是正在执行任务。
- **系统托盘常驻守护**：点击窗口关闭按钮只是将其最小化至托盘，后台持续守护不中断。右键托盘图标可快速暂停/恢复、调出面板或退出。
- **LLM 请求调试与脱敏预览**：透明展示每次向模型发出的请求耗时、状态码与字符量，支持点击查看脱敏后的 Prompt 预览（`preview`），确认发送内容无敏感信息。
- **实时触发账本**：透明展现决策过滤过程（触发思考、重复忽略、隐私屏蔽、短频合并）。
- **敏感操作人工确认**：智能体执行潜在影响操作前必须经过对话框确认，支持允许、拒绝或稍后处理。

---

## ⚙️ 完整配置参考

所有设置均可在 `squid-ui` 的 **SETTINGS** 选项卡中图形化配置，亦可保存在 `~/.config/squid/settings.json` 或通过环境变量注入。

### 运行时基础配置
| 环境变量 | 配置键名 | 默认值 | 说明 |
|---|---|---|---|
| `SQUID_WATCH_ROOT` | `watchRoot` | `$HOME` | 文件系统感知器监听的根目录绝对路径。 |
| `SQUID_PANEL_SOCKET` | `panelEndpoint` | 自动匹配 | IPC 通信端点（Linux 为 `/tmp/squid-panel.sock`，Windows 为 `\\.\pipe\squid-panel`）。 |
| `SQUID_NOTIFY` | `notify` | `desktop` | 桌面通知通道（`desktop` 或 `off`）。仅在智能体实际动作时弹出。 |

### 模型与上下文决策
| 环境变量 | 配置键名 | 默认值 | 说明 |
|---|---|---|---|
| `SQUID_MODEL_PROVIDER` | `modelProvider` | `default` | 在 Pi 的 `models.json` / `auth.json` 中登记的提供商名称。 |
| `SQUID_ATTENTION_WINDOW_MINUTES` | `attentionWindowMinutes` | `15` | 上下文注意力保留窗口（分钟），超时历史观测自动修剪。 |
| `SQUID_DECISION_CURATOR` | `decisionCuration` | `on` | 决策模型裁剪开关（`on` 或 `off`），异常时自动降级放行。 |
| `SQUID_DECISION_BASE_URL` | `decisionCuratorBaseUrl` | 聊天模型 Base URL | 决策微模型 `/v1/systemone` 端点（支持 TypeSafe Jev 或本地 Kev）。 |
| `SQUID_DECISION_MODEL` | `decisionCuratorModel` | 自动推导 | 决策模型标识符（如 `jev-latest`、`openjev`、`kev-4b`）。 |
| `SQUID_DECISION_THRESHOLD` | `decisionCuratorThreshold` | `0.5` | 筛选保留阈值（`0.0` 到 `1.0`，越高裁剪越激进）。 |

### 感知源与安全控制
| 环境变量 | 配置键名 | 默认值 | 说明 |
|---|---|---|---|
| `SQUID_SCREEN_READER` | `screenReaderBackend` | 系统原生 | 屏幕捕获后端：原生（Windows UIA / Linux `xdotool`），或测试合成 `synthetic`。 |
| `SQUID_SCREEN_POLL_MS` | `screenPollIntervalMs` | `1000` | 屏幕状态轮询采样周期（毫秒）。 |
| `SQUID_TERMINAL` | `terminalSource` | `off` | 终端命令感知开关（`fifo`）。 |
| `SQUID_TERMINAL_FIFO` | `terminalSourcePath` | — | 终端钩子写入路径（Unix 为 FIFO，Windows 为命名管道如 `\\.\pipe\squid-term`）。 |
| `SQUID_EDITOR_SAVES` | `editorSaveSource` | `off` | 编辑器保存感知开关（`fifo`）。 |
| `SQUID_EDITOR_FIFO` | `editorSavePath` | — | 编辑器保存钩子写入路径（或 Windows 命名管道 `\\.\pipe\squid-editor`）。 |
| `SQUID_BROWSER` | `browserSource` | `off` | 浏览器标签感知开关（macOS 下为 `darwin`，其他平台为 `synthetic`）。 |
| `SQUID_CONTROL` | `captureGateBackend` | `off` | 捕获门控开关（`fifo`），支持通过管道发送 pause/resume 命令。 |
| `SQUID_CONTROL_FIFO` | `captureGatePath` | — | 门控命令路径（或 Windows 命名管道 `\\.\pipe\squid-control`）。 |
| `SQUID_EXCLUDE` | `excludeApplications` | — | 隐私屏蔽的应用名单，逗号分隔（例如 `1Password,Bitwarden`）。 |
| `SQUID_RETENTION_HOURS`| `retentionHours` | `off` | 启动时自动清理超过该时长（小时）的历史事件记录。 |

---

## 🛠️ 深度架构与实现细节（Under the Hood）

针对开发者与系统贡献者，Squid 遵循严谨的本地优先、确定性与高可靠性架构：

```
┌────────────────────────────────────────────────────────────────────────┐
│                              多维度感官接入层                           │
│   文件系统监听    屏幕/无障碍文字     终端执行钩子     编辑器保存通知   │
└───────┬──────────────┬───────────────┬─────────────────┬───────────────┘
        │              │               │                 │
        ▼              ▼               ▼                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   捕获安全策略 (应用屏蔽与凭据脱敏清洗)                │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│             追加式时序事件存储 (SQLite WAL / 内存测试实现)             │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 确定性场景时序切片与世界状态聚合投影                   │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│        上下文优化：15分钟注意力滑动窗口 + 毫秒级决策模型筛选           │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       常驻长效智能体 (Pi 会话)                         │
│               自主决策分析、工具调用执行、连贯上下文审计               │
└───────┬──────────────────────────┬─────────────────────────────┬───────┘
        │                          │                             │
        ▼                          ▼                             ▼
┌───────────────┐          ┌───────────────┐             ┌───────────────┐
│ 系统桌面通知  │          │ 操作确认对话框│             │ Slint 原生界面│
│(执行变更时触发)│         │ (高风险动作)  │             │ 与系统常驻托盘│
└───────────────┘          └───────────────┘             └───────────────┘
```

### 1. 入口级敏感凭据清洗与应用过滤
所有事件统一进入 [`src/capture-policy.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-cf8f03cb/src/capture-policy.ts)。`RedactingCapturePolicy` 在数据接触存储前，确定性抹除 API Key、AWS 访问凭证、GitHub 令牌、PEM 私钥及密码。`ExcludingCapturePolicy` 在黑名单应用处于前台时瞬间熔断所有捕获。

### 2. 追加式 SQLite WAL 事件存储与回放顺序
事件通过 WAL 模式的 SQLite 存储（`synchronous = NORMAL`，见 [`src/sqlite-event-store.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-cf8f03cb/src/sqlite-event-store.ts)）。通过规范化排序契约（[`src/chronicle-ordering.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-cf8f03cb/src/chronicle-ordering.ts)），离线重放、崩溃恢复与状态还原具有 100% 确定性。

### 3. 场景化世界状态归约 (Episodic World State)
依据活动事件的时间停顿自动切分独立场景（Episode，见 [`src/episode.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-cf8f03cb/src/episode.ts)）。原始时序事件由无副作用的归约器聚合为宏观的 `WorldState` 快照（[`src/world-state.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-cf8f03cb/src/world-state.ts)）。智能体每次决策只需审阅宏观世界状态，避免遍历海量日志。

### 4. 注意力滑动窗口与亚秒级决策微模型
- **注意力滑动窗口**（[`src/attention-window-extension.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-cf8f03cb/src/attention-window-extension.ts)）：每次调用模型前自动清理超过时效（默认 15 分钟）的旧观测轨迹，杜绝 Token 无限增长。
- **决策裁剪微模型**（[`src/decision-curator-extension.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-cf8f03cb/src/decision-curator-extension.ts)）：利用 `/v1/systemone` 接口（Jev / Kev）毫秒级过滤无效轮次。遇网络错误自动放行（Fail-Open），不阻断主流程。

### 5. 跨平台统一传输适配
[`src/endpoint-transport.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-cf8f03cb/src/endpoint-transport.ts) 统一了操作系统间的管道差异：
- **Unix 系统**：使用文件域套接字进行 IPC，使用标准 FIFO（`mkfifo`）接入 Shell 与编辑器钩子。
- **Windows 系统**：原生支持命名管道（`\\.\pipe\squid-panel`、`\\.\pipe\squid-control`），底层由 `Bun.listen({ unix })` 驱动。

### 6. 严谨的关机与注销时序
`stop()` 严格依依赖反序退出：
1. 停止各类感官源（防止卸载过程中产生残余事件）；
2. 等待并排干正在执行中的智能体轮次；
3. 注销长驻智能体会话并释放资源；
4. 关闭 SQLite 存储并保存最终状态。

---

## 🧪 开发者命令与自动化测试

Squid 拥有全离线的完备自动化测试体系：

```bash
# 类型检查（分别覆盖 src/ 与 tests/）
bun run typecheck

# 运行全套离线测试（810+ 离线测试用例）
bun test

# 编译 TypeScript 代码
bun run build

# 运行自动化 UI 冒烟测试
cargo build --release --manifest-path ui/Cargo.toml
bun run ui:smoke
```

### 自动化 UI 冒烟测试 (`bun run ui:smoke`)
冒烟测试验证编译出的真实 `squid-ui` 二进制程序在无人工干预下的界面渲染与交互准确性：
- **在 Linux 环境下**：自动拉起独立的 `Xvfb` 虚拟显示器，通过 `xdotool` 触发系统级鼠标点击，并通过私有 D-Bus 校验 AT-SPI 无障碍树，截取窗口渲染截图。
- **在 Windows 环境下**：利用 Windows 原生 UI Automation 定位指定无障碍名称的控件，触发原生点击，验证命中测试与状态更新。

---

## 🔒 隐私与安全性保障

1. **核心链路完全离线可测**：事件收集、时序存储、世界状态归约以及 810+ 测试用例全部纯本地离线执行，无任何未经允许的外连请求。
2. **多层敏感凭据脱敏清洗**：所有进入系统的窗口标题、代码片段与终端命令必须通过 `RedactingCapturePolicy` 正则过滤，杜绝各类密码、Token 与密钥被写入磁盘。
3. **应用激活隐私熔断**：配置黑名单应用（如密码管理器、网银等）处于前台时，Squid 立即阻断一切屏幕采集。
4. **透明受控的暂停机制**：无论是通过面板界面的“暂停记录”按钮，还是通过命令向管道写入指令，随时可彻底切断外部感知。

---

## 📄 开源许可证

本项目基于 [MIT 许可证](LICENSE) 开源。
