# 🦑 Squid — 桌面级全天候个人自主 AI 智能体

<p align="center">
  <strong>具有全局感知与持续情境记忆的个人自主桌面伴侣</strong><br>
  <em>静默感知工作流 · 深度理解跨应用上下文 · 关键时刻主动补位 · 严守隐私尽在掌控</em>
</p>

<p align="center">
  <a href="README.md"><strong>English</strong></a> •
  <a href="README_zh.md"><strong>简体中文</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun%20%3E%3D%201.4.2-F472B6?logo=bun&logoColor=white" alt="Bun">
  <img src="https://img.shields.io/badge/GUI-Rust%20%2B%20Slint%201.17-DEA584?logo=rust&logoColor=white" alt="Slint">
  <img src="https://img.shields.io/badge/%E6%93%8D%E4%BD%9C%E7%B3%BB%E7%BB%9F-Windows%20%7C%20Linux%20%7C%20macOS-blue" alt="Platform">
  <img src="https://img.shields.io/badge/agent-%E4%B8%AA%E4%BA%BA%E8%87%AA%E4%B8%BB%E6%99%BA%E8%83%BD%E4%BD%93-8A2BE2" alt="个人自主智能体">
  <img src="https://img.shields.io/badge/%E6%B5%8B%E8%AF%95-810%2B%20%E9%80%9A%E8%BF%87%20(%E5%85%A8%E7%A6%BB%E7%BA%BF)-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-MIT-green" alt="License">
</p>

---

## 💡 为什么需要 Squid？

现在的绝大多数 AI 工具本质上依然是**被动的聊天框**：
无论你是在分析业务数据、跨软件核对交付物、处理办公文档，还是运行自动化脚本和工程流水线，每当需要 AI 协助时，你都不得不打断当前的心流——在不同应用窗口间来回切屏、截图、手动复制堆栈日志或需求背景，反复向对话框解释“我刚才在做什么”。

**Squid 彻底打破了这种被动与割裂的体验。**

Squid 是一个**长驻本地、具备全局感知与持续情境记忆的个人主动桌面智能体（Personal Autonomous Desktop Agent）**，基于 [Pi Agent 运行时](https://github.com/earendil-works/pi-ai) 构建。它**不是一个局限于写代码的 coding agent**，而是一个面向**通用工程任务、日常数字化工作与个人生活**的随行助手。它在后台以极轻的资源开销静默感知你的电脑活动：
- **工作文档与资料沉淀**：你在本地工作区创建、整理或保存的各类文档、报表、方案方案、设计素材与配置文件；
- **任务脚本与工程流水线**：你在终端或后台运行的数据批处理、自动化脚本、数据同步与日常工具命令及其执行状态；
- **桌面应用与交互上下文**：当前桌面前台的活跃应用窗口、焦点控件与输入状态，以及屏幕上正在查阅的关键内容；
- **网络调研与业务系统**：你在浏览器里查阅的项目看板（Jira、Linear、飞书、Notion 等）、行业资料、规范文档或业务后台。

Squid 将这些持续的感官信号自动汇聚为**连贯的情境化世界状态（Episodic World State）**。当任务遇到异常、需要跨软件比对信息、或者有繁琐的多步骤任务需要推进时，Squid 已经理解来龙去脉，在关键时刻主动提供诊断洞察、资料串联或辅助执行——并且所有产生实际影响的操作都严格由你授权掌控。

---

## 🌟 日常使用场景（A Day with Squid）

### 1. 🔍 跨应用工作流穿透：需求调研与本地方案的无缝呼应
你在浏览器中查阅客户需求规范、项目管理工单或行业调研白皮书，随后切换到本地办公软件（如电子表格、Markdown、技术方案草案或配置文件）中着手整理与输出。
> **传统做法**：在浏览器与本地软件之间反复切屏，手动截取网页段落粘贴给 AI 聊天框，反复叮嘱“请根据刚才的需求帮我修改这份本地文件”。
>
> **Squid 体验**：Squid 自动捕获你刚阅读的网页背景与正在编辑的本地文件。当你需要梳理要点、交叉比对数据一致性或起草方案时，它已全面掌握全局上下文，无需重复喂送信息。

### 2. ⚡ 工程与自动化脚本故障：告别手动翻找日志与长篇堆栈
你在终端或后台运行数据清洗管道、Python 自动化脚本、文件格式批量转换工具或工程交付命令，命令突然报错中断。
> **传统做法**：手动滚动终端屏幕、肉眼搜寻报错行、复制冗长的异常堆栈给 AI，再费力解释“运行前我改动了什么文件”。
>
> **Squid 体验**：Squid 实时感知命令行执行与非零退出状态码，并自动关联你在运行前改动的文件与输入数据。它能立即理清根本原因，甚至直接准备好排查建议或修复重试方案。

### 3. 🧠 状态无缝找回：被打断后的多任务情境记忆
日常工作中，临时插入的紧急电话、会议或多任务切换常常打破你的思路。半小时后回到电脑前，脑海中一片空白：“我刚才做到哪一步了？”
> **传统做法**：在七八个打开的应用窗口、几十个浏览器标签页与文件夹里艰难翻找，回忆刚才的进度。
>
> **Squid 体验**：Squid 具备情境时序记忆（Episodic Memory）。只需看一眼面板或随时询问，它便能为你梳理离开前的操作脉络：“离开前你在对比两份采购清单的数据差异，并停留在差异分析文档的第二节”，助你瞬间找回心流。

### 4. 🗂️ 主动式个人辅助：资料归档与重复性劳动减负
日常从各类业务系统下载了大量报表、材料附件或导出的数据，散落在下载或临时文件夹中；或者经常有周期性的文件归类与格式转换需求。
> **传统做法**：定期花半小时手动新建文件夹、重命名文件、搬移归档。
>
> **Squid 体验**：Squid 能主动识别到特定工作目录下新落地的数据流与文件动态，结合你的历史工作习惯主动建议规范分类、归档整理方案，并在获得你确认后自动执行，将你从枯燥的杂务中解放出来。

### 5. 🛡️ 绝对克制与隐私守门人：“无事不扰”与敏感场景自动遮罩
谁都不想要一个每隔三秒就跳出来刷存在感、打乱思考的吵闹助手。
> **Squid 体验**：
> - **无事不扰（Permission to do nothing）**：Squid 只有在**真正执行了实质性改动（如更新了文件或执行了确认后的修复动作）**时才会通过系统通知中心（Linux `notify-send`、Windows `Shell_NotifyIcon`、macOS `osascript`）轻量提醒。日常阅读、感知与思考保持 100% 静默。
> - **智能隐私防护**：一旦切换到密码管理器（如 `1Password`、`Bitwarden`、`KeePassXC`）、网银页面或私密通讯软件，屏幕与文字感知瞬间挂起；敏感 Token 与密码在进入存储前被底层彻底脱敏清洗，绝不落盘。

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
│  STATUS: Active · 正在感知 /home/alex/workspace              │
│  智能体状态: 空闲 (在 2 个时间段内累计感知 14 个事件)       │
├─────────────────────────────────────────────────────────────┤
│  [活动证据 (ACTIVITY EVIDENCE)]                             │
│  • 浏览器: 正在查阅《Q3 业务规划与系统架构设计》 (2分钟前)  │
│  • 办公文档: 更新了 project-roadmap.xlsx (1分钟前)          │
│  • 终端: 自动化脚本 `sync-data.py` 执行完毕，退出码 0 (30秒前)│
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
| `SQUID_WATCH_ROOT` | `watchRoot` | `$HOME` | 文件系统感知器监听的根目录绝对路径（工作区或工程根目录）。 |
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
| `SQUID_TERMINAL` | `terminalSource` | `off` | 终端命令行与任务感知开关（`fifo`）。 |
| `SQUID_TERMINAL_FIFO` | `terminalSourcePath` | — | 终端钩子写入路径（Unix 为 FIFO，Windows 为命名管道如 `\\.\pipe\squid-term`）。 |
| `SQUID_EDITOR_SAVES` | `editorSaveSource` | `off` | 编辑器与文档保存感知开关（`fifo`）。 |
| `SQUID_EDITOR_FIFO` | `editorSavePath` | — | 编辑器保存钩子写入路径（或 Windows 命名管道 `\\.\pipe\squid-editor`）。 |
| `SQUID_BROWSER` | `browserSource` | `off` | 浏览器标签感知开关（macOS 下为 `darwin`，其他平台为 `synthetic`）。 |
| `SQUID_CONTROL` | `captureGateBackend` | `off` | 捕获门控开关（`fifo`），支持通过管道发送 pause/resume 命令。 |
| `SQUID_CONTROL_FIFO` | `captureGatePath` | — | 门控命令路径（或 Windows 命名管道 `\\.\pipe\squid-control`）。 |
| `SQUID_EXCLUDE` | `excludeApplications` | — | 隐私屏蔽的应用名单，逗号分隔（例如 `1Password,Bitwarden`）。 |
| `SQUID_RETENTION_HOURS`| `retentionHours` | `off` | 启动时自动清理超过该时长（小时）的历史事件记录。 |

---

## 🛠️ 深度架构与实现细节（Under the Hood）

针对系统开发者与架构贡献者，Squid 遵循严谨的本地优先、确定性与高可靠性设计：

```
┌────────────────────────────────────────────────────────────────────────┐
│                        多维度全天候感官接入层                          │
│   文件系统监听    屏幕/无障碍文字     终端与脚本执行     文档与文件保存   │
└───────┬──────────────┬───────────────┬──────────────────┬──────────────┘
        │              │               │                  │
        ▼              ▼               ▼                  ▼
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
│                 确定性场景时序切片与世界状态归约投影                   │
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
│(执行变更时触发)│          │ (高风险动作)  │             │ 与系统常驻托盘│
└───────────────┘          └───────────────┘             └───────────────┘
```

### 1. 入口级敏感凭据清洗与应用过滤
所有事件统一进入 [`src/capture-policy.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-b6252c25/src/capture-policy.ts)。`RedactingCapturePolicy` 在数据接触存储前，确定性抹除 API Key、AWS 访问凭证、GitHub 令牌、PEM 私钥及密码。`ExcludingCapturePolicy` 在黑名单应用处于前台时瞬间熔断所有捕获。

### 2. 追加式 SQLite WAL 事件存储与回放顺序
事件通过 WAL 模式的 SQLite 存储（`synchronous = NORMAL`，见 [`src/sqlite-event-store.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-b6252c25/src/sqlite-event-store.ts)）。通过规范化排序契约（[`src/chronicle-ordering.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-b6252c25/src/chronicle-ordering.ts)），离线重放、崩溃恢复与状态还原具有 100% 确定性。

### 3. 场景化世界状态归约 (Episodic World State)
依据活动事件的时间停顿自动切分独立场景（Episode，见 [`src/episode.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-b6252c25/src/episode.ts)）。原始时序事件由无副作用的归约器聚合为宏观的 `WorldState` 快照（[`src/world-state.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-b6252c25/src/world-state.ts)）。智能体每次决策只需审阅宏观世界状态，避免遍历海量日志。

### 4. 注意力滑动窗口与亚秒级决策微模型
- **注意力滑动窗口**（[`src/attention-window-extension.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-b6252c25/src/attention-window-extension.ts)）：每次调用模型前自动清理超过时效（默认 15 分钟）的旧观测轨迹，杜绝 Token 无限增长。
- **决策裁剪微模型**（[`src/decision-curator-extension.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-b6252c25/src/decision-curator-extension.ts)）：利用 `/v1/systemone` 接口（Jev / Kev）毫秒级过滤无效轮次。遇网络错误自动放行（Fail-Open），不中断主流水线。

### 5. 跨平台统一传输适配
[`src/endpoint-transport.ts`](file:///home/ubuntu/.t3/worktrees/squid/t3-b6252c25/src/endpoint-transport.ts) 统一了操作系统间的管道差异：
- **Unix 系统**：使用文件域套接字进行 IPC，使用标准 FIFO（`mkfifo`）接入 Shell 与编辑器钩子。
- **Windows 系统**：原生支持命名管道（`\\.\pipe\squid-panel`、`\\.\pipe\squid-control`），底层由 `Bun.listen({ unix })` 驱动。

### 6. 严谨的关机与注销时序
`stop()` 严格依依赖反序退出：
1. 停止各类感官源（防止卸载过程中产生残留事件）；
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
4. **透明受控的暂停机制**：无论通过面板界面的“暂停感知记录”按钮，还是通过命令行向管道写入指令，随时可彻底切断外部感知。
5. **人在回路（Human in the loop）**：产生实际改动的关键操作需经由人工交互确认框批准后方可执行。

---

## 📄 开源许可证

本项目基于 [MIT 许可证](LICENSE) 开源。
