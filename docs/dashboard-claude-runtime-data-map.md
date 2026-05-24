# Dashboard Claude Runtime 数据采集与产品指标

更新时间：2026-05-25

本文基于 `zylos-dashboard` 最新 `main` 分支 `82e7e3b` 梳理 Claude Runtime 当前已经实现的数据采集方式、入库形态，以及这些数据在 Dashboard 产品上的指标对应关系。

## 当前代码范围

| 范围 | 路径 |
|---|---|
| Dashboard main worktree | `/Users/howard/zylos/workspace/zylos-dashboard-frontend` |
| Hook 安装 | `src/lib/hook-installer.js` |
| Hook 采集入口 | `src/lib/hook-ingest.cjs`, `src/lib/ingest-handler.js`, `src/lib/spool-drainer.js` |
| Hook 脱敏与摘要 | `src/lib/sanitizer.js` |
| Claude StatusLine 采集 | `src/lib/statusline-ingest.cjs`, `src/lib/collectors/statusline-collector.js` |
| Claude JSONL 采集 | `src/lib/collectors/conversation-collector.js` |
| 状态推导 | `src/lib/state-engine.js` |
| 指标解析与聚合 | `src/lib/metric-resolver.js`, `src/lib/store.js` |
| 前端展示 | `public/js/app.js`, `public/i18n/zh.json`, `public/i18n/en.json` |

## 数据源总览

| 数据源 | 采集方式 | 入库表 / 输出 | Runtime 依赖 | 产品用途 |
|---|---|---|---|---|
| Claude Code hooks | `~/.claude/settings.json` 中注册 command hook，hook 进程读取 stdin JSON 后 POST 到本地 `/api/ingest` | `runtime_events` | Claude | 实时运行状态、当前工具、工具流、权限请求、子 Agent、Timeline |
| Claude StatusLine stdin | `settings.statusLine.command = node src/lib/statusline-ingest.cjs`，Claude 调用 statusLine command 时把 JSON 传入 stdin | `metric_points`；同时输出短 statusline 文本给 Claude UI | Claude | Context、成本、Rate limit、当前模型、effort、Claude Code 版本 |
| `activity-monitor/statusline.json` | Dashboard `StatuslineCollector` 读取同一份 statusline JSON 文件，`fs.watch` + 初始采集 | `metric_points`；runtime info 内存缓存 | Claude | Context、成本、Rate limit、缓存命中率、模型/effort/版本 |
| Claude conversation JSONL | `ConversationCollector` 根据当前 session id 读取 `~/.claude/projects/<project>/<session>.jsonl` 增量内容 | `runtime_events`, `metric_points` | Claude | assistant message、API request tokens、API request cost、缓存命中率、项目分布 |
| Activity Monitor heartbeat | `StateEngine` 读取 `activity-monitor/agent-status.json` | `source_health`；内存状态信号 | Runtime 无关 | OFFLINE / UNKNOWN / BUSY / IDLE 判定的 liveness 证据 |
| PM2 | `pm2 jlist` 定时采样 | `metric_points`；内存缓存 | Runtime 无关 | PM2 服务数量、服务在线状态、CPU、内存、重启、uptime |
| System | Node `os`、macOS `vm_stat`、`fs.statfsSync` 定时采样 | `metric_points`；内存缓存 | Runtime 无关 | CPU、内存、磁盘 |
| C4 comm-bridge DB | readonly 打开 `comm-bridge/c4.db` 查询 | API 直接返回，不写 Dashboard DB | Runtime 无关 | 消息吞吐、待处理队列、最后 outbound、平均响应时间 |

## Claude Hook 安装

Claude Runtime 下 `HookInstaller.install()` 会调用 `installClaudeHooks()` 和 `installStatusline()`。

### Hook events

当前 `main` 对 Claude 安装 7 类 hook：

| Hook event | settings 写入方式 | 产品用途 |
|---|---|---|
| `PreToolUse` | `hooks[event][]` command hook，`matcher = ""` | 工具开始、当前工具、BUSY 状态 |
| `PostToolUse` | command hook，`matcher = ""` | 工具结束、工具调用统计、Timeline |
| `UserPromptSubmit` | command hook | turn 开始、prompt 来源、BUSY/Thinking 状态 |
| `Stop` | command hook | turn 结束、最后 assistant 输出摘要 |
| `PermissionRequest` | command hook | 权限请求、等待人工确认信号 |
| `SubagentStart` | command hook | 子 Agent 开始、子 Agent 列表 |
| `SubagentStop` | command hook | 子 Agent 结束、清理子 Agent 状态 |

hook 命令为：

```text
node <dashboard-root>/src/lib/hook-ingest.cjs
```

每个 hook entry 设置：

| 字段 | 值 |
|---|---|
| `type` | `command` |
| `timeout` | `5` |
| `async` | `true` |

### StatusLine

Claude Runtime 下还会写入：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node <dashboard-root>/src/lib/statusline-ingest.cjs",
    "refreshInterval": 5
  }
}
```

如果已有非 Dashboard 自己的 `statusLine.command`，当前代码不会覆盖。

## Hook 采集链路

### hook-ingest

`hook-ingest.cjs` 是 Claude hook 进程入口。它只使用 Node built-ins，并设置 500ms 硬退出：

| 步骤 | 行为 |
|---|---|
| 读取 stdin | 解析 Claude hook JSON |
| 过滤事件 | 只接受 7 类允许事件 |
| 补字段 | 生成 `ingest_id`、`received_at`、`runtime` |
| POST | 向 `http://127.0.0.1:<port>/api/ingest` 发送 JSON |
| 鉴权 | 如果 `config.json` 有 `ingestToken`，带 `Authorization: Bearer <token>` |
| 超时 | HTTP POST 200ms abort |
| 失败降级 | POST 失败时追加到 `components/dashboard/spool/hook-events.jsonl` |
| 退出 | 成功、失败、异常都 `exit(0)` |

spool 最大值默认 10MB，由 `spoolMaxBytes` 控制。

### ingest-handler

Dashboard 服务端 `/api/ingest` 只接受 loopback 请求，并拒绝代理路径。处理流程：

| 步骤 | 行为 |
|---|---|
| 来源检查 | 只允许 `127.0.0.1` / `::1` / `::ffff:127.0.0.1` |
| token 检查 | `config.ingestToken` 存在时校验 Bearer token |
| body 限制 | JSON body 64KB |
| 事件校验 | 只处理允许 hook event |
| 脱敏摘要 | `Sanitizer.sanitizeHookPayload()` |
| canonical event | 映射为 `event_type` / `category` |
| 入库 | `Store.insertEvent()` 写入 `runtime_events` |
| 状态更新 | 成功插入后调用 `stateEngine.onEvent(event)` |
| source health | 写入 `hook_handler` 与 `hook_events` 健康状态 |

`SpoolDrainer` 在 Dashboard 启动时先做 DB-only drain；服务运行后每 30 秒 drain 一次，并用 `ingest_id` 去重。

## Hook Payload 保留字段

`Sanitizer` 不保存原始 `tool_input`、`tool_response`、`prompt`、`content`、`message`。它从原始 hook payload 中提取少量结构化字段：

| 来源字段 | 入库位置 | 说明 |
|---|---|---|
| `session_id` | `runtime_events.session_id` | session 关联 |
| `duration_ms` | `runtime_events.duration_ms` | 如果 hook payload 提供 |
| `tool_name` | `metadata.tool_name` | 工具名 |
| `tool_use_id` | `metadata.tool_use_id` | 工具调用 id |
| `tool_input.file_path` | `metadata.tool_detail` | `Read` / `Edit` / `Write` 文件路径摘要 |
| `tool_input.command` | `metadata.tool_detail` | `Bash` 命令摘要 |
| `tool_input.skill` | `metadata.tool_detail` | `Skill` 名 |
| `tool_input.description` | `metadata.tool_detail` | `Agent` / `Task` 描述 |
| `prompt` | `metadata.prompt_source` | 只提取来源，例如 C4 channel、control、scheduler |
| `last_assistant_message` | `metadata.assistant_summary` | `Stop` / `SubagentStop` 时截断到 200 字符 |
| `agent_id` | `metadata.agent_id` | 子 Agent id |
| `agent_type` | `metadata.agent_type` | 子 Agent 类型 |

摘要写入 `runtime_events.summary`。例如：

| Hook event | summary 形态 |
|---|---|
| `PreToolUse` / `PostToolUse` | `<tool_name>: <tool_detail>` |
| `UserPromptSubmit` | `Prompt from <source>` 或 `Prompt received` |
| `Stop` | assistant 摘要或 `Turn ended` |
| `PermissionRequest` | `Permission requested: <tool_name>: <tool_detail>` |
| `SubagentStart` | `Subagent started` |
| `SubagentStop` | `Subagent completed` |

## Hook Event 到产品状态

`runtime_events` 中的 hook event 会进入 `StateEngine.onEvent()`。当前状态推导使用以下运行时信号：

| event_type | StateEngine 行为 | 产品表现 |
|---|---|---|
| `pre_tool_use` | 按 `tool_use_id` 加入 `runningTools`，更新 `lastProgressAt` | 当前工具、工具计时、BUSY |
| `post_tool_use` | 按 `tool_use_id` 删除 running tool，清理权限等待 | 工具结束、Timeline 事件 |
| `user_prompt_submit` | 打开 `openTurn`，记录 `lastPrompt`，更新主 session id | Thinking / BUSY，prompt 来源 feed item |
| `stop` | 清理主 session running tools、关闭 turn、记录最后 assistant message | 回到 IDLE，assistant message |
| `assistant_message` | 记录最后 assistant message | assistant message 面板 |
| `permission_request` | 设置 `pendingPermission` | 权限请求 Timeline；状态推导保留该信号 |
| `subagent_start` | 记录 `activeSubagents` | 子 Agent 列表 |
| `subagent_stop` | 删除对应子 Agent 和其工具 | 子 Agent 完成 |

`deriveAgentState()` 的主要输出：

| 产品状态 | 主要条件 |
|---|---|
| `UNKNOWN` | 没有 Activity Monitor heartbeat，无法确认 session liveness |
| `OFFLINE` | Activity Monitor heartbeat 显示 agent offline |
| `BUSY` | 有 running tool，或 turn 已打开但未结束 |
| `POSSIBLY_STUCK` | 工具或 turn 打开超过 300 秒且没有近期进展 |
| `STUCK` | `POSSIBLY_STUCK` 持续超过 600 秒，且 collector liveness 新鲜 |
| `IDLE` | 无 running tool、无 open turn，且 heartbeat 可用 |

## StatusLine 数据

Claude StatusLine 采集有两条入口：

| 入口 | 触发方式 | 写入 |
|---|---|---|
| `statusline-ingest.cjs` | Claude 调用 `settings.statusLine.command`，stdin 传入 JSON | POST `/api/ingest/statusline` 写 `metric_points` |
| `StatuslineCollector` | Dashboard 读取 `activity-monitor/statusline.json` | 直接写 `metric_points` |

本机 `statusline.json` 中观察到的主要字段：

| 字段 | 内容 |
|---|---|
| `session_id` | Claude session id |
| `transcript_path` | Claude JSONL 路径 |
| `cwd` | 当前工作目录 |
| `model.id` / `model.display_name` | 当前模型 |
| `version` | Claude Code 版本 |
| `cost.total_cost_usd` | 当前 session 累计成本 |
| `cost.total_duration_ms` | session 总耗时 |
| `cost.total_api_duration_ms` | API 总耗时 |
| `cost.total_lines_added` / `total_lines_removed` | 行数变更 |
| `context_window.total_input_tokens` | context 总 input tokens |
| `context_window.total_output_tokens` | context 总 output tokens |
| `context_window.context_window_size` | context window size |
| `context_window.current_usage.input_tokens` | 当前 API usage input tokens |
| `context_window.current_usage.output_tokens` | 当前 API usage output tokens |
| `context_window.current_usage.cache_creation_input_tokens` | prompt cache creation tokens |
| `context_window.current_usage.cache_read_input_tokens` | prompt cache read tokens |
| `context_window.used_percentage` | context 使用百分比 |
| `context_window.remaining_percentage` | context 剩余百分比 |

代码中还支持读取：

| 字段 | 用途 |
|---|---|
| `rate_limits.five_hour.used_percentage` | 5 小时 rate limit |
| `rate_limits.five_hour.resets_at` | 5 小时 reset 时间 |
| `rate_limits.seven_day.used_percentage` | 7 天 rate limit |
| `rate_limits.seven_day.resets_at` | 7 天 reset 时间 |
| `effort.level` | 当前 effort |

StatusLine 写入的指标：

| metric_name | metric_value | dimensions | source |
|---|---:|---|---|
| `context_pct` | `context_window.used_percentage` | 无 | `statusline` |
| `session_cost` | `cost.total_cost_usd` | 无 | `statusline` |
| `rate_limit` | `rate_limits.five_hour.used_percentage` | `period=5h`, reset 时间 | `statusline` |
| `rate_limit_7d` | `rate_limits.seven_day.used_percentage` | `period=7d`, reset 时间 | `statusline` |
| `cache_hit_rate` | `cache_read_input_tokens / (input_tokens + cache_creation_input_tokens + cache_read_input_tokens)` | 无 | `statusline_current_usage` |

`StatuslineCollector.getRuntimeInfo()` 还提供：

| 字段 | 来源 |
|---|---|
| `model` | `model.display_name` 或 `model.id` |
| `model_id` | `model.id` |
| `effort` | `effort.level` |
| `cc_version` | `version` |

## Claude Conversation JSONL 数据

`ConversationCollector` 通过 `StateEngine.getCurrentSessionId()` 找到当前 Claude session id，再拼出 JSONL 路径：

```text
~/.claude/projects/<zylos-dir-slug>/<session_id>.jsonl
```

采集方式：

| 步骤 | 行为 |
|---|---|
| offset 恢复 | 从 `source_health` 的 `conversation_reader` / `byte_offset` 读取上次 offset |
| 文件定位 | 根据当前 session id 选择 JSONL 文件 |
| 增量读取 | 从上次 byte offset 读取到最新完整换行 |
| 过滤记录 | 只处理 `type = "assistant"` 的 JSONL 记录 |
| 去重 | 使用 assistant record 的 `uuid`，并检查 `metric_points.dimensions.uuid` |
| offset 持久化 | 成功处理后写回 `source_health` |

### assistant message

当 assistant JSONL record 的 `message.content` 中存在 text block 时，写入：

| 字段 | 值 |
|---|---|
| `runtime_events.event_type` | `assistant_message` |
| `category` | `assistant` |
| `summary` | text blocks 合并后截断到 500 字符 |
| `metadata.uuid` | assistant record uuid |
| `metadata.has_tool_use` | 本条 assistant message 是否包含 `tool_use` block |
| `metadata.content_types` | content block 类型集合 |
| `source` | `conversation` |

该事件用于 Dashboard 的最后 assistant message 和 Timeline。

### usage / token / cost

当 assistant JSONL record 有 `message.usage` 时，写入以下指标：

| metric_name | metric_value | dimensions | source |
|---|---:|---|---|
| `api_request_tokens` | `input + cache_read + cache_creation` | `input`, `output`, `cache_read`, `cache_creation`, `model`, `speed`, `uuid`, `projects` | `jsonl_usage` |
| `cache_hit_rate` | `cache_read / (input + cache_read + cache_creation)` | `uuid` | `jsonl_usage` |
| `api_request_cost` | 依据 `modelPrices` 计算 | `model`, `speed`, `uuid` | `jsonl_usage` |

成本公式：

```text
cost =
  input_tokens * price.input +
  output_tokens * price.output +
  cache_read_input_tokens * price.cacheRead +
  cache_creation_input_tokens * price.cacheCreation
```

单位是每 1M tokens；如果 `usage.speed = "fast"`，再乘以 `fastModeMultiplier`，默认 6。

项目归因从 assistant content 中的 `tool_use` block 提取：

| 来源 | 提取方式 |
|---|---|
| `tool_use.input.file_path` / `path` | 路径中 `workspace/<project>` 或 `skills/<skill>` |
| `tool_use.input.command` | 命令文本中 `workspace/<project>` 或 `skills/<skill>` |

提取到的项目名写入 `api_request_tokens.dimensions.projects`。

## Metric Resolver 与聚合

当前 `MetricResolver` 对 Claude 主要指标的来源优先级：

| 产品指标 | metric_name | resolver source chain |
|---|---|---|
| Context | `context_pct` | `statusline` → `rollout` → `derived_token_estimate` |
| 5h Rate Limit | `rate_limit` | `statusline` → `rollout` |
| 7d Rate Limit | `rate_limit_7d` | `statusline` |
| Effort | `effort_level` | `statusline` |
| Session Cost | `session_cost` | `statusline` → `jsonl_usage` → `token_price_estimated` |
| Daily Cost | `daily_cost` | `jsonl_usage` → `statusline_delta` → `token_price_estimated` |
| Cache Hit Rate | `cache_hit_rate` | `statusline_current_usage` → `jsonl_usage` |
| Tool Duration | `tool_duration` | `hook_postToolUse` |

聚合接口使用 `metric_points` 中的 `api_request_*` 指标：

| API | 计算内容 | 数据来源 |
|---|---|---|
| `/api/metrics/aggregate?metric=cost&period=session/today/7d` | `SUM(api_request_cost.metric_value)` | Claude JSONL usage |
| `/api/metrics/aggregate?metric=tokens&period=session/today/7d` | input/cache/output 汇总 | Claude JSONL usage |
| `/api/metrics/aggregate?metric=cache&period=session/today/7d` | `SUM(cache_read) / SUM(total_input)` | Claude JSONL usage |
| `/api/metrics/series?metric=cost` | 按 bucket 聚合成本 | Claude JSONL usage |
| `/api/metrics/series?metric=tokens` | 按 bucket 聚合 input/output/cache | Claude JSONL usage |
| `/api/metrics/series?metric=projects` | 项目 output tokens / cost 分布 | Claude JSONL usage + hook fallback |

## 产品模块映射

### 实时运行状态

| 页面元素 | API | 数据来源 |
|---|---|---|
| 状态标题：空闲 / 执行中 / 可能卡住 / 已卡住 / 离线 / 未知 | `/api/state` | Activity Monitor heartbeat + hook event replay |
| 当前工具 feed | `/api/state.running_tools` | `PreToolUse` / `PostToolUse` hook |
| prompt 来源 feed | `/api/state.last_prompt` | `UserPromptSubmit.prompt` 中提取 C4/control/scheduler 来源 |
| 最后 assistant message | `/api/state.last_message` | `Stop.last_assistant_message` 或 conversation JSONL `assistant_message` |
| 子 Agent 列表 | `/api/state.active_subagents` | `SubagentStart` / `SubagentStop` hook |
| runtime/model/effort/version | `/api/state.runtime_info` | StatusLine + `claude --version` + settings |

### 核心指标卡

| 页面元素 | API / metric | 数据来源 |
|---|---|---|
| Context 百分比 | `/api/metrics/context_pct` | StatusLine |
| New session threshold marker | `/api/state.new_session_threshold` | `~/.zylos/config.json` 的 `new_session_threshold` |
| 5h Rate Limit | `/api/metrics/rate_limit` | StatusLine |
| 7d Rate Limit | `/api/metrics/rate_limit_7d` | StatusLine |
| Session / Today / 7d Cost | `/api/metrics/aggregate?metric=cost` | Claude JSONL usage 的 `api_request_cost` |
| Session / Today / 7d Tokens | `/api/metrics/aggregate?metric=tokens` | Claude JSONL usage 的 `api_request_tokens` |
| Cache ring | `/api/metrics/aggregate?metric=tokens` 中的 `cache_rate` | Claude JSONL usage |

### Timeline / Summary

| 页面元素 | API | 数据来源 |
|---|---|---|
| Timeline | `/api/timeline` | `runtime_events`；前端过滤 `pre_tool_use` 和 `stop` |
| 工具调用数 | `/api/summary.tool_calls` | 当日 `post_tool_use` 事件数 |
| 会话数 | `/api/summary.sessions` | 当日 `stop` 事件数 |
| Top Project | `/api/summary.top_project` | `post_tool_use.summary` 中 `Read/Edit/Write` 文件路径解析 |
| Messages processed | `/api/summary.messages_processed` | C4 当日入站 + 出站消息数 |

### Trends

| 图表 | API | 数据来源 |
|---|---|---|
| Token Usage | `/api/metrics/series?metric=tokens` | Claude JSONL usage |
| Cost | `/api/metrics/series?metric=cost` | Claude JSONL usage |
| Message Throughput | `/api/metrics/series?metric=messages` | C4 DB |
| Project Distribution | `/api/metrics/series?metric=projects` | Claude JSONL usage 的 project attribution；旧数据 fallback 到 hook 工具路径比例 |

### Health / System / Communication

| 页面元素 | API | 数据来源 |
|---|---|---|
| PM2 services | `/api/system.pm2` | `pm2 jlist` |
| CPU | `/api/system.system.cpu_pct` | Node `os.cpus()` delta |
| Memory | `/api/system.system.mem_*` | macOS `vm_stat` 或 `os.freemem()` |
| Disk | `/api/system.system.disk_*` | `fs.statfsSync(zylosDir)` |
| Communication channels | `/api/communication.channels` | C4 DB |
| Pending queue | `/api/communication.pending_*` | C4 DB |
| Avg response time | `/api/communication.avg_response_s` | C4 DB inbound/outbound pairing |

## Source Health

Dashboard 同时记录采集源健康状态，用于状态可信度与前端 source 展示：

| name | signal_type | 写入方 | 含义 |
|---|---|---|---|
| `hook_handler` | `collector_liveness` | `/api/ingest`, `SpoolDrainer` | hook 采集服务近期可写入 |
| `hook_events` | `runtime_progress` | `/api/ingest`, `SpoolDrainer` | runtime hook event 近期有进展 |
| `statusline` | `collector_liveness` | StatusLine ingest / collector | StatusLine 指标近期可写入 |
| `statusline` | `runtime_progress` | StatusLine ingest / collector | StatusLine runtime 数据近期有进展 |
| `jsonl_usage` | `collector_liveness` | `ConversationCollector` | Claude JSONL usage 近期可写入 |
| `conversation_reader` | `collector_liveness` | `ConversationCollector` | assistant message 近期可读取 |
| `conversation_reader` | `byte_offset` | `ConversationCollector` | 当前 JSONL 文件与 byte offset |
| `pm2_reader` | `collector_liveness` | `PM2Collector` | PM2 采样可用 |
| `system_sampler` | `collector_liveness` | `SystemCollector` | system 采样可用 |
| `am_heartbeat` | `collector_liveness` | `StateEngine` | Activity Monitor heartbeat 可用 |

## 当前实现边界

| 边界 | 当前 main 的事实 |
|---|---|
| Claude OTel | 当前 `main` 中没有运行中的 `otel-collector.js`；已删除该 collector 文件 |
| Hook 原文 | `tool_input`、`tool_response`、`prompt`、`content`、`message` 不入库 |
| StatusLine 双入口 | `statusline-ingest.cjs` 可直接 POST 指标；`StatuslineCollector` 也会读 `activity-monitor/statusline.json` 写同类指标 |
| JSONL 读取范围 | `ConversationCollector` 只处理当前 session 的 `type = "assistant"` JSONL records |
| 当前工具耗时 | 当前 UI 的 running tool duration 由 `PreToolUse` 时间到当前时间计算；`PostToolUse.duration_ms` 只有 hook payload 提供时才入库 |
| Daily / 7d 成本 | 聚合使用 JSONL usage 生成的 `api_request_cost`，不是 StatusLine 的 session total |
| 项目分布 | 新数据优先用 JSONL `tool_use` 内容提取项目；未归因输出 tokens 会按 hook 文件路径比例分配 |
| Codex degraded 文案 | 最新 `main` 仍有 Codex 降级文案；本文只描述 Claude Runtime 当前实现 |

## 一句话链路

Claude Runtime 下，Dashboard 的实时状态来自 hook event，容量/限额/当前会话成本来自 StatusLine，Token/成本趋势和项目分布来自 Claude conversation JSONL，系统与通信指标来自 PM2/system/C4；这些数据统一写入 `runtime_events`、`metric_points`、`source_health`，再由 `StateEngine`、`MetricResolver` 和聚合 API 映射成页面上的状态、指标卡、Timeline、Trends、Health 与 Communication 模块。
