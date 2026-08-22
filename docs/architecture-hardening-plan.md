# Squid 事实、认知与动作边界完善方案（冻结版 v5）

## 1. 目标

```text
ActivitySource -> EventStore -> WorldState -> Predictor
                                      -> ActionAdmission -> ActionPlan -> MCP
                                      -> BeliefState（本轮只建纯契约）
```

- EventStore 是事实权威；模型不能写事实。
- WorldState 是可重放的观测投影，不承担推理。
- Pi 是可替换 provider，不拥有任意工具或历史写权。
- 动作执行前必须重新核对最新事实。
- BeliefState 只保存带证据、会过期的推断；本轮不接实时决策。

## 2. 明确非目标

- 不全仓重命名 `WorldState`。
- 不删除 Pi 提示词中的四条兼容规则。语义 gate、shadow 权限和 belief producer 未完成前，不能只换 prompt。
- 不实现长期记忆、因果图、反事实、OCR、UI 或通用冲突引擎。
- 不持久化 belief，不让 belief 触发动作。
- 不声称外部副作用 exactly-once；只做原子 claim、防重复自动派发、不自动重试和人工对账诊断。

## 3. Phase A：文本上下文只有一个权威

### 数据模型

`FocusState` 本轮直接移除 prefix/suffix/selection/language，不做双写兼容。新唯一权威：

```ts
interface TextContextState {
  owner: { applicationId: string; windowTitle: string } | null;
  prefix: string;
  suffix: string;
  selection: string;
  language: string | null;
  sourceEventId: string;
  observedAt: string;
  observationOrdinal: number;
}

interface BrowserPageState {
  url: string;
  title: string;
  host: string;
  owner: { applicationId: string; windowTitle: string } | null;
  sourceEventId: string;
  observedAt: string;
  observationOrdinal: number;
}
```

`WorldState` 增加：

- `textContext: TextContextState | null`
- `currentBrowserPage: BrowserPageState | null`，不再把页面内容、owner 和证据拆成平行字段。
- canonical `BrowserNavigatedPayload` 必须显式携带 `owner`；协议解析边界将历史 schema-v1 中缺失的 owner 一次性规范成 `owner:null`，保证旧 EventStore 可读，但这类记录永不具备动作资格。reducer 仅在 owner 与当前 foreground 完全一致时保留，否则投影为 `owner:null`。禁止从任意旧 focus 猜页面归属。

`SemanticAction` 增加 `applicationId: string | null`，避免旧应用保存的文件在新应用里误触发测试。

### reducer 不变量

- 新 episode 清空 application/window/focus/text/browser；五分钟规则仍按相邻事件的 `occurredAt` 差值计算。
- 应用 ID 变化时清空 `activeWindow/focus/textContext/currentBrowserPage` 及页面证据；保留 episode 级 `recentFiles/recentActions/lastCommandOutcome`。
- `window_changed` 的应用或弱窗口身份（当前只有 title）变化时清空 focus/text/page；若和 active app 矛盾，将 active app 置 null，不伪造名称。
- 每个新的 `focus_changed` 都清空旧 textContext。没有稳定 elementId，就不能继承同窗口另一个输入框的文字。
- `text_context_changed`：有 focus 时绑定 owner；无 focus 时保留 `owner:null`，不制造假焦点。
- 页面/文本时序使用同一 episode 内的 `observationOrdinal`；它来自 canonical reducer 顺序，因此相等 `occurredAt` 也不会含糊，late/replay 后只认重新投影结果。
- 本轮不造 ProjectionConflict。owner mismatch 通过清空/null 确定性 fail closed；通用冲突模型等稳定 windowId/source precedence 后再做。

### 消费规则

- completion：必须有 editor/text_input focus，且 text owner 与 focus 一致。
- search：当前 heuristic 与 Pi 兼容规则只在选区、页面和前台 owner 完全一致时生成；`owner:null`/mismatch 连候选也不生成。动作层仍独立重复校验，不能相信 predictor 已检查。
- tests：最新 save action 的 applicationId 必须与当前 coding app 一致。`FilesystemActivitySource` 固定上报 `applicationId:null`，只能形成建议素材，不能触发 `run_tests`；正例必须来自能明确归属的 IDE/host source。
- `lastCommandOutcome` 保留为 episode 事实；`inspect_error` 只由当前 command-completed 触发事实产生，不因后续任意窗口事件重复触发。recent action 的 app owner 不匹配时，tests 失效。
- ContextPolicy 和 Pi 输入统一读取 `textContext`；Pi 保留四条兼容规则，但字段名同步迁移，不复制旧结构。

### 验收

- Code 文本现场切到 Slack 后，旧 window/focus/text/page 不再触发预测。
- 同窗口的新 focus 不继承旧文字。
- 无 focus 文本可以保留，但不能 completion。
- 有明确 browser owner 的 screen-text selection-search 保持工作；owner null/mismatch 无搜索候选，动作层也必须零 claim/零 MCP。
- fixture/source 的 canonical 顺序必须是 `application/window/focus -> browser_navigated(owner) -> text_context_changed`。不得为迁就旧 fixture 放宽 owner 校验，也不得在后来的 focus 上偷偷回填旧页面 owner。
- 顺序 ingest、late reproject、restore 得到相同 WorldState。

## 4. Phase B：统一 provider 门禁和信任边界

- `provider-gate.ts` 导出唯一 `DEFAULT_PROVIDER_GATE_TIMEOUT_MS = 90_000`；CLI 与实时 replay admission 共用。
- `ProviderSelection` 返回 provider、`contextPolicy`、`actionTrust`。
- heuristic 使用 passthrough；Pi 使用 RedactingContextPolicy。policy 抛错时不外发，继续本地 fallback。
- Pi 只通过 probe 时 `actionTrust="suggestion_only"`；本地 heuristic 或 replay gate passed 才为 `trusted`。
- suggestion-only 运行若配置动作，入口明确报错，不静默执行。
- 不删除或去规则化 Pi prompt 的四条兼容规则；只同步新字段、安全前置条件和 timeout。未实际联网只报告“未验证”。

## 5. Phase C：确定性摘要与 durable attempt

两个概念严格分开：

- `stateDigest`：返回 `sha256:<64 lowercase hex>`；输入是 `{algorithmVersion:"world-state-digest-v1", state:<完整 WorldState>}` 的递归键排序 canonical JSON。WorldState 本身不含 digest/generation/runtime session/墙钟字段。同一 canonical timeline 在顺序、late、restore 后相同；版本或格式 mismatch 一律 fail closed。
- `projectionGeneration`：仅当前进程单调递增；accepted 或整体重投影后递增，用于废弃并发旧任务，不承诺跨进程相同。
- `PredictionRuntime` 拥有唯一串行 mutation queue；`ingest`、`restore`、`invalidateAccepted` 与最终 `admitAndClaim` 都经这条队列。dispatcher 不得自己“先读 state 再写 ledger”，也不向普通调用者暴露通用 `runSerialized` 绕过不变量。

`SquidCore`/`PredictionRuntime` 暴露只读 metadata。新 attempt 使用 schema v2，以下元数据全部必填：

```text
runtimeSessionId
stateDigest
projectionGeneration
triggerEventId
episodeId
triggerDisposition
contextPolicyId
actionTrust
egressPolicyId
```

- 旧 v1 ledger 记录仍可读，但不可自动执行。
- attempt/ledger 不保存 raw selection、raw rationale 或完整 MCP 回执。候选持久化形状只保留 `candidateId/kind/confidence/expiresAt/sourceEventIds` 与参数审计摘要；selection 及任何含 selection 的 ActionPlan.summary 永远 `preview:null`，只保留长度和非隐私授权的完整性标记。raw 参数只存在当前进程的不可变 `ActionPlan`。
- 进程重启后没有 raw plan 的旧 attempt 一律不可自动执行，即使它是 v2；只能审计或人工重新触发一次新预测。
- prediction promise 在 attempt 写入完成后才 settle。写失败仍交付预测并报 diagnostic，但 action admission 因 attempt 不存在而拒绝。
- late ingest 可更新投影、产生 shadow prediction，但 watch 入口不能从 late 事件派发动作。

## 6. Phase D：动作准入、单一计划和原子 claim

### 选择与准入

- 先选置信度最高的可映射 kind，再只检查该候选；失败即拒绝 request，不执行低置信候选。
- 异步 `ActionPlanner` 先用平台文件 API 的 `realpath` 固化 canonical workdir/target，生成不可变 plan；纯 `ActionAdmission` 只校验该 plan、attempt、当前 metadata/state 和 digest，输出 admitted 或固定 reasonCode。
- 通用检查：attempt v2 已持久化；runtimeSessionId/episodeId/stateDigest/projectionGeneration 一致；未过期；非 late；actionTrust 允许。
- search 再比对当前 selection、页面存在、页面/选区/当前 foreground owner 完全一致、observationOrdinal 顺序和候选参数；另要求 `SQUID_SEARCH_EGRESS=allow`。
- tests 再比对 coding app、最新 file_saved path；planner 继续检查 workdir/路径穿越/quoting，gateway invoke 前做 realpath/symlink 边界检查。
- 固定顺序：plan/preflight+admission -> confirm -> 最终 filesystem preflight -> **同一 runtime 串行队列内执行最终 admission + claim**（线性化点）-> invoke。claim 后不再做可能拒绝的检查。最终 realpath/symlink 检查只能验证原 plan，不能重规划；任何变化都在 claim 前拒绝。

### 单一 ActionPlan

- planner 只生成一次，并对 canonical plan 计算 `planDigest`。
- 确认、claim、gateway invoke 使用同一个 `{plan, planDigest}`。
- `CapabilityGateway.invoke` 不再从 candidate 规划；模型不能提供 tool/command。
- `CapabilityDispatcher` 是唯一派发入口，内部强制 admission，调用者不能绕过。

### 原子 claim 与结果

- ledger 暴露窄 API：`recordPlan`、`recordDecision`、`claimDispatch`、`completeDispatch`；generic `appendFeedback` 不能绕过状态机写 terminal。
- `recordPlan` 在确认前持久化 `planSchemaVersion/planDigest/candidateParametersDigest/confirmation/egressPolicyId`，不保存 raw 参数；相同记录幂等，不同 digest 冲突。确认 UI、claim 与 invoke 都只能引用该计划记录。
- 状态图固定：`proposed -> accepted|rejected|expired`；需要确认的计划允许 `accepted -> dispatched|rejected(state_changed)|expired`；无需确认的计划允许 `proposed -> dispatched|rejected(state_changed)|expired`；`dispatched -> succeeded|failed`；所有 terminal 不可再转移。
- `PredictionLedger.claimDispatch` 使用确定性 claim ID，并在同一个原子操作中校验 `runtimeSessionId/projectionGeneration/stateDigest/planDigest`、recorded plan、candidate 与合法前置状态，成功追加 dispatched。返回 `claimed|already_claimed|rejected|expired|terminal`；只有 `claimed` 可以调用 MCP，其余全部零调用。
- claim 的同一原子校验还必须包含 `episodeId`、`triggerDisposition=accepted`、`contextPolicyId`、`actionTrust`、`egressPolicyId`、attempt schema/version、`attemptId` 和 `candidateId`；这些不能只靠进入 claim 前的 admission。
- claim ID 固定为 `sha256("claim-v1|" + attemptId + "|" + candidateId + "|" + runtimeSessionId + "|" + planDigest)`；它只是幂等键，不是秘密。首次成功 claim 另生成随机 opaque `claimToken`，只存 token hash；planDigest/selection integrity digest 使用运行时密钥 HMAC 或只作为完整性校验，绝不当隐私屏障；egress policy ID 同时写入 dispatched 记录。
- `recordDecision` 只记录用户的 `accepted|rejected|expired` 决定：相同 decision+detailsDigest 幂等，相反 decision 或不同 details 是 conflict。确认后的系统失效不伪装成第二个用户决定，改由独立、仅内部可调用的 `recordStateRejection(claimInputs, reasonCode="state_changed")` 完成唯一合法的 `accepted -> rejected(state_changed)` 转移；它与 claim 使用同一串行/原子边界。
- `completeDispatch` 必须带成功 claim 返回的 opaque `claimToken`；相同 `claimToken+terminalOutcome+detailsDigest` 幂等，不同 outcome/details、错误或陈旧 token 一律 conflict/reject，绝不再次调用 MCP。
- InMemory/SQLite/JSONL 对 claim 返回相同语义；JSONL 只在单进程入口启用，其他情况 fail closed。
- InMemory/SQLite 并发只允许一个 claimed；JSONL 仅承诺单进程 write-tail 串行，不用于多进程动作生产。
- `accepted` 保留“用户确认接受”的现有语义。
- 只有 MCP 返回结构化、可确认的工具失败才允许 `completeDispatch(failed)`；transport timeout、断线、取消或进程崩溃发生在 claim 后，一律只保留 dispatched，报告 `reconciliation_required`，不补写 failed、不自动重试。外部调用完成但终态写失败同理。
- 不承诺外部 exactly-once；未来工具支持 idempotency key 时再传 candidateId。

### 数据外发

- search 需要显式 `SQUID_SEARCH_EGRESS=allow`；只有 `SQUID_ACTIONS=mcp` 不够。
- selection/rationale/MCP summary、`ActionPlan.summary`、confirmation decision details、gateway error/summary、diagnostic 和 watch stdout 入日志、feedback 或 ledger 前统一经过一个 `sanitizeAuditText()`：固定最大长度、去控制字符、凭证脱敏，并返回稳定的分类结果；selection/summary 分类强制 `preview:null`，rationale/MCP summary 才可有脱敏 preview。相同输入必须得到相同输出，raw 文本不得落盘。
- egress 配置只有三种结果：未设置=`deny`，精确 `allow`=`allow`，其他值=启动配置错误。审计 ID 固定为 `search-egress-deny-v1` / `search-egress-allow-v1`。
- claim 是线性化点：成功后即使进程崩溃也保持 dispatched，要求人工 reconciliation，绝不自动重试。
- run_tests 的终端确认和确认后过期复查保持不变。

## 7. Phase E：最小 BeliefState 纯契约

本轮没有 producer、store 或运行时接线。

- type 固定 `task_intent`。
- value：`debug_failure | draft_text | research_selection | validate_change | unknown`。
- batch 元数据：schemaVersion、beliefBatchId、projectionGeneration、episodeId、stateDigest、generatedAt、provider、modelVersion、promptVersion、contextPolicyId。
- belief：id、value、confidence、evidenceEventIds、inferredAt、expiresAt。
- 验证上下文提供显式 `now`、当前 episode/stateDigest/projectionGeneration、合法 `eventId -> occurredAt` 映射和最大 TTL。
- 使用 TypeBox schema 与固定长度/数量上限；空或重复证据、重复 belief id、跨 episode/digest/generation、未来证据、时间顺序错误、精确到期、NaN/Infinity、非法 confidence/time、超限字段整批拒绝。
- 返回深拷贝，不修改输入；不允许 belief 引用 belief，不允许 command/tool/自由文本 statement。

下一阶段必须把 `BeliefProvider + CognitionProvider + semantic gate + shadow/suggestion mode + Pi 去规则化` 一起实施，不能只改 prompt。

## 8. 测试和交付门

新增覆盖：

- app/window/focus/text ownership 和 selection-only 兼容。
- stateDigest 在顺序、late、restore 三路相同。
- attempt durable-before-action：deferred ledger 证明落账前 promise 不 settle；写失败仍交付 outcome，但固定拒绝、零 claim、零 MCP。
- 状态/episode/selection/save 改变后拒绝；top-1 失败不降级。
- 同 candidate 并发只 claim 一次；完整状态图三后端 conformance；终态写失败不伪造 failed。
- search 默认/非法 env 拒绝；allow+owner match 正例；owner null/mismatch/stale/selection changed 反例；拒绝日志和 ledger 不泄露 selection。
- provider probe 只能 suggestion；replay passed 才允许 Pi 动作。
- Belief schema、证据、TTL、不可变性和 fail closed。

每阶段：

```text
bun run typecheck
bun test
bun run build
bun run evaluate
git diff --check
git status --short
```

首次和最终另跑：

- `bun install --frozen-lockfile`
- SQLite/JSONL restart 与 truncated-tail smoke
- 真实 MCP 同意、拒绝、过期、状态变化、重复派发 smoke
- 两轮独立代码 review；主代理重新核对关键 diff

文件级执行顺序：

```text
Phase A: protocol/world-state/sources/predictors/context policy + fixtures/tests
Phase B: provider-gate/provider-selector/watch entries + tests
Phase C: prediction-ledger/runtime/core digest metadata + persistence/conformance tests
Phase D: action-plan/capability-dispatcher/watch-actions/egress/audit + MCP and restart smokes
Phase E: belief-state schema/validator + isolated tests
```

联网 `bun run gate:pi` 使用硬外层 timeout，单独报告 passed/failed/skipped；离线绿色不等于 Pi 质量或 macOS Accessibility 已验证。
