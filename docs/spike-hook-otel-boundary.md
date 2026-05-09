# Hook & OTel 可行性探查报告

**日期**: 2026-05-08
**探查人**: zylos01 (Claude Code v2.1.132), Jinglever (Codex CLI v0.128.0)
**目标**: 验证 Hook 和 OTel 两条数据通道的可行性，发现可获取信息的边界

---

## 摘要

两个运行时（Claude Code、Codex）均提供丰富的可观测性数据。Hook 事件是主要数据源，payload 比预期更丰富——包含完整的工具输入/输出，无需额外启用 OTel 即可满足大部分监控需求。Codex OTel 提供了 33 个指标（方案文档假设 8 个）和 13+ 种独立 trace span 类型。

**核心结论**:
1. Claude Code hook 事件在无头模式下**正常触发**（含 Stop 和 UserPromptSubmit），已验证 17 种事件类型
2. Hook payload 包含完整工具 I/O——HookAdapter 单独即可覆盖工具监控需求
3. Codex OTel 数据量远超文档预期（33 指标 vs 8 个）
4. Claude Code OTel 已实测验证：6 指标 / 6 种日志事件 / 5 种 trace span
5. **StatusLine** 是第三数据源——提供 token、费用、缓存、速率限制等 Hook 和 OTel 都没有的数据
6. **安全风险**：两个运行时默认暴露原始 prompt 和完整工具 I/O，Dashboard 必须在摄入层做脱敏

---

## 一、Hook 事件探查

### 1.1 已捕获事件类型

初始探查两个 session 共捕获 **360+ 事件**，覆盖 **13 种事件类型**。后续持续采集已累积 **6000+ 事件**，覆盖 **17 种事件类型**（含 ConfigChange、TaskCreated、TaskCompleted）。

初始探查数据：

| 事件 | 数量 | 说明 |
|------|------|------|
| PreToolUse | 115 | 工具调用前，含完整输入参数 |
| PostToolUse | 109 | 工具调用后，含完整响应 + duration_ms |
| PostToolBatch | 102 | 每轮工具调用结束时的批次汇总 |
| SubagentStop | 6 | 子代理结束，含最终输出 |
| Stop | 6 | 模型一轮回复结束 |
| UserPromptSubmit | 6 | 用户提交 prompt |
| PostToolUseFailure | 5 | 工具调用失败，含错误信息 |
| Notification | 4 | 通知事件（如 idle_prompt） |
| SubagentStart | 2 | 子代理启动 |
| CwdChanged | 2 | 工作目录变更 |
| SessionEnd | 1 | Session 结束（/clear 触发） |
| SessionStart | 1 | Session 启动 |
| InstructionsLoaded | 1 | 指令文件加载（CLAUDE.md） |

### 1.2 关键发现：无头模式全部正常

**之前的误判**：初始探查报告认为 `Stop` 和 `UserPromptSubmit` 在无头模式（C4 消息注入）下不触发。

**实际原因**：hook 探针脚本是在 session 运行中途安装的。Claude Code **不会对已运行 session 热加载新 hook**。/clear 重启 session 后，hooks 从启动时就存在，所有事件正常触发。

**验证数据**（当前 session c6d04472）：

```
SessionStart
  → UserPromptSubmit (C4 注入的 prompt，含完整文本)
    → PreToolUse → PostToolUse → PostToolBatch
    → SubagentStart → ... → SubagentStop
  → Stop (last_assistant_message 可用)
  → UserPromptSubmit (下一条 C4 消息)
    → tools...
  → Stop
```

**结论**：无头模式无信息损失，hook 事件正常触发。

### 1.3 每种事件的 Payload 字段

#### 公共字段（所有事件都有）

| 字段 | 类型 | 说明 |
|------|------|------|
| session_id | string | Session UUID |
| transcript_path | string | 会话记录 JSONL 路径 |
| cwd | string | 当前工作目录 |
| hook_event_name | string | 事件类型名 |

#### PreToolUse

| 字段 | 类型 | 说明 |
|------|------|------|
| permission_mode | string | 权限模式（如 "bypassPermissions"） |
| tool_name | string | 工具名（Read、Bash、Write 等） |
| tool_input | object | **完整**工具输入参数 |
| tool_use_id | string | 本次调用唯一 ID |

#### PostToolUse

PreToolUse 所有字段 + ：

| 字段 | 类型 | 说明 |
|------|------|------|
| tool_response | object | **完整**结构化响应（见下） |
| duration_ms | number | 工具执行耗时（毫秒） |

**tool_response 按工具类型不同**：
- **Bash**: `{stdout, stderr, interrupted, isImage, noOutputExpected}`，大输出时有 `persistedOutputPath` + `persistedOutputSize`
- **Read**: `{type, file: {filePath, content, numLines, startLine, totalLines}}`
- **Write**: `{type, content, filePath, originalFile, structuredPatch, userModified}`
- **Edit**: 类似 Write，含 `structuredPatch`
- **Agent**: 子代理返回结果
- **WebFetch**: 网页抓取内容

#### PostToolBatch

| 字段 | 类型 | 说明 |
|------|------|------|
| tool_calls | array | 该轮所有工具调用的数组，每项含 tool_name、tool_input、tool_use_id、tool_response |

用途：一轮结束时的批次汇总，适合做 turn 级别的聚合统计。

#### PostToolUseFailure

| 字段 | 类型 | 说明 |
|------|------|------|
| tool_name | string | 失败的工具名 |
| tool_input | object | 导致失败的输入 |
| error | string | 错误消息 |
| is_interrupt | boolean | 是否用户中断（区分中断 vs 真正错误） |
| duration_ms | number | 失败前的耗时 |

#### Stop

| 字段 | 类型 | 说明 |
|------|------|------|
| stop_hook_active | boolean | stop hook 是否激活 |
| last_assistant_message | string | 模型最后一条回复文本 |

#### UserPromptSubmit

| 字段 | 类型 | 说明 |
|------|------|------|
| prompt | string | **完整** prompt 文本（含 C4 注入的消息） |

#### SubagentStart

| 字段 | 类型 | 说明 |
|------|------|------|
| agent_id | string | 子代理唯一 ID |
| agent_type | string | 子代理类型（如 "general-purpose"） |

#### SubagentStop

SubagentStart 字段 + ：

| 字段 | 类型 | 说明 |
|------|------|------|
| stop_hook_active | boolean | stop hook 是否激活 |
| agent_transcript_path | string | 子代理会话记录路径 |
| last_assistant_message | string | 子代理最终输出 |

#### SessionStart / SessionEnd

| 字段 | 类型 | 说明 |
|------|------|------|
| source / reason | string | 启动来源 / 结束原因（如 "clear"） |

#### InstructionsLoaded

| 字段 | 类型 | 说明 |
|------|------|------|
| file_path | string | 加载的指令文件路径 |
| memory_type | string | 类型（如 "Project"） |
| load_reason | string | 加载原因（如 "session_start"） |

#### CwdChanged

| 字段 | 类型 | 说明 |
|------|------|------|
| old_cwd | string | 原工作目录 |
| new_cwd | string | 新工作目录 |

#### Notification

| 字段 | 类型 | 说明 |
|------|------|------|
| notification_type | string | 通知类型（如 "idle_prompt"） |
| message | string | 通知内容 |

### 1.4 初始探查未触发的事件（更新状态）

| 事件 | 触发条件 | 状态 |
|------|---------|------|
| ConfigChange | 配置变更 | ✅ **已触发**（32 条） |
| TaskCreated | Task 工具创建任务 | ✅ **已触发**（2 条） |
| TaskCompleted | 任务完成 | ✅ **已触发**（2 条） |
| StopFailure | Stop hook 执行失败 | 未触发（罕见） |
| UserPromptExpansion | Prompt 展开 | 未触发 |
| Setup | 首次运行 | 未触发（一次性） |
| PermissionRequest | 非 bypass 权限模式 | 未触发（我们用 bypass） |
| PermissionDenied | 权限拒绝 | 未触发（同上） |
| TeammateIdle | 队友空闲 | 未触发（多代理场景） |
| WorktreeCreate | 创建 worktree | 未触发 |
| WorktreeRemove | 移除 worktree | 未触发 |
| PreCompact | 上下文压缩前 | 未触发 |
| PostCompact | 上下文压缩后 | 未触发 |
| Elicitation | MCP 交互式请求 | 未触发（MCP 场景） |
| ElicitationResult | MCP 请求结果 | 未触发（MCP 场景） |
| FileChanged | 文件变更 | 未触发 |

注：`at_mention` 已从列表移除——经 `/doctor` 检查确认为无效事件（spike probe 产生的误注册），已从 settings.json 中删除。

### 1.5 工具延迟统计

基于 110 个 PostToolUse 事件的 duration_ms：

| 工具 | 样本数 | 最小 | 中位数 | 最大 | 备注 |
|------|--------|------|--------|------|------|
| Read | 14 | 1ms | 10ms | 19ms | 极快 |
| Edit | 6 | 12ms | 18ms | 22ms | 极快 |
| Write | 3 | 11ms | 30ms | 36ms | 极快 |
| Skill | 1 | 23ms | 23ms | 23ms | — |
| Bash | 79 | 17ms | 56ms | 21,558ms | 方差大，取决于命令 |
| WebFetch | 5 | 969ms | 1,802ms | 38,243ms | 网络延迟主导 |
| Agent | 2 | 2ms | 268,291ms | 268,291ms | 含子代理完整执行时间 |

**全局**: min=1ms, median=47ms, P95=3,064ms, P99=38,243ms

### 1.6 跨运行时对比（Claude vs Codex）

| 事件 | Claude Code | Codex | 备注 |
|------|------------|-------|------|
| PreToolUse | ✅ | ✅ | 都有 tool_name、tool_input、tool_use_id |
| PostToolUse | ✅ | ✅ | 都有 tool_response；duration_ms 仅 Claude hook 有，Codex 的在 OTel `codex.tool_result.duration_ms` |
| PostToolBatch | ✅ | ❌ | Claude 独有，批次汇总 |
| PostToolUseFailure | ✅ | ❌ | Claude 独有 |
| Stop | ✅ | ✅ | Codex 额外有 turn_id |
| UserPromptSubmit | ✅ | ✅ | — |
| SubagentStart/Stop | ✅ | ❌ | Claude 独有 |
| SessionStart | ✅ | ✅ | Codex SessionStart 有 model 字段 |
| SessionEnd | ✅ | ❌ | Claude 独有；Codex 未观察到 |
| turn_id | ❌ | ✅ | Codex 独有，用于 turn 追踪 |

**HookAdapter 设计影响**：
- Turn 边界检测：Claude 用 Stop 事件（已确认可用），Codex 用 Stop + turn_id
- 子代理追踪：仅 Claude 支持
- 批次汇总：仅 Claude 有 PostToolBatch，Codex 需自行聚合

---

## 二、OTel 遥测探查

### 2.1 Claude Code OTel ✅ 已实测验证

**状态**：2026-05-09 通过 clean env + runtime-env.manifest 注入 OTel 环境变量，session 重启后数据正常流入 otlp-spike。

**实测结果**（v2.1.138，作用域 `com.anthropic.claude_code`）：

- **指标 (6 个)**：`claude_code.session.count`、`.active_time.total`、`.cost.usage`（USD）、`.token.usage`（含 model/query_source/effort/type 维度）、`.lines_of_code.count`、`.code_edit_tool.decision`
- **日志 (6 种事件)**：`user_prompt`（含完整 prompt）、`api_request`（含 cost_usd、token 分项、model）、`hook_execution_start/complete`（配对）、`tool_decision`、`tool_result`（含 tool_input/tool_parameters/决策来源）
- **链路 (5 种 span)**：`interaction`（顶层）→ `llm_request`（含 TTFT、cache tokens、model）→ `tool`（含命令/文件路径）→ `tool.blocked_on_user`（权限决策）+ `tool.execution`（执行结果）

**与文档预期的差异**：
- 指标实际 6 个（非 8 个）——`code_edit_tool.decision` 是新发现
- 日志实际 6 种事件（非 17 种）——部分事件可能在特定场景下触发
- 链路已稳定可用（非 beta），span 名称规范（`claude_code.*`），层级关系清晰

详见 `spike/DATA-INVENTORY-otel.md`。

### 2.2 Codex OTel（Jinglever 实测）

**样本**: 151 个 OTLP 请求，实际抓取数据（初始探查 102 个，后续补充至 151 个）。

#### 资源属性

| 属性 | 实际值 | 方案文档假设 | 差异 |
|------|--------|------------|------|
| service.name | `codex_cli_rs` | `codex.session` | ❌ 不匹配 |
| telemetry.sdk.language | `rust` | — | 新发现 |
| telemetry.sdk.version | `0.31.0` | — | 新发现 |

#### 日志事件（8 种，实测）

| 事件 | 关键字段 | 文档匹配 | 安全风险 |
|------|---------|---------|---------|
| codex.conversation_starts | conversation.id, user.email, terminal.type | ✅ | — |
| codex.user_prompt | prompt, prompt_length | ✅ | ⚠️ 含原始 prompt |
| codex.websocket_connect | — | 新发现 | — |
| codex.websocket_request | duration_ms, success | 部分 | — |
| codex.websocket_event | event.kind, duration_ms, success 等传输事件字段 | ✅ | — |
| codex.sse_event | input/output/cached/reasoning/tool token 计数 | ✅ | — |
| codex.tool_decision | tool_name, decision, call_id | ✅ | — |
| codex.tool_result | tool_name, call_id, duration_ms, success, arguments, output | ✅ | ⚠️ 完整 I/O |

#### 指标（33 个，文档仅列 8 个）

关键新发现指标：

| 指标 | 文档状态 | 用途 |
|------|---------|------|
| codex.turn.e2e_duration_ms | ✅ 已列 | Turn 端到端延迟 |
| codex.turn.ttft.duration_ms | ✅ 已列 | 首 token 延迟 (TTFT) |
| codex.turn.ttfm.duration_ms | 新发现 | 首模型响应延迟 |
| codex.turn.token_usage | 新发现 | Turn 级 token 用量 |
| codex.tool.call | 新发现 | 工具调用计数 |
| codex.tool.call.duration_ms | 新发现 | 工具调用延迟 |
| codex.hooks.run | 新发现 | Hook 执行计数 |
| codex.hooks.run.duration_ms | 新发现 | Hook 开销追踪 |
| codex.websocket.request.duration_ms | 新发现 | 传输层健康监控 |
| codex.thread.skills.* | 新发现 | 技能使用追踪 |
| codex.plugins.* | 新发现 | 插件使用追踪 |

#### 链路追踪（13+ 种 span）

实际 span 是实现级别的内部名称，非稳定 API：
- 关键 span: `session_init`、`run_turn`、`session_task.turn`、`turn/start`、`turn/steer`、`handle_responses`、`handle_tool_call`、`exec_command`、`write_stdin`、`model_client.stream_responses_websocket`、`responses_websocket.connect`、`responses_websocket.stream_request`、`app_server.thread_start.*`
- Token 字段（在 `handle_responses` 和 `session_task.turn` 上）：`gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens`、`gen_ai.usage.cache_read.input_tokens`、`codex.usage.total_tokens`

**注意**：Trace span 名称是实现细节，不应依赖特定名称构建 UI。初始探查报告的 52 种 span 数量包含了参数化变体（如 `app_server.thread_start.*`），去重后为 13+ 种独立 span 类型。

#### 配置修正

| 项目 | 方案文档假设 | 实际 | 修正 |
|------|-----------|------|------|
| 导出器配置 | `exporter = { otlp-http = { endpoint = "..." } }` | 需要 `protocol = "json"` | 添加 `protocol = "json"` |
| 指标导出器 | 与日志共用 | 需独立 `metrics_exporter` + `trace_exporter` | 三者需分别声明（exporter / metrics_exporter / trace_exporter） |
| 资源命名 | `codex.session` 风格 | `codex_cli_rs` | 更新文档 |
| Trace 结构 | 干净的 `codex.session` 根 span | 13+ 种实现级 span 类型 | 视为不稳定 API |

---

## 三、安全发现

两个运行时默认暴露敏感数据，Dashboard 必须处理：

| 数据类型 | 来源 | 风险 | 处置 |
|---------|------|------|------|
| 用户 prompt 原文 | Hook (UserPromptSubmit)、OTel (codex.user_prompt) | PII、机密指令 | 摄入层脱敏；默认不持久化原文 |
| 工具完整 I/O | Hook (tool_input/tool_response)、OTel (tool_result) | 可能含密钥、文件内容 | 默认 strip 或 hash；调试模式可选全量 |
| 文件路径 | Hook (transcript_path, cwd) | 系统布局泄露 | 同主机 OK；禁止外部导出 |
| 模型回复原文 | Hook (Stop.last_assistant_message, SubagentStop) | 可能含敏感分析 | 默认截断或省略 |
| Session ID | 所有 Hook + OTel | 关联键 | 可存储；禁止外部暴露 |

**建议**：摄入层实现可配置脱敏管线。默认模式 = 激进脱敏（strip prompt、工具 I/O、消息原文）。调试模式 = 可选全量捕获。

---

## 四、信息边界总结

### 4.1 Hook 能提供什么（已验证）

| 维度 | 可获取 | 精度 |
|------|--------|------|
| 工具调用链 | ✅ 完整的调用序列 + 输入/输出 | 每次调用级 |
| 工具延迟 | ✅ duration_ms | 毫秒级 |
| Turn 边界 | ✅ Stop 事件 | 每轮级 |
| 用户输入 | ✅ 完整 prompt 文本 | 每次输入级 |
| 子代理生命周期 | ✅ 启动/结束/类型/最终输出 | 完整 |
| 工具错误 | ✅ 错误消息 + 中断区分 | 每次失败 |
| Session 生命周期 | ✅ 启动/结束/原因 | 事件级 |
| 配置/目录变更 | ✅ 前后值 | 事件级 |

### 4.2 Hook 无法提供什么

| 维度 | 限制 | 替代方案 |
|------|------|---------|
| Token 用量 | ❌ hook 不含 token 计数 | OTel 指标 / **StatusLine** `context_window.current_usage` |
| LLM 延迟（TTFT/P95） | ❌ hook 无 LLM 请求耗时 | OTel trace `ttft_ms` |
| 模型名称/版本 | ❌ hook 不含模型信息 | OTel 资源属性 / **StatusLine** `model.id` |
| Prompt cache 命中率 | ❌ hook 不含缓存信息 | OTel 指标 / **StatusLine** `cache_read/creation_input_tokens` |
| 流式响应进度 | ❌ 所有事件都是时间点快照 | 无替代 |
| 成本估算 | ❌ hook 无成本数据 | OTel 指标 `cost.usage` / **StatusLine** `cost.total_cost_usd` |
| 上下文窗口用量 | ❌ hook 无上下文信息 | **StatusLine** `context_window.used_percentage`（独有） |
| 速率限制 | ❌ hook 无限速数据 | **StatusLine** `rate_limits`（独有） |
| 推理力度 | ❌ hook 无 effort 信息 | **StatusLine** `effort.level`（独有） |

### 4.3 OTel 能补充什么（Claude Code + Codex 均已实测）

| 维度 | 可获取 | 备注 |
|------|--------|------|
| Token 用量 | ✅ input/output/cached/reasoning 分项 | 日志 + 指标 |
| TTFT | ✅ codex.turn.ttft.duration_ms | 指标 |
| Turn 端到端延迟 | ✅ codex.turn.e2e_duration_ms | 指标 |
| 工具调用统计 | ✅ codex.tool.call + duration_ms | 指标 |
| Hook 执行开销 | ✅ codex.hooks.run.duration_ms | 指标（新发现） |
| WebSocket 传输健康 | ✅ 请求/事件/延迟 | 指标（新发现） |

---

## 五、StatusLine 数据源（Claude Code 独有）

StatusLine 是 Claude Code 底部状态栏，通过 `settings.json` 配置 shell 脚本，每次状态更新时从 stdin 接收完整的 JSON 会话数据。它填补了 Hook 和 OTel 都无法获取的关键指标。

**StatusLine 独有数据**（Hook 和 OTel 都没有）：
- `context_window.used_percentage` / `remaining_percentage` — 上下文用量实时百分比
- `context_window.context_window_size` — 上下文窗口大小（200K / 1M）
- `cost.total_duration_ms` / `total_api_duration_ms` — 会话总时长和 API 等待时长
- `rate_limits.five_hour` / `seven_day` — 速率限制用量（Pro/Max 订阅独有）
- `effort.level` — 当前推理力度（low/medium/high/xhigh/max）
- `thinking.enabled` — 是否启用 extended thinking
- `exceeds_200k_tokens` — 是否超过 200K token

**与 OTel 互补**：
- `cost.total_cost_usd` — StatusLine 给累计值，OTel 给每次请求值
- `cache_read/creation_tokens` — StatusLine 给当前快照，OTel 给每次请求明细

**采集方案**：脚本同时输出状态栏 + 追加 JSONL 文件。详见 `spike/DATA-INVENTORY-hooks.md` 第十节。

---

## 六、对方案文档的修正

| 项目 | 原假设 | 实际 | 影响 |
|------|--------|------|------|
| 无头模式 Stop/UserPromptSubmit | 不触发 | **正常触发**（需 session 启动时就注册 hook） | HookAdapter 可用统一 Stop 做 turn 边界 |
| Hook payload | 可能是摘要 | **完整工具 I/O** | HookAdapter 单独可覆盖工具监控 |
| Codex 指标数 | 8 个 | 33 个 | TelemetryAdapter 需动态指标发现 |
| Codex Trace | 干净的根 span | 13+ 种实现级 span（去重后） | Trace 面板视为补充，非核心依赖 |
| Claude Code OTel | 待验证 | **已实测**：6 指标 / 6 种日志 / 5 种 trace span | 全部可用 |
| 数据源 | Hook + OTel 两源 | **三源**：Hook + OTel + StatusLine | StatusLine 填补 context/rate limit/effort 空白 |
| Codex 配置格式 | 单一 exporter | 需分别配 metrics/trace exporter + protocol=json | 更新配置文档 |
| 安全脱敏 | 可选 | **必须**——默认就暴露原文 | 脱敏管线是 P0 |

---

## 七、待完成项

1. ~~**Claude Code OTel 实测**~~：✅ **已完成**（2026-05-09）——6 指标 / 6 种日志 / 5 种 trace span，数据正常流入 otlp-spike
2. **更多事件触发**：PermissionRequest（需非 bypass 模式）、WorktreeCreate/Remove、PreCompact/PostCompact（需上下文压缩）。ConfigChange、TaskCreated、TaskCompleted 已在后续 session 中触发
3. **脱敏管线设计**：定义每个字段的 strip/hash/keep 策略
4. **方案文档更新**：将本报告的修正同步到 `docs/solution.md` 的 data-sources 章节
5. **StatusLine 数据采集**：配置 statusLine 脚本，开始采集 context/cost/rate limit 数据
