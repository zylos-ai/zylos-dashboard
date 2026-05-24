# 从 Claude Runtime 借鉴到 Codex Runtime 的产品指标方案

更新时间：2026-05-25

本文基于前两份事实文档继续推进：

- Claude Runtime 当前实现：`dashboard-claude-runtime-data-map`
- Codex Runtime hook / JSONL 事实：`dashboard-hook-jsonl-boundary`

目标不是逐字段对齐 Claude 和 Codex，而是从 Claude Runtime 的实现里抽出 Dashboard 的产品需求，再说明 Codex Runtime 如何满足这些需求；不能等价满足的部分，给出 Codex Runtime 的折中方案或专属方案。

## 从 Claude Runtime 看到的产品需求

Claude Runtime 的现有实现说明 Dashboard 不是单纯展示“日志”，而是在回答 owner 关心的几类问题：

| 产品问题 | Claude Runtime 当前答案 | 对应页面 |
|---|---|---|
| Agent 现在活着吗？ | Activity Monitor heartbeat + PM2 + hook 进展 | 实时状态、Health |
| Agent 现在在干什么？ | `PreToolUse` / `PostToolUse` + open turn | 当前工具、工具 feed |
| Agent 是空闲、忙、卡住，还是离线？ | StateEngine 把 heartbeat、running tool、open turn、last progress 组合成状态 | 状态标题、颜色、suggested action |
| 它刚才回复了什么？ | `Stop.last_assistant_message` 或 conversation JSONL assistant text 摘要 | last assistant message、Timeline |
| 它用了多少上下文？ | StatusLine `context_window.used_percentage` | Context 卡片、new-session threshold |
| 它快到限额了吗？ | StatusLine rate limits | 5h / 7d rate limit 卡片 |
| 它消耗了多少 token？ | Claude JSONL `message.usage` | Token 卡片、趋势图 |
| 成本是多少？ | JSONL usage × price table，StatusLine session cost 作当前值来源 | Cost 卡片、趋势图 |
| 缓存是否有效？ | cache read tokens / total input tokens | Cache ring |
| 工作集中在哪些项目？ | JSONL tool_use path / command 提取 project | Project Distribution |
| 哪些通信渠道有消息？ | C4 DB readonly query | Communication、Message Throughput |
| 系统服务是否健康？ | PM2/system collectors | Health / System |

这些需求可以分成 5 组：

| 需求组 | 产品语义 | 数据类型 |
|---|---|---|
| Runtime liveness | 在线、离线、未知 | heartbeat / PM2 / source health |
| Runtime progress | 正在执行什么、有没有进展、是否卡住 | hook event / JSONL event |
| Capacity | context、rate limit、新会话阈值 | token_count / statusline / config |
| Usage & cost | token、cache、cost、趋势 | usage event / price table |
| Work trace | Timeline、assistant message、project attribution、tool history | hook event / JSONL response item |

## Claude Runtime 可借鉴的实现思想

### 1. 产品语义优先，不强行同源

Claude Runtime 已经不是“所有指标来自一个源”。例如：

| 产品指标 | Claude 来源 |
|---|---|
| 当前工具 | Hook |
| Context | StatusLine |
| Daily / 7d cost | JSONL usage |
| Last assistant message | Stop hook 或 conversation JSONL |
| PM2 / system | Runtime 无关 collector |
| Message throughput | C4 DB |

Codex Runtime 应该继承这一点：产品指标保持统一语义，底层来源按 runtime 选择。

### 2. Hook 负责实时状态，JSONL 负责事实账本

Claude Runtime 的拆分很清楚：

| 层 | Claude Runtime 用途 | 对 Codex 的借鉴 |
|---|---|---|
| Hook | 低延迟 runtime progress：工具开始/结束、prompt、stop、permission、subagent | Codex hooks 也用于当前工具、open turn、permission、stop |
| JSONL | 完整度更高的历史事实：assistant message、usage、cost、project attribution | Codex rollout JSONL 用于 token、cache、rate limit、context、task duration、TTFT、tool history |

Codex hook payload 里没有 usage；因此 Codex 也应该延续“hook 不承担 token/cost”的边界。

### 3. 不保存原始敏感内容，只保存摘要和结构化字段

Claude Runtime 的 `Sanitizer` 明确不保存：

- `tool_input`
- `tool_response`
- `prompt`
- `content`
- `message`

Codex Runtime 也应该复用这个隐私边界。Codex hooks 和 rollout JSONL 都能看到 prompt、tool input、tool output、assistant message；产品上需要的是摘要、状态、计数、路径归因、耗时和 token，不是原文。

### 4. Source health 是产品可信度的一部分

Claude Runtime 会记录：

- `hook_handler`
- `hook_events`
- `statusline`
- `jsonl_usage`
- `conversation_reader`
- `pm2_reader`
- `system_sampler`
- `am_heartbeat`

Codex Runtime 也需要类似的 source health。否则 UI 只能显示“没有数据”，无法说明是 agent 空闲、collector stale、还是数据源不支持。

### 5. StateEngine 应该复用，不为 Codex 另造状态系统

Claude Runtime 的状态机输入是 canonical events：

- `pre_tool_use`
- `post_tool_use`
- `user_prompt_submit`
- `stop`
- `permission_request`
- `assistant_message`
- `subagent_start`
- `subagent_stop`

Codex hook 和 JSONL 应该尽量映射到同一套 canonical event，让 `/api/state`、Timeline、SSE、状态颜色和 stuck 判定复用同一套产品逻辑。

### 6. Aggregation API 应该复用

Claude Runtime 的成本、token、cache、project distribution 都已经通过 `metric_points` 聚合：

- `api_request_tokens`
- `api_request_cost`
- `cache_hit_rate`

Codex Runtime 如果写入同样的 metric names，就能复用现有 Cost / Tokens / Cache / Trends UI。

## Codex Runtime 产品需求满足方案

### 总览

| 产品需求 | Codex 方案 | 满足程度 | 备注 |
|---|---|---|---|
| 在线 / 离线 / 未知 | Activity Monitor heartbeat + PM2，沿用现有 Runtime 无关链路 | 可满足 | 不依赖 Codex 专属数据 |
| 当前工具 | Codex `PreToolUse` / `PostToolUse` hook | 可满足 | 需要安装 Codex hooks |
| open turn / thinking | Codex `UserPromptSubmit` 打开 turn，`Stop` 关闭 turn | 可满足但需去重 | `UserPromptSubmit` 同一 `turn_id` 可重复 |
| permission request | Codex `PermissionRequest` hook | 可满足但置信度中等 | 样本少，且没有 `tool_use_id` |
| stuck / possibly stuck | StateEngine + hook progress + collector freshness | 可满足 | 与 Claude 同逻辑 |
| last assistant message | Codex `Stop.last_assistant_message` 或 rollout `agent_message` 摘要 | 可满足 | 只保存截断摘要或 hash，不保存全文 |
| sub-agent 状态 | Rollout JSONL 的 `spawn_agent` / `wait_agent` / `close_agent` / `send_input` | 可部分满足 | Codex hook 无 `SubagentStart` / `SubagentStop` |
| context pct | Rollout `token_count.last_token_usage.input_tokens / model_context_window` | 可满足 | 与 zylos-core CodexContextMonitor 口径一致 |
| 5h / weekly rate limit | Rollout `token_count.rate_limits.primary/secondary` | 可满足 | 映射到 `rate_limit` / `rate_limit_7d` |
| token usage | Rollout `token_count.total_token_usage` 或去重后的增量 | 可满足 | 需要避免重复计数 |
| cache hit | `cached_input_tokens / input_tokens` | 可满足 | OpenAI/Codex 口径中 input includes cached input |
| cost | token × Dashboard Codex price table | 可满足，标明 priced/estimated | 无官方 cost 字段 |
| turn duration / TTFT | Rollout `task_complete.duration_ms/time_to_first_token_ms` | 可满足 | Claude 当前页面未充分展示，可作为 Codex 增强 |
| per-tool model tokens | 无法满足 | 不支持 | token_count 无 call_id，tool item 无 model usage |
| tool input/output 原文展示 | 不满足，也不应满足 | 隐私边界 | 保存摘要、工具名、路径、耗时 |
| PM2/system/C4 | 现有 collectors | 可满足 | Runtime 无关 |

## Codex 数据源设计

### 数据源 1：Codex hooks

用途：低延迟 runtime progress。

Codex 0.130 可用 hook event：

| Hook | 产品用途 | 采集字段 |
|---|---|---|
| `SessionStart` | session 开始，建立 `session_id -> transcript_path` 映射 | `session_id`, `transcript_path`, `cwd`, `model`, `permission_mode`, `source` |
| `UserPromptSubmit` | open turn、prompt 来源 | `session_id`, `turn_id`, `prompt`, `model`, `cwd` |
| `PreToolUse` | 当前工具开始 | `session_id`, `turn_id`, `tool_name`, `tool_use_id`, `tool_input` |
| `PostToolUse` | 当前工具结束、工具事件 | `session_id`, `turn_id`, `tool_name`, `tool_use_id`, `tool_response` |
| `PermissionRequest` | 权限等待 | `session_id`, `turn_id`, `tool_name`, `tool_input` |
| `Stop` | turn 结束、assistant 摘要 | `session_id`, `turn_id`, `last_assistant_message` |

Hook 入库沿用 Claude 的链路：

```text
~/.codex/hooks.json
  -> hook-ingest.cjs
  -> /api/ingest
  -> Sanitizer
  -> runtime_events
  -> StateEngine
```

Codex hook 的特殊处理：

| 问题 | 处理 |
|---|---|
| `UserPromptSubmit` 同一 `session_id + turn_id` 可重复 | 以 `session_id + turn_id` 作为 open turn 去重 key；重复 prompt 只更新时间/来源，不重复打开多个 turn |
| `PermissionRequest` 样本无 `tool_use_id` | 用 `session_id + turn_id + tool_name` 做弱关联，confidence 标 `medium` |
| `tool_input.command` 可能包含完整命令或 patch | 不保存原文；Bash 只保存摘要，`apply_patch` 只提取文件路径和操作类型 |
| `tool_response` 可能很大 | 不保存原文；只保存状态、长度、摘要分类 |
| `Stop.last_assistant_message` 是全文 | 只保存截断摘要或 hash |

### 数据源 2：Codex rollout JSONL

用途：usage、capacity、历史事实。

定位方式：

| 场景 | 方案 |
|---|---|
| 有 Codex hook | 使用 hook payload 的 `transcript_path` 建立 active rollout path |
| Dashboard 重启后已有映射 | 从 DB/source health 恢复 `session_id -> transcript_path` |
| 冷启动且没有任何 hook 映射 | 返回 unavailable，不扫描和猜测 active session |

JSONL collector 写入现有 `metric_points` 和 `runtime_events`：

| JSONL 事件 | Codex 字段 | Dashboard 写入 |
|---|---|---|
| `event_msg token_count` | `last_token_usage`, `total_token_usage`, `model_context_window`, `rate_limits` | `context_pct`, `api_request_tokens`, `cache_hit_rate`, `api_request_cost`, `rate_limit`, `rate_limit_7d` |
| `event_msg task_complete` | `duration_ms`, `time_to_first_token_ms` | `turn_duration`, `ttft` |
| `event_msg agent_message` | assistant text | `assistant_message` 摘要 |
| `response_item function_call` | `name`, `arguments`, `call_id` | tool call event，不保存 arguments 原文 |
| `response_item function_call_output` | `call_id`, `output` | tool output event，不保存 output 原文 |
| `response_item custom_tool_call` | `name`, `input`, `call_id`, `status` | custom tool call，例如 `apply_patch` |
| `response_item custom_tool_call_output` | `call_id`, `output` | custom tool output |

### 数据源 3：Activity Monitor / PM2 / System / C4

这些不应因为 runtime 是 Codex 而降级：

| 数据源 | Codex 是否复用 | 用途 |
|---|---:|---|
| `activity-monitor/agent-status.json` | 是 | liveness、offline/unknown 判定 |
| PM2 collector | 是 | 服务健康 |
| System collector | 是 | CPU、内存、磁盘 |
| C4 DB reader | 是 | 消息吞吐、待处理队列、平均响应时间 |
| Scheduler DB / status | 是 | scheduler 状态 |

## 产品指标逐项方案

### 1. 实时状态

| 产品字段 | Codex 来源 | 展示方式 |
|---|---|---|
| `state` | StateEngine：AM heartbeat + hook progress | 与 Claude 同一套状态枚举 |
| `running_tools` | `PreToolUse` 打开，`PostToolUse` 关闭 | 工具 feed |
| `last_prompt` | `UserPromptSubmit.prompt` 提取 C4/control/scheduler 来源 | prompt source feed item |
| `last_message` | `Stop.last_assistant_message` 或 rollout `agent_message` 摘要 | assistant message 区域 |
| `confidence` | source health + 是否缺关键事件 | 显示 HIGH/MEDIUM/LOW |

Codex 专属点：

- open turn 应按 `turn_id` 去重。
- 如果没有 hook 但 JSONL 有 `task_started` / `task_complete`，可以作为低频 fallback；实时性低于 hook。
- 如果 AM heartbeat 缺失，即使 hook 有旧 running tool，也应显示 `UNKNOWN`，与 Claude 状态机一致。

### 2. 当前工具与工具活动

| 产品字段 | Codex 来源 | 折中 |
|---|---|---|
| tool name | hook `tool_name` 或 JSONL item `name` | 可完整展示 |
| tool id | hook `tool_use_id` / JSONL `call_id` | 两者需要映射或并列保存 |
| tool detail | Bash 命令摘要、`apply_patch` 文件路径、MCP/tool 名 | 不保存完整输入 |
| start time | `PreToolUse.received_at` | 可满足 |
| end time | `PostToolUse.received_at` 或 JSONL output item timestamp | 可满足 |
| duration | Pre/Post 时间差 | 没有 Post 时显示 running duration |
| success/failure | hook response / JSONL output 状态 | Codex MVP 可先标 unknown/success best-effort |

无法满足：

| 需求 | 原因 | 方案 |
|---|---|---|
| 每个工具调用对应的模型 input/output token | `token_count` 无 `call_id`，tool items 无 usage 字段 | 不展示 per-tool model token；只展示 turn/session token |
| 完整命令/输出可回放 | 隐私与数据量边界 | 展示摘要、文件路径、输出长度、成功/失败 |

### 3. Context 与 new-session threshold

Codex context 使用率口径：

```text
context_pct = last_token_usage.input_tokens / model_context_window * 100
```

产品映射：

| 产品字段 | Codex 来源 |
|---|---|
| Context percentage | rollout `token_count.info.last_token_usage.input_tokens / model_context_window` |
| Context used tokens | `last_token_usage.input_tokens` |
| Context ceiling | `model_context_window` |
| Threshold marker | zylos config `codex_new_session_threshold`，默认 75 |

借鉴 Claude 的点：

- Context 是容量指标，不是 session 累计 token。
- UI 上展示百分比和 threshold marker。
- Dashboard 不应该另起 new-session 控制逻辑；控制流继续由 zylos-core/activity-monitor 负责。

Codex 专属点：

- 不能用 `total_token_usage.input_tokens` 当 context fill，因为它是累计字段。
- 如果 `model_context_window` 缺失，source 应降级为 missing 或 fallback，不应静默估算成 200k。

### 4. Rate limit

Codex rollout `token_count.rate_limits` 可映射为：

| 产品指标 | Codex 来源 | dimensions |
|---|---|---|
| `rate_limit` | `rate_limits.primary.used_percent` 或同等百分比字段 | `period=5h`, `resets_at`, `window_minutes=300` |
| `rate_limit_7d` | `rate_limits.secondary.used_percent` 或同等百分比字段 | `period=7d`, `resets_at`, `window_minutes=10080` |

折中：

- 如果字段名称随 Codex 版本变化，collector 应做 defensive parsing。
- 如果只有 rate limit reset，没有 used percentage，UI 显示 reset 时间和 source degraded。

### 5. Token、cache、cost

Codex token 口径：

| 产品字段 | Codex 来源 |
|---|---|
| input tokens | `token_count.info.last_token_usage.input_tokens` 或去重后的增量 |
| cached input tokens | `cached_input_tokens` |
| output tokens | `output_tokens` |
| reasoning output tokens | `reasoning_output_tokens` |
| total tokens | `total_tokens` |

写入现有聚合模型：

| Dashboard metric | Codex 写入 |
|---|---|
| `api_request_tokens` | input 作为 `metric_value`；dimensions 写 input/output/cache/reasoning/model/turn_id |
| `cache_hit_rate` | `cached_input_tokens / input_tokens` |
| `api_request_cost` | token × Codex/OpenAI model price table |

关键差异：

| 差异 | Claude | Codex |
|---|---|---|
| usage 来源 | Claude conversation JSONL assistant `message.usage` | Codex rollout `event_msg token_count` |
| cost 来源 | JSONL usage × price table；StatusLine session cost 可做当前值 | 只能 token × price table |
| cache 分母 | Claude 现有实现用 `input + cache_creation + cache_read` | Codex/OpenAI 语义中 `input_tokens` 已包含 cached input；分母用 `input_tokens` |
| reasoning tokens | Claude 当前页面未单独展示 | Codex 可记录到 dimensions，后续可展示 |

折中：

- 缺 price 时仍展示 token/cache，不展示 cost 或标 `missing_price`。
- Cost source/confidence 标为 `jsonl_usage` + `priced` 或 `estimated`，不伪装成官方账单。
- 采用 `turn_id` / JSONL event id 去重，避免 `total_token_usage` 重复累计。

### 6. Timeline 与 assistant message

Codex 可以同时使用 hook 和 rollout：

| Timeline event | Codex 来源 |
|---|---|
| prompt received | `UserPromptSubmit` hook |
| tool start/end | hook 或 rollout response item |
| permission request | `PermissionRequest` hook |
| assistant message | `Stop.last_assistant_message` 或 rollout `agent_message` |
| turn complete | rollout `task_complete` |
| patch applied | rollout `patch_apply_end` 或 hook `apply_patch` summary |
| sub-agent operation | rollout `spawn_agent` / `wait_agent` / `close_agent` / `send_input` |

折中：

- Codex 没有 `SubagentStart` / `SubagentStop` hook event；sub-agent 只能从 rollout function calls 重建。
- assistant message 只保存摘要，全文不入库。
- Timeline 可以显示 “sub-agent spawned / completed / waited”，但 active sub-agent 状态的置信度低于 Claude hook 直连。

### 7. Project distribution

Claude 的项目分布来自 JSONL tool_use path / command。Codex 可采用类似方法：

| Codex 来源 | 可提取内容 |
|---|---|
| hook `apply_patch.tool_input.command` | `*** Update/Add/Delete File: <path>` |
| hook `Bash.tool_input.command` | 命令中的 workspace/skills 路径 |
| rollout `function_call.arguments` | 工具参数中的路径 |
| rollout `custom_tool_call.input` | custom tool input 中的 patch/path |

折中：

- 不保存完整 command / arguments，只保存提取出的 project、path basename 或归一化路径。
- 对没有路径的 turn，项目归因为 unknown。
- 项目分布可以先按 output tokens 分配到当 turn 提取出的项目集合；没有 project 时不强行猜测。

## Codex 不能等价满足的需求

| Claude 能力 / 页面期望 | Codex 限制 | Codex 方案 |
|---|---|---|
| StatusLine 直接给 session cost、context pct、rate limits | Codex 没有同等 StatusLine JSON | 使用 rollout `token_count` + price table；runtime info 从 hook/model/config 获取 |
| `SubagentStart` / `SubagentStop` hook | Codex 0.130 未观察到专用 hook | 从 rollout 的 sub-agent tool calls 重建，标低/中置信度 |
| 每个工具调用的模型 token | token_count 无 call_id，tool item 无 usage | 不展示 per-tool token；展示 turn/session token |
| 工具输入输出全文 | 可以看到，但隐私边界不允许保存 | 摘要、路径、长度、状态、hash |
| Claude Code version | Codex runtime info 需要另取 | 使用 `codex --version` 或 runtime config；没有则显示 runtime only |
| Effort level | Codex 与 Claude 设置模型不同 | 若当前 Codex config 有 reasoning effort 才显示；否则隐藏或 N/A |
| Rate limit 字段稳定性 | Codex rollout 字段来自 observed JSONL，需 defensive mapping | source health + degraded / missing 表达 |
| 冷启动定位 active JSONL | 不读 Codex SQLite、不扫描猜测 | 等待首个 `SessionStart` hook；无映射时显示 unavailable |

## Codex 专属增强

Codex 不必只追求复制 Claude。它有一些 Claude 当前实现没有充分利用的数据：

| Codex 数据 | 产品价值 |
|---|---|
| `turn_id` | 比 Claude 更明确的 turn 关联键，可改善工具/usage/assistant message 关联 |
| `task_complete.duration_ms` | turn 总耗时，可做 P50/P95 turn duration |
| `task_complete.time_to_first_token_ms` | TTFT，可展示模型响应速度 |
| `reasoning_output_tokens` | 可拆出 reasoning token 占比 |
| `patch_apply_end` | patch apply 成功/失败和改动事件 |
| rollout sub-agent function calls | 可做 Codex 专属 sub-agent timeline |

建议的 Codex 专属指标：

| 指标 | 来源 | 展示位置 |
|---|---|---|
| Turn duration | `task_complete.duration_ms` | Trends / Timeline detail |
| TTFT | `task_complete.time_to_first_token_ms` | Runtime performance card |
| Reasoning tokens | `token_count.last_token_usage.reasoning_output_tokens` | Token detail |
| Patch apply events | `patch_apply_end` | Timeline |
| Tool output envelope token count | tool output text中的 `Original token count` | 仅作为 tool output size，不作为 model usage |

## 推荐的实现顺序

### Phase 1：让 Codex 从 degraded 变成可观察

| 工作 | 结果 |
|---|---|
| 安装 Codex hooks | `~/.codex/hooks.json` 写入 Dashboard hook |
| 复用 `/api/ingest` | Codex hook 进入 `runtime_events` |
| StateEngine 支持 Codex 去重 | 当前工具、open turn、stop、permission 可用 |
| source health 区分 Codex hook | UI 能知道数据新鲜度 |

第一阶段完成后，产品上至少应恢复：

- 实时状态
- 当前工具
- Timeline 基础事件
- permission request
- stuck / possibly stuck

### Phase 2：补齐 Codex rollout collector

| 工作 | 结果 |
|---|---|
| 用 hook `transcript_path` 定位 rollout JSONL | 不扫描、不猜 active session |
| tail `token_count` | Context、rate limit、token、cache、cost |
| tail `task_complete` | turn duration、TTFT |
| tail `agent_message` / response items | assistant message、tool history、sub-agent timeline |
| 写入现有 `metric_points` | 复用现有 Cost / Tokens / Cache / Trends UI |

第二阶段完成后，产品上恢复：

- Context
- Rate limit
- Tokens
- Cache
- Cost
- Trends
- Project distribution

### Phase 3：Codex 专属体验

| 工作 | 结果 |
|---|---|
| TTFT / turn duration 卡片 | 体现 Codex rollout 的特长 |
| reasoning token detail | 展示 Codex/OpenAI 模型成本结构 |
| sub-agent timeline | 补偿没有 sub-agent hook 的限制 |
| patch apply timeline | 更好解释代码修改类工作 |

## 最终产品目标

Codex Runtime 不应显示一个笼统的 degraded mode。它应该按能力分层显示：

| 能力 | Codex 目标显示 |
|---|---|
| Runtime state | 正常 |
| Current tool | 正常 |
| Timeline | 正常，部分事件 source 为 hook/rollout |
| Context | 正常，source 为 rollout |
| Rate limit | 正常，source 为 rollout |
| Tokens / cache | 正常，source 为 rollout |
| Cost | 正常但标明 price-table 口径 |
| Sub-agent | 部分支持，source 为 rollout，confidence 中等 |
| Per-tool model tokens | 不支持，隐藏或明确 N/A |
| PM2/System/C4 | 正常 |

一句话总结：Claude Runtime 教给我们的不是“必须复刻 Claude 的 StatusLine”，而是产品上要把 runtime liveness、runtime progress、capacity、usage/cost 和 work trace 分清楚；Codex Runtime 应该用 hooks 负责实时进展，用 rollout JSONL 负责 usage/capacity/历史事实，用现有 PM2/system/C4 保持平台观测能力，再用 source/confidence 把不能等价满足的地方说清楚。
