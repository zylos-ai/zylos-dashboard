# Zylos Dashboard — 总方案

## Executive Summary

Zylos Dashboard 是 zylos agent 系统的可观测性仪表盘。它将分散在多个文件、数据库和遥测管道中的运行时数据汇聚到一个统一的 Web 界面，让运维者实时掌握 agent 的运行状态、资源消耗、任务执行和通信活动。

核心设计原则：

1. **只读观测，不改变现有架构。** Dashboard 是纯观测层，不修改 zylos 核心运行逻辑，仅消费已有数据源。
2. **统一指标模型，不是数据来源拼盘。** 用户看到的是面向业务的统一指标（agent 是否健康、一次交互耗时多少、成本趋势如何），不按底层数据获取途径（遥测 / hook / 状态文件）拆分版面。来源只是指标 metadata。
3. **多 runtime 并集覆盖。** 同时支持 Claude Code runtime 和 Codex CLI runtime。指标集取两个 runtime 的并集：某 runtime 不支持的指标标记为 unsupported，不假补数据。

## 1. 问题定义

### 1.1 当前痛点

zylos 运行时积累了丰富的运行数据，但分散在多处，缺乏统一可视化入口：

| 数据类型 | 当前位置 | 查看方式 |
|---------|---------|---------|
| Agent 状态（忙/闲/思考） | `activity-monitor/agent-status.json` | 手动 `cat` |
| Statusline（成本/context/rate limit） | `activity-monitor/statusline.json` | 手动查 JSON（仅 Claude runtime） |
| Session 成本 | `activity-monitor/cost-log.jsonl` | 手动查 JSONL |
| 工具调用事件 | `activity-monitor/tool-events.jsonl` | 手动查 JSONL |
| 工具会话状态 | `activity-monitor/session-tool-state.json` | 手动查 JSON |
| API 活动 | `activity-monitor/api-activity.json` | 手动查 JSON |
| Context 使用率 | `activity-monitor/context-monitor-state.json` | 手动查 JSON |
| 进程状态 | `activity-monitor/proc-state.json` | 手动查 JSON |
| 配额使用 | `activity-monitor/usage.json` | 手动查 JSON |
| Hook 计时 | `activity-monitor/hook-timing.log` | 手动查日志 |
| 活动日志 | `activity-monitor/activity.log` | 手动查日志（每日截断 500 行） |
| 通信记录 | `comm-bridge/c4.db` | SQL 查询 |
| 计划任务 | `scheduler/scheduler.db` | CLI 命令 |
| PM2 服务状态 | PM2 运行时 | `pm2 status` 命令 |
| PM2 日志 | `~/.pm2/logs/` | 手动查日志 |
| 系统日志 | `~/zylos/logs/` | 手动查日志 |

### 1.2 数据采集能力：两个 Runtime 的遥测现状

zylos-core 有两个重要 runtime，它们各自提供了不同层次的可观测性数据：

#### Claude Code OTel

Claude Code 原生支持 OpenTelemetry，通过环境变量启用：

| 配置 | 说明 |
|------|------|
| `CLAUDE_CODE_ENABLE_TELEMETRY=1` | 主开关 |
| `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` | 启用 span tracing (beta) |
| `OTEL_METRICS_EXPORTER` | `otlp` / `prometheus` / `console` / `none` |
| `OTEL_LOGS_EXPORTER` / `OTEL_TRACES_EXPORTER` | 同上 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | e.g. `http://localhost:4317` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `grpc` / `http/json` / `http/protobuf` |

内容细粒度控制（opt-in，均默认关闭）：

| 变量 | 内容 |
|------|------|
| `OTEL_LOG_USER_PROMPTS=1` | Prompt 文本 |
| `OTEL_LOG_TOOL_DETAILS=1` | 工具输入参数 |
| `OTEL_LOG_TOOL_CONTENT=1` | 完整工具 I/O（60KB 截断） |
| `OTEL_LOG_RAW_API_BODIES` | 完整 API 请求/响应 |

8 个 Metrics（含关键维度）：

| Metric | 关键 attributes |
|--------|----------------|
| `claude_code.session.count` | `start_type` (fresh/resume/continue) |
| `claude_code.lines_of_code.count` | — |
| `claude_code.pull_request.count` | — |
| `claude_code.commit.count` | — |
| `claude_code.cost.usage` | `model`, `query_source` (main/subagent/auxiliary), `speed` (fast), `effort` (low/medium/high/xhigh/max) |
| `claude_code.token.usage` | `type` (input/output/cacheRead/cacheCreation), `model`, `query_source`, `speed`, `effort` |
| `claude_code.code_edit_tool.decision` | `language`, `source` (config/hook/user_permanent/user_temporary/user_abort/user_reject) |
| `claude_code.active_time.total` | `type` (cli/user) |

17 个 Log Events：

| Event | 关键 attributes |
|-------|----------------|
| `claude_code.user_prompt` | `prompt.id`, `event.sequence` |
| `claude_code.tool_result` | `tool_name`, `success`, `prompt.id` |
| `claude_code.tool_decision` | `tool_name`, `decision` |
| `claude_code.api_request` | `model`, `cost_usd`, `prompt.id` |
| `claude_code.api_error` | `error_code`, `status_code` |
| `claude_code.api_request_body` | `body`, `body_length`, `model`（需 OTEL_LOG_RAW_API_BODIES） |
| `claude_code.api_response_body` | `body`, `body_length`（需 OTEL_LOG_RAW_API_BODIES） |
| `claude_code.api_retries_exhausted` | `total_attempts`, `total_retry_duration_ms` |
| `claude_code.compaction` | `trigger`, `success`, `duration_ms`, `pre_tokens`, `post_tokens` |
| `claude_code.hook_execution_start` | `hook_name`, `event_name` |
| `claude_code.hook_execution_complete` | `hook_name`, `duration_ms`, `exit_code` |
| `claude_code.mcp_server_connection` | `server_name`, `status`, `transport_type`, `duration_ms` |
| `claude_code.permission_mode_changed` | `from_mode`, `to_mode`, `trigger` |
| `claude_code.skill_activated` | `skill.name`, `invocation_trigger`, `skill.source` |
| `claude_code.auth` | `action`, `success`, `auth_method` |
| `claude_code.internal_error` | `error_name`, `error_code` |
| `claude_code.plugin_installed` | `plugin.name`, `plugin.version`, `install.trigger` |

事件关联字段：`prompt.id`（UUID，链接一个 user prompt 下的所有事件）、`event.sequence`（单调递增，事件排序）。

Traces span 层级 (beta)：
```
claude_code.interaction（一轮对话）
├── claude_code.llm_request（API 调用）
│   attrs: model, ttft_ms, attempt, stop_reason, response.has_tool_call,
│          gen_ai.system, gen_ai.request.model, llm_request.context (interaction/tool/standalone)
├── claude_code.tool（工具执行）
│   attrs: tool_name, duration_ms, result_tokens, file_path, full_command (gated)
│   ├── claude_code.tool.blocked_on_user（等待用户确认）
│   ├── claude_code.tool.execution（实际执行）
│   └── （Task 子 agent 的 spans 嵌套在此）
├── claude_code.hook（Hook 执行）
└── claude_code.subagent（子 agent）
```

W3C Trace Context 传播：自动传播 `TRACEPARENT` 到 Bash 子进程和 Agent SDK 子 agent。

Resource-level attributes：`service.name=claude-code`、`service.version`、`os.type`、`os.version`、`host.arch`、`wsl.version`。
Cardinality 控制：`OTEL_METRICS_INCLUDE_SESSION_ID`(默认 true)、`OTEL_METRICS_INCLUDE_VERSION`(默认 false)、`OTEL_METRICS_INCLUDE_ACCOUNT_UUID`(默认 true)。

#### Codex CLI OTel

Codex CLI (v0.124.0+) 也支持 OTel，通过 `~/.codex/config.toml` 的 `[otel]` section 启用：

```toml
[otel]
exporter = { otlp-grpc = { endpoint = "http://localhost:4317" } }
log_user_prompt = false  # 默认 redacted
```

支持 `otlp-http` 和 `otlp-grpc` 两种 exporter。

Log Events（关键 attributes）：

| Event | 关键 attributes |
|-------|----------------|
| `codex.conversation_starts` | `conversation.id`, `user.email`, `terminal.type` |
| `codex.api_request` | `model`, `cf_ray`, `auth_mode`, `duration_ms`, `status` |
| `codex.sse_event` | `input_token_count`, `output_token_count`, `cached_token_count`, `reasoning_token_count`, `tool_token_count` |
| `codex.websocket_request` / `codex.websocket_event` | `duration_ms`, `success`, `kind`, `error` |
| `codex.user_prompt` | `conversation.id` |
| `codex.tool_decision` | `tool_name`, `decision`, `call_id` |
| `codex.tool_result` | `tool_name`, `success`, `duration_ms`, `call_id` |

事件关联字段：`conversation.id`（宽关联键，跨所有事件）、`call_id`（仅 tool decision/result 路径，per tool call）。Per-model-call 级别的细粒度关联字段待实测确认。

Metrics：

| Metric | 说明 |
|--------|------|
| `codex.turn.e2e_duration_ms` | 端到端 turn 耗时 histogram |
| `codex.turn.ttft.duration_ms` | 首 token 延迟 histogram |
| `codex.approval.requested` | 审批请求计数（按 `tool`、`approved` 分） |
| `codex.mcp.call` | MCP 工具调用结果 |
| `codex.thread.started` | 线程启动（按 Git repo 存在性分） |
| `codex.conversation.turn.count` | 对话轮次计数 |
| `codex.skill.injected` | Skill 注入结果 |
| API/SSE/WebSocket duration | 请求耗时 histogram |

**重要架构差异**：Codex 的主要数据信号是 **OTel Logs**（非 Metrics）。SigNoz 的 Codex dashboard 完全基于 log attributes 聚合（如 `sum(input_token_count)`、`count_distinct(conversation.id)`）。TelemetryAdapter 对 Codex 侧需采用 log-based aggregation 模式，而非 Claude 的 metrics pipeline 模式。

Traces：`codex.session` root span + 子 span（API 调用、工具执行）。Resource: `service.name=codex_cli_rs`。

#### Hook 事件对比

两个 runtime 都支持 hook 机制。Claude Code 支持 29 种事件，Codex CLI 支持 6 种，交集为 6 种：

**共有事件（Dashboard 可统一采集）：**

| Hook 事件 | Claude Code | Codex CLI | 备注 |
|----------|------------|-----------|------|
| SessionStart | ✅ | ✅ | 会话开始/恢复 |
| UserPromptSubmit | ✅ | ✅ | 用户提交 prompt 前（可阻塞） |
| PreToolUse | ✅ | ✅ | 工具执行前；Codex 非 Bash-only，对暴露 `PreToolUsePayload` 的 handler 触发（Bash/unified exec/apply_patch/MCP tools）；matcher 控制过滤 |
| PostToolUse | ✅ | ✅ | 工具执行后 |
| PermissionRequest | ✅ | ✅ | 权限审批时 |
| Stop | ✅ | ✅ | 回复结束时 |

**Claude Code 独有事件（Dashboard 可利用的完整列表）：**

| Hook 事件 | 阻塞? | Dashboard 用途 |
|----------|-------|---------------|
| PostToolUseFailure | 否 | 工具失败事件流、错误率统计 |
| PostToolBatch | 是 | 批量工具调用结束后采集状态 |
| Notification | 否 | permission_prompt/idle 等通知事件 |
| SubagentStart / SubagentStop | 否/是 | 子代理生命周期追踪 |
| TaskCreated / TaskCompleted | 是 | Task 调度事件流 |
| TeammateIdle | 是 | Agent team 成员空闲检测 |
| SessionEnd | 否 | 会话终止信号 |
| StopFailure | 否 | API 错误（rate_limit/auth_failed/billing）分类 |
| UserPromptExpansion | 是 | 命令展开（扩展命令审计） |
| PermissionDenied | 否 | 被拒绝的工具调用统计 |
| InstructionsLoaded | 否 | CLAUDE.md/rules 加载事件 |
| ConfigChange | 是 | 配置变更审计 |
| CwdChanged | 否 | 工作目录切换追踪 |
| FileChanged | 否 | 状态文件变更通知（字面文件名匹配） |
| WorktreeCreate / WorktreeRemove | 是/否 | Worktree 生命周期 |
| PostCompact | 否 | 压缩完成后状态快照 |
| Elicitation / ElicitationResult | — | MCP 用户交互事件 |
| Setup | 否 | 启动时 init/maintenance 标记 |

**不纳入的事件：**

| Hook 事件 | 原因 |
|----------|------|
| PreCompact | zylos-core 框架设计上避免触发 auto compact，此事件不应发生 |

**Dashboard 利用 hook 的两种模式：**

| 模式 | Phase | 说明 |
|------|-------|------|
| 间接消费（读文件） | Phase 1 | activity-monitor 已有的 hook（PostToolUse/SessionStart/Stop 等）将数据写入 status files 和 JSONL，Dashboard 通过 FileAdapter 读取这些产出物 |
| 直接 ingestion（HookAdapter） | Phase 2 | Dashboard 自身注册 hook handler，实时接收事件流，不依赖中间文件 |

**HookAdapter 重点事件（Phase 2）：**

| 事件 | 采集内容 |
|------|---------|
| PostToolUse | 实时工具调用事件流（替代 JSONL 轮询） |
| PostToolUseFailure | 错误率、失败分类 |
| SessionStart / SessionEnd | 会话生命周期精确时间戳 |
| Stop / StopFailure | Turn 边界 + API 错误分类告警 |
| SubagentStart / SubagentStop | 子代理追踪 |
| FileChanged | 监听状态文件变更驱动 WebSocket 推送 |

**Hook handler 类型：**

| 类型 | Claude Code | Codex CLI | 说明 |
|------|------------|-----------|------|
| command | ✅ | ✅ | Shell 命令，stdin 接收 JSON |
| http | ✅ | ❌ | POST 到远程端点 |
| mcp_tool | ✅ | ❌ | 调用 MCP server 工具 |
| prompt | ✅ | ❌（解析但不执行） | 单轮 Claude 评估 |
| agent | ✅ | ❌ | 子 agent（实验性） |

**Codex hook 关键限制（源码确认）：**

- 所有 hook 同步阻塞执行（`async` 字段存在于 schema 但未实现）
- PreToolUse 只能 block/deny，不能 approve（approve 会 fail open）
- PreToolUse 的 `updatedInput` 和 `additionalContext` 在 schema 中定义但未实现（返回会导致失败）
- PostToolUse 的 `updatedMCPToolOutput` 同样未实现
- 非 JSON 的 stdout 如果以 `{` 或 `[` 开头会导致解析失败（SessionStart 和 UserPromptSubmit 除外）
- 默认超时 600 秒，最小 1 秒

配置路径：
- Claude Code：`~/.claude/settings.json` → `hooks` 字段（支持 project/local/user 三层）
- Codex CLI：`~/.codex/hooks.json` 或 `<repo>/.codex/hooks.json`（project/user 两层 + plugin `hooks.json`）

#### 其他数据源（runtime 无关）

| 数据源 | 说明 |
|--------|------|
| 状态文件 | `agent-status.json`、`proc-state.json` 等，由 activity-monitor hook 写入，两个 runtime 均可用 |
| StatusLine | `statusline.json`（仅 Claude runtime，含 context%/cost/rate limits/tokens） |
| PM2 | 进程级监控，runtime 无关 |
| C4 通信 | `c4.db`，runtime 无关 |
| Scheduler | `scheduler.db`，runtime 无关 |

## 2. 设计目标

### 2.1 核心目标

1. **状态总览**：一屏看到 agent 当前状态、健康度、活跃工具
2. **成本追踪**：session 级和日级别的 token/成本统计，趋势图
3. **任务监控**：计划任务执行状态、成功率、下次执行时间
4. **通信概览**：各渠道消息量、响应时间分布
5. **服务健康**：PM2 服务运行状态、重启次数、内存/CPU
6. **Multi-runtime OTel 集成**：接入 Claude Code 和 Codex CLI 原生遥测，实现请求级追踪

### 2.2 设计约束

- **只读原则**：不执行写操作（不修改配置、不重启服务、不发消息）
- **零侵入**：不修改现有 activity-monitor、scheduler、comm-bridge 的代码
- **zylos 组件规范**：遵循 `zylos add` 标准，可被其他 zylos 实例复用
- **轻量依赖**：Node.js 生态优先（与 zylos 技术栈一致），避免 Python/Java/Docker 重依赖

## 3. 统一指标模型

Dashboard 的核心抽象。用户看到统一的指标，不关心底层来自哪个数据源。

### 3.1 指标目录

| 指标 | 语义 | 单位 | Claude | Codex | Resolver chain（优先级递减） |
|------|------|------|--------|-------|--------------------------|
| **agent_state** | Agent 当前状态 | idle/busy/thinking/error/stopped | ✅ | ✅ | hook lifecycle → status file → PM2 |
| **current_tool** | 当前执行的工具 | string | ✅ | ✅ | hook Pre/PostToolUse → status file |
| **tool_calls** | 工具调用事件流 | event stream | ✅ | ✅ | telemetry → hook → JSONL fallback |
| **tool_failures** | 工具执行失败 | event stream | ✅ | ✅ (`codex.tool_result`) | telemetry → PostToolUseFailure (Claude) / tool_result inference → status fallback |
| **tool_duration** | 工具执行耗时 | ms | ✅ | ✅ (OTel metric) | telemetry → Pre/Post 时间差 |
| **context_usage** | Context window 使用率 | % | ✅ | ✅ | Claude: telemetry → statusLine → context-monitor-state.json；Codex: `CodexContextMonitor.getUsage()`（JSONL rollout → SQLite fallback），数据可用但当前未持久化到 status file，需补 file write 或 Dashboard 直接调用 |
| **token_usage** | Token 消耗 | count | ✅ | ✅/verify (`sse_event` token counts) | telemetry → statusLine → cost-log |
| **session_cost** | Session 成本 | USD | ✅ | ✅/verify (需确认 cost 字段) | telemetry → statusLine → cost-log |
| **llm_latency** | LLM 请求延迟 | ms (P50/P95/P99) | ✅ | ✅/verify (API duration ≠ llm_request span，需 audit) | telemetry span / metric |
| **session_lifecycle** | Session 启动/结束 | event | ✅ | ✅ | SessionStart hook（两端均支持）→ status file |
| **permission_requests** | 权限审批 | event stream | ✅ | ✅ | PermissionRequest hook（两端均支持） |
| **health** | 健康/心跳 | healthy/degraded/error | ✅ | ✅ | status file (health + watchdog_phase) |
| **cache_hit_rate** | Prompt cache 命中率 | % | ✅ | ✅ | Claude: token.usage cacheRead/(cacheRead+input)；Codex: sse_event cached_token_count/(cached+input) |
| **ttft** | 首 token 延迟 | ms | ✅ (span attr) | ✅ (`codex.turn.ttft.duration_ms`) | telemetry span/metric |
| **usage_leverage** | 自主工作比 | ratio | ✅ | — | 派生：active_time(cli) / active_time(user) |
| **pm2_services** | PM2 服务状态 | structured | ✅ | ✅ | pm2 jlist（runtime 无关） |
| **messages** | 通信消息量 | count + event | ✅ | ✅ | c4.db（runtime 无关） |
| **scheduled_tasks** | 计划任务状态 | structured | ✅ | ✅ | scheduler.db（runtime 无关） |

`✅/verify` 表示 capability=supported 但字段映射需 Phase 2 实测验证。

### 3.2 两层状态模型

每个指标对每个 runtime 有两层状态：

**capability**（静态，文档定义）：
- `supported` — 正式支持
- `supported/beta` — 支持但 API 不稳定
- `unsupported` — 不支持
- `planned` — 计划中

**availability**（动态，resolver 实时判断）：
- `ok` — 数据正常
- `degraded` — 使用了 fallback 来源或数据部分缺失
- `stale` — 数据存在但超过 freshness 阈值
- `missing` — capability=supported 但数据未到达（如 collector 未开启）
- `error` — 数据源报错

前端处理：
- `capability=unsupported` → 隐藏或灰态，不进入 resolver
- `availability=ok` → 正常展示
- `availability=degraded` → 黄灯 + fallback 来源
- `availability=stale` → 黄灯 + 最后更新时间
- `availability=missing` → 灰态 + "数据未收集"
- `availability=error` → 红灯 + 错误信息

### 3.3 来源优先级与 Resolver

全局优先级：**telemetry > hook > 状态文件**

Resolver 按指标查找所有 adapter 的 capability，收集 resolve 结果，按以下 ranking 选出最终结果：

1. **最高优先级 adapter 且 availability=ok** → 直接选中
2. **任意 adapter availability=ok** → 选优先级最高的 ok（跳过 stale/degraded 的高优来源）
3. **degraded** → 仅在没有 ok 结果（或指标声明 `degradedAcceptable`）时选中
4. **stale** → 不压过更新鲜的低优来源，仅在没有 ok/degraded 时选中
5. **全部 missing/error** → 返回最高优先级 adapter 的状态

核心规则：**freshness 优先于 source priority**。

Resolver 输出统一结构：

```json
{
  "value": 42,
  "availability": "ok",
  "capability": "supported",
  "source": "hook",
  "preferredSource": "telemetry",
  "fallbackReason": null,
  "confidence": "high",
  "updatedAt": "2026-05-01T16:00:00Z"
}
```

示例：

```
resolve("tool_calls", "claude"):
  TelemetryAdapter → missing (collector not running)
  HookAdapter      → ok, value=[...]
  FileAdapter      → ok, value=[...]
  ranking: HookAdapter ok（优先级高于 FileAdapter）
  → source="hook", preferredSource="telemetry", fallbackReason="telemetry_missing"

resolve("context_usage", "codex"):
  FileAdapter       → ok, value=62.5 (activity-monitor 调用 CodexContextMonitor.getUsage() 后写入 status file, updated 28s ago)
  → source="status_file", preferredSource="telemetry", fallbackReason="telemetry_missing"
  注：需在 activity-monitor 的 Codex context polling callback 中补一行 state file write（当前只驱动 threshold 回调）

resolve("context_usage", "claude"):
  TelemetryAdapter  → stale (last update 5min ago)
  StatusLineAdapter → ok, value=72.3 (updated 2s ago)
  ranking: StatusLineAdapter ok 优先于 TelemetryAdapter stale
  → source="statusline", preferredSource="telemetry", fallbackReason="telemetry_stale"

resolve("permission_requests", "claude"):
  HookAdapter      → ok, value=[...] (PermissionRequest hook, Phase 2)
  → source="hook", preferredSource="hook"
```

### 3.4 Freshness 规则

按指标类型分别定义，不用全局硬编码阈值：

| 指标类型 | freshness 规则 |
|---------|---------------|
| event-stream 类（tool_calls, tool_failures） | 超过 N 秒无事件不一定 degraded，除非另一来源显示 agent 处于 active 状态 |
| state 类（agent_state, health） | 超过 2× heartbeat interval 未更新 → stale |
| cost/token 类 | 交互结束后一段时间仍未更新 → degraded |
| PM2/health 类 | 轮询失败一次 → stale，连续失败 → degraded/error |

各阈值均可在 config 中 per-metric override。

## 4. 架构方案

### 4.1 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser (Web UI)                       │
│   Vanilla JS + Chart.js — 统一指标视图，不区分数据来源       │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP / SSE
┌──────────────────────────┼──────────────────────────────────┐
│                   Dashboard API Server                       │
│                   (Node.js, Caddy route)                     │
│                                                              │
│   ┌─────────────────────────────────────────────────────┐   │
│   │                  Metric Resolver                     │   │
│   │   per-metric: capability check → adapter ranking     │   │
│   │   → freshness check → select best result             │   │
│   └──────────────┬───────────────────────────────────────┘   │
│                  │                                            │
│   ┌──────────────┼───────────────────────────────────────┐   │
│   │              Adapter Layer                            │   │
│   │                                                      │   │
│   │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │   │
│   │  │ Telemetry    │  │ File         │  │ SQLite     │ │   │
│   │  │ Adapter      │  │ Adapter      │  │ Adapter    │ │   │
│   │  │ (Claude +    │  │ (JSON/JSONL) │  │ (c4.db,    │ │   │
│   │  │  Codex OTLP) │  │              │  │ sched.db)  │ │   │
│   │  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │   │
│   │         │                 │                 │        │   │
│   │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │   │
│   │  │ Hook         │  │ StatusLine   │  │ PM2        │ │   │
│   │  │ Adapter      │  │ Adapter      │  │ Adapter    │ │   │
│   │  │ (Claude +    │  │ (Claude      │  │            │ │   │
│   │  │  Codex hooks)│  │  only)       │  │            │ │   │
│   │  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │   │
│   └─────────┼────────────────┼────────────────┼─────────┘   │
└─────────────┼────────────────┼────────────────┼─────────────┘
              │                │                │
     ┌─────────┴────────┐      │           ┌────┴──────┐
     │  OTel Collector  │      │           │  PM2 bus  │
     │  (localhost)     │      │           └───────────┘
     └────────┬────────┘      │
          ┌───┴────┐          │
     Claude Code  Codex CLI   │
     (env var)    (config.toml)│
                               │
                  activity-monitor/ + comm-bridge/ + scheduler/
```

### 4.2 Adapter 实现

每个 adapter 实现统一接口：

```
interface MetricAdapter {
  capabilities(runtime: "claude" | "codex"): Map<MetricName, Capability>
  resolve(metric: MetricName, runtime: "claude" | "codex"): MetricResult
  history(metric: MetricName, runtime: "claude" | "codex", timeRange: TimeRange): MetricResult[]
  health(): AdapterHealth
}
```

| Adapter | 数据来源 | Phase | 覆盖指标 |
|---------|---------|-------|---------|
| **FileAdapter** | activity-monitor JSON/JSONL | Phase 1 | agent_state, current_tool, tool_calls, tool_duration, health, context_usage (Claude via context-monitor-state.json；Codex 需补 state file write 后同路径可用) |
| **StatusLineAdapter** | statusline.json (Claude only) | Phase 1 | context_usage, token_usage, session_cost, cache_hit_rate |
| **SQLiteAdapter** | c4.db, scheduler.db (readonly) | Phase 1 | messages, scheduled_tasks |
| **PM2Adapter** | pm2 jlist | Phase 1 | pm2_services |
| **HookAdapter** | Hook 事件流（6 共有 + Claude 独有扩展） | Phase 2 | tool_calls, tool_failures, agent_state, session_lifecycle, permission_requests |
| **TelemetryAdapter** | OTel OTLP 接收端（multi-runtime） | Phase 2 | token_usage, session_cost, llm_latency, cache_hit_rate, tool_calls, tool_failures, tool_duration |

TelemetryAdapter 内部按 runtime 分 codec：
- **Claude codec**：消费 OTel Metrics（`claude_code.*`）+ Logs + Traces
- **Codex codec**：消费 OTel Logs（`codex.*` 事件，按 attributes 聚合）+ Metrics（`codex.turn.*` 等）+ Traces
- 关键差异：Claude 主信号是 metrics pipeline，Codex 主信号是 logs pipeline（log-based aggregation）

**派生指标**（由 TelemetryAdapter 计算，不直接来自 OTel）：

| 派生指标 | 公式 | 来源 |
|---------|------|------|
| cache_efficiency_pct | cacheRead / (cacheRead + input) × 100 | token.usage by type |
| cost_leverage | actual_api_cost / subscription_time_equivalent | cost.usage + active_time |
| usage_leverage | cli_time / user_time | active_time.total by type |
| tokens_per_turn | token.usage / turn_count | 聚合 |

**事件链重建**：通过 `prompt.id`（Claude）和 `conversation.id`（Codex）字段，可串联一次交互下的所有 log events，重建完整执行流程。

### 4.3 技术选型

| 层 | 选型 | 理由 |
|---|------|------|
| 后端 | Node.js + Express/Fastify | 与 zylos 技术栈一致 |
| 前端 | Vanilla JS + Chart.js | 零构建、即开即用 |
| 数据读取 | better-sqlite3 (readonly) + fs.watch + polling | 三层只读保护；fs.watch 提示 + 5-10s polling 兜底 |
| 实时推送 | SSE + polling fallback | 只读无需双向；SSE 推薄事件通知，客户端按需 REST 拉数据 |
| OTel 接收 | @opentelemetry/sdk-node | 轻量 OTLP 接收端，Claude 和 Codex 共用 |
| OTel 存储 | SQLite (dashboard 自有 DB) | 不污染已有数据库 |
| 部署 | PM2 + Caddy route | zylos 标准方式 |

### 4.4 数据源详解

#### 已有数据（Phase 1 直接读取）

| 数据源 | 文件 | 更新频率 | 读取方式 | runtime 依赖 |
|--------|------|---------|---------|-------------|
| Agent 状态 | `agent-status.json` | ~1s | fs.watch + JSON parse | 无 |
| Statusline | `statusline.json` | 每 turn | fs.watch | Claude only |
| Session 成本 | `cost-log.jsonl` | session 结束 | 启动全量 + tail 增量 | 无 |
| 工具事件 | `tool-events.jsonl` | 实时 | tail -f 流式 | 无 |
| Context 状态 | `context-monitor-state.json` | 定期 | fs.watch | Claude：statusline hook 每 turn 写入。Codex：zylos-core `CodexContextMonitor` 已能读取（JSONL rollout `last_token_usage.input_tokens` + SQLite fallback），零 token 消耗，但 **当前仅驱动 threshold 回调，未写入此文件**——需在 activity-monitor polling loop 补一行 `writeFileSync` |
| 进程采样 | `proc-state.json` | ~10s | fs.watch | 无 |
| 配额 | `usage.json` | 定期 | fs.watch | 无 |
| 通信记录 | `c4.db` | 消息到达 | SQLite readonly | 无 |
| 任务调度 | `scheduler.db` | 任务执行 | SQLite readonly | 无 |

#### OTel 数据（Phase 2）

Dashboard 内嵌轻量 OTel Collector 接收端，接收两个 runtime 的 OTLP 输出并写入自有 SQLite。

Claude Code 配置（env var）：
```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_TRACES_EXPORTER=otlp
OTEL_RESOURCE_ATTRIBUTES="agent.name=zylos01"
```

Codex CLI 配置（config.toml）：
```toml
[otel]
exporter = { otlp-grpc = { endpoint = "http://localhost:4317" } }
log_user_prompt = false
```

两个 runtime 的遥测数据经同一 Collector 进入同一 pipeline，由 TelemetryAdapter 按事件前缀分别解析。

## 5. 功能模块

### 5.1 Phase 1 — MVP

> 目标：2 周内可用，零侵入。数据来源：状态文件 + SQLite + PM2 + StatusLine (Claude)

**实时状态面板**
- Agent 状态指示灯（idle / busy / thinking / error）
- 当前活跃工具名称和运行时长
- Context 使用率仪表盘（两端均可用：Claude via statusline，Codex via CodexContextMonitor；需补 state file write）
- 配额使用率
- 运行时间

**成本分析**
- 每日/每周/每月成本趋势图
- 单 session 成本分布
- 日均/周均统计

**工具调用分析**
- 工具使用频率排行
- 执行耗时分布
- 成功/失败率
- 时间线视图

**通信概览**
- 各渠道消息量统计
- 每日消息量趋势
- 响应时间分布
- 最近消息列表（脱敏）

**任务调度监控**
- 活跃任务列表
- 执行历史（成功/失败/跳过）
- 下次执行时间

**PM2 服务健康**
- 运行状态（online/stopped/errored）
- 重启次数、内存/CPU
- 日志预览

### 5.2 Phase 2 — Multi-Runtime OTel

> 目标：接入 Claude Code + Codex CLI 原生遥测，实现请求级深度可观测性

**请求追踪**
- Interaction → llm_request → tool 追踪瀑布图（Claude span hierarchy；Codex span 结构待验证）
- 每次 API 请求的 token 消耗
- 工具调用链可视化

**性能分析**
- LLM 请求延迟 P50/P95/P99（Claude `llm_request` span；Codex API duration metric，语义映射待验证）
- Cache hit rate 追踪（multi-runtime：Claude via cacheRead token type，Codex via cached_token_count）
- 工具执行延迟分布

**异常检测**
- 工具执行超时
- 异常高 token 消耗
- 连续失败模式识别

### 5.3 Phase 3 — 多实例

> 目标：多个 zylos 实例的集中监控

- 多 agent 状态对比
- 跨实例成本汇总
- 实例间性能对比
- 通过 `OTEL_RESOURCE_ATTRIBUTES` 区分实例

## 6. 组件结构

```
~/zylos/.claude/skills/dashboard/
├── SKILL.md
├── scripts/
│   ├── server.js                # API server 主入口
│   ├── resolver.js              # Metric Resolver 引擎
│   ├── adapters/
│   │   ├── file-adapter.js      # JSON/JSONL 状态文件
│   │   ├── statusline-adapter.js # statusline.json (Claude only)
│   │   ├── sqlite-adapter.js    # c4.db + scheduler.db (readonly)
│   │   ├── pm2-adapter.js       # pm2 jlist
│   │   ├── hook-adapter.js      # Hook 事件流 (Phase 2)
│   │   └── telemetry-adapter.js # OTel OTLP (Phase 2, multi-runtime)
│   ├── otel/
│   │   ├── collector.js         # OTel OTLP 接收端
│   │   ├── claude-codec.js      # claude_code.* 事件解析
│   │   ├── codex-codec.js       # codex.* 事件解析
│   │   └── storage.js           # OTel 数据 → SQLite
│   └── sse.js                   # SSE 实时推送
├── public/
│   ├── index.html
│   ├── css/dashboard.css
│   └── js/
│       ├── app.js
│       ├── charts.js
│       └── events.js            # SSE + polling fallback
└── references/

~/zylos/components/dashboard/
├── config.json
├── dashboard.db                 # OTel 数据 (Phase 2)
└── logs/
```

## 7. 部署

### 7.1 Caddy 路由

走 http_routes marker block：

```
handle_path /dashboard/* {
    reverse_proxy localhost:{DASHBOARD_PORT}
}
```

访问地址：`https://zylos01.jinglever.com/dashboard/`

### 7.2 PM2 服务

```yaml
service:
  name: zylos-dashboard
  entry: scripts/server.js
```

## 8. 安全

### 8.1 数据只读保护

- **SQLite 三层只读**：URI `?mode=ro` + `fileMustExist: true` + `PRAGMA query_only = ON`
- **查询即开即关**：不持长事务，避免 WAL checkpoint 被拖住
- **无外部网络依赖**：仅读取本地文件和数据库

### 8.2 访问控制

- **认证**：管理界面登录后发 HttpOnly + SameSite=Strict cookie；REST API 和 SSE 走同源 cookie；CLI 支持 `Authorization: Bearer <token>`
- **URL token 默认关闭**：有泄露面（浏览器历史、access log、Referer），仅 localhost + 显式配置时可用
- **绑定 localhost**：server 只监听 127.0.0.1，外部走 Caddy 反代

### 8.3 敏感信息保护

- **字段白名单**：API 只返回状态、计数、时间戳、成本等聚合数据，不返回 prompt 原文、.env 值、消息正文
- **工具事件脱敏**：只返回 tool_name、duration、success，不返回输入参数
- **OTel 数据本地存储**：不发送到外部 SaaS

### 8.4 OTel 安全清单（Phase 2 必做）

1. **Prompt redaction 验证**：Claude (`OTEL_LOG_USER_PROMPTS` 默认关) 和 Codex (`log_user_prompt` 默认 false) 均确认 prompt 不出现在 traces/logs 中
2. **Collector 仅 localhost**：OTel 数据不直接发往外部，必须经本地 collector 中转
3. **Payload field audit**：两个 runtime 的 OTel 输出逐字段检查，确认无 .env 值、API key、消息正文
4. **Exporter flush**：验证两个 runtime 的 exporter 在 agent 退出时正确 flush 未发数据
5. **默认不采集 prompt 内容**：如启用，配置中标记为高风险选项

### 8.5 API 降级语义

每个 adapter 独立 health check，resolver 输出包含 per-metric availability 状态（见 §3.2）。单个 adapter 故障不影响其他指标展示。

## 9. 与 COCO Dashboard 的关系

| | Zylos Dashboard | COCO Dashboard |
|---|---|---|
| 目标用户 | Agent 运维者（开发团队） | COCO 平台客户（企业管理者） |
| 监控对象 | 单个 zylos agent 实例的运行时 | 企业的 AI 员工管理 |
| 数据来源 | 本地文件/DB/OTel | COCO 平台 API |
| 部署方式 | 每个 zylos 实例自带 | COCO 平台 SaaS |

技术上有借鉴意义：zylos-dashboard 的 agent 可观测性探索可反哺 COCO Dashboard 的 AI Ops 模块。

## 10. 验证清单

### P0（MVP 上线前必过）

1. SQLite readonly smoke test（不存在不创建、INSERT 失败、SELECT 正常）
2. SQLite 并发压测（WAL 下写入循环 + dashboard 高频查询，观察 writer latency 和 WAL 增长）
3. JSON watcher 稳定性（原地写、temp+rename、半截 JSON、1000 次快速更新）
4. Caddy 路由验证（validate + reload + healthz + 现有路由不受影响）
5. Dashboard 资源基线（空闲、单客户端、5 客户端、持续更新 10 分钟，记录 RSS/CPU/事件延迟）

### P1（Phase 2 前必过）

6. OTel 隔离测试（独立 HOME/测试进程/localhost collector，对比 on/off 延迟和资源）
7. OTel payload 敏感信息检查（§8.4 安全清单全部通过）
8. JSONL rotation 测试（copytruncate、rename-create、truncate 下 tail offset 恢复）
9. Caddy SSE 缓冲验证（是否需要 `flush_interval -1`）
10. Codex OTel 字段映射验证（`codex.*` 事件逐字段映射到统一指标，确认 token/cost/latency 语义）
11. Claude OTel 字段映射验证（`claude_code.*` 事件逐字段确认与文档一致）

## 11. 开放问题

1. **OTel 数据量管理**：两个 runtime 的 OTel 输出可能非常详细，需确定保留策略（天数、采样率）
2. **多实例数据汇聚**：Phase 3 需要数据传输机制（push vs pull？通过 HXA？）
3. **Codex OTel 字段映射**：事件名 (`codex.*`) 和字段 shape 与 Claude (`claude_code.*`) 不同，需实测建立映射表。关键待确认：`codex.sse_event` token count 字段名、`codex.tool_result` success/failure 标志、traces span 层级
4. **Codex context_usage**：数据源已有。zylos-core `CodexContextMonitor` 每 30 秒读 JSONL rollout（`last_token_usage.input_tokens` + `model_context_window`）/ SQLite fallback，零 token 消耗。**待做**：activity-monitor polling callback 补写 `context-monitor-state.json`（当前仅驱动 threshold 回调，未持久化），Dashboard 即可通过 FileAdapter 读取
5. **llm_latency 语义对齐**：Codex API duration metric 与 Claude `llm_request` span 语义不一定等价，Phase 2 audit 验证

## 12. 里程碑

| Phase | 范围 | 预计工期 | 依赖 |
|-------|------|---------|------|
| Phase 1 MVP | 状态文件 + SQLite + PM2 + StatusLine 可视化 | 1-2 周 | 无 |
| Phase 2 OTel + Hook | Multi-runtime OTel adapter + HookAdapter 直接 ingestion，字段映射验证，安全清单 | 1-2 周 | 验证清单 P1 通过 |
| Phase 3 Multi | 多实例集中监控 | TBD | Phase 2 + 多实例部署 |

## 附录：决策记录

| 决策项 | 结论 | 来源 |
|--------|------|------|
| MVP 边界 | 只读、可降级、可观测自身资源 | v1.2 Jinglever review |
| OTel | 不进 MVP，Phase 2 multi-runtime spike | v1.3 Howard 方向 |
| SQLite 只读 | URI readonly + fileMustExist + PRAGMA query_only，查询即开即关 | v1.2 Jinglever review |
| 文件监控 | fs.watch 提示 + 5-10s polling 兜底（temp+rename 下 inotify 不可靠） | v1.2 Jinglever review |
| Caddy | 走 http_routes marker block | v1.2 Jinglever review |
| 实时刷新 | SSE 薄事件 + REST 拉数据 + polling fallback | v1.2 Jinglever review |
| 前端 | Vanilla JS + Chart.js | v1.2 Jinglever review |
| 认证 | Cookie (HttpOnly+SameSite) 为主，Authorization 为辅，URL token 默认关 | v1.2 Jinglever review |
| 降级 | per-metric availability，单指标故障不影响全局 | v1.3 Jinglever review |
| 时间窗口 | 默认 24h，list endpoint 硬性 limit，5min bucket downsample | v1.2 Jinglever review |
| PM2 | `pm2 jlist` 10s 轮询 + 5s timeout + 失败降级 | v1.2 Jinglever review |
| 多 runtime | 指标并集覆盖，unsupported 不假补 | v1.3 Howard 方向 |
| 统一视图 | 不按数据来源拆版面 | v1.3 Howard 方向 |
| 来源优先级 | telemetry > hook > 状态文件 | v1.3 Howard 方向 |
| capability/availability | 静态能力 vs 动态状态拆两层 | v1.3 Jinglever review |
| freshness > priority | fresh 低优来源胜过 stale 高优来源 | v1.3 Jinglever review |
| Codex OTel | supported（config.toml [otel]），非 unsupported | v1.3 Howard 文档发现 |
| llm_latency Codex | supported/verify（API duration ≠ llm_request span） | v1.3 Jinglever review |
| TelemetryAdapter | multi-runtime，按 `claude_code.*` / `codex.*` 前缀分 codec | v1.3 共识 |

---

*文档版本: v2.0*
*创建日期: 2026-05-01*
*作者: zylos01*
*Review: Jinglever (v1.2 architecture + v1.3 multi-runtime spec, 4 rounds)*
