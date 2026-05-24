# Codex Runtime Hook 与 JSONL 事实清单

更新时间：2026-05-25

本文只记录 Codex Runtime 的客观事实信息。范围限定为：Codex 0.130 hook schema、本机 hook spike 样本统计，以及本机 Codex rollout JSONL 中已经观察到的记录形态。

## 信息来源

| 来源 | 内容 |
|---|---|
| Codex 源码 | `openai/codex` tag `rust-v0.130.0` 的 hook input struct |
| 本机 hook 样本 | `components/dashboard/spike/codex-hooks.jsonl`，共 4,139 条 hook payload |
| 本机 rollout JSONL | `~/.codex/sessions/.../*.jsonl` 中的 Codex session 记录 |

下文中“观察到”均指上述本机样本或源码检查结果。

## Codex Hook 事件集合

Codex 0.130 hook schema 中存在 6 类 hook event：

| hook_event_name | 源码中存在 | 本机 spike 中出现 |
|---|---:|---:|
| `SessionStart` | 是 | 是 |
| `UserPromptSubmit` | 是 | 是 |
| `PreToolUse` | 是 | 是 |
| `PostToolUse` | 是 | 是 |
| `PermissionRequest` | 是 | 是 |
| `Stop` | 是 | 是 |

Codex 0.130 hook schema 中未观察到 `SubagentStart` / `SubagentStop` hook event。

## Codex Hook 通用字段

Codex 0.130 的 6 类 hook 都带以下基础字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `session_id` | string | Codex session / conversation id |
| `transcript_path` | string 或 null | rollout JSONL 文件路径 |
| `cwd` | string | 当前工作目录 |
| `hook_event_name` | string | hook 事件名 |
| `model` | string | 当前模型 |
| `permission_mode` | string | 权限模式 |

除 `SessionStart` 外，turn 级 hook 还带：

| 字段 | 类型 | 说明 |
|---|---|---|
| `turn_id` | string | 当前 turn id |

## Codex Hook 样本统计

本机 spike 文件共 4,139 条 hook payload。按 `hook_event_name` 统计：

| hook_event_name | 数量 | 样本字段集合 |
|---|---:|---|
| `SessionStart` | 31 | `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `source`, `transcript_path` |
| `UserPromptSubmit` | 278 | `cwd`, `hook_event_name`, `model`, `permission_mode`, `prompt`, `session_id`, `transcript_path`, `turn_id` |
| `PreToolUse` | 1,817 | `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `tool_input`, `tool_name`, `tool_use_id`, `transcript_path`, `turn_id` |
| `PostToolUse` | 1,808 | `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `tool_input`, `tool_name`, `tool_response`, `tool_use_id`, `transcript_path`, `turn_id` |
| `PermissionRequest` | 1 | `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `tool_input`, `tool_name`, `transcript_path`, `turn_id` |
| `Stop` | 204 | `cwd`, `hook_event_name`, `last_assistant_message`, `model`, `permission_mode`, `session_id`, `stop_hook_active`, `transcript_path`, `turn_id` |

## Codex `SessionStart`

字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `session_id` | string | session id |
| `transcript_path` | string 或 null | rollout JSONL 路径 |
| `cwd` | string | 工作目录 |
| `hook_event_name` | string | 固定为 `SessionStart` |
| `model` | string | 模型 |
| `permission_mode` | string | 权限模式 |
| `source` | string | 启动来源；源码枚举为 `startup`, `resume`, `clear` |

本机 spike 中 `source` 实测值：

| source | 数量 |
|---|---:|
| `startup` | 31 |

## Codex `UserPromptSubmit`

字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `session_id` | string | session id |
| `turn_id` | string | turn id |
| `transcript_path` | string 或 null | rollout JSONL 路径 |
| `cwd` | string | 工作目录 |
| `hook_event_name` | string | 固定为 `UserPromptSubmit` |
| `model` | string | 模型 |
| `permission_mode` | string | 权限模式 |
| `prompt` | string | 用户提交的完整 prompt 正文 |

本机 spike 中 `UserPromptSubmit` 与 `turn_id` 的统计：

| 指标 | 数量 |
|---|---:|
| `UserPromptSubmit` 总数 | 278 |
| 不同 `session_id + turn_id` 数量 | 206 |
| 出现多条 `UserPromptSubmit` 的 `session_id + turn_id` 数量 | 49 |
| 同一个 `session_id + turn_id` 内最多 `UserPromptSubmit` 数量 | 6 |

本机 spike 中观察到：同一个 `session_id + turn_id` 存在多条 `UserPromptSubmit` 的样本。

## Codex `PreToolUse`

字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `session_id` | string | session id |
| `turn_id` | string | turn id |
| `transcript_path` | string 或 null | rollout JSONL 路径 |
| `cwd` | string | 工作目录 |
| `hook_event_name` | string | 固定为 `PreToolUse` |
| `model` | string | 模型 |
| `permission_mode` | string | 权限模式 |
| `tool_name` | string | 工具名 |
| `tool_input` | object | 工具输入，具体字段由工具决定 |
| `tool_use_id` | string | 工具调用 id |

本机 spike 中在 `PreToolUse` 里出现的工具：

| tool_name | `tool_input` 字段 |
|---|---|
| `Bash` | `command` |
| `apply_patch` | `command` |

本机 spike 中 `PreToolUse` 的 `tool_input.command` 数量：

| tool_name | 数量 |
|---|---:|
| `Bash` | 1,723 |
| `apply_patch` | 94 |

## Codex `PostToolUse`

字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `session_id` | string | session id |
| `turn_id` | string | turn id |
| `transcript_path` | string 或 null | rollout JSONL 路径 |
| `cwd` | string | 工作目录 |
| `hook_event_name` | string | 固定为 `PostToolUse` |
| `model` | string | 模型 |
| `permission_mode` | string | 权限模式 |
| `tool_name` | string | 工具名 |
| `tool_input` | object | 工具输入 |
| `tool_response` | value | 工具输出，具体结构由工具决定 |
| `tool_use_id` | string | 工具调用 id |

本机 spike 中在 `PostToolUse` 里出现的工具：

| tool_name | `tool_input` 字段 | `tool_response` 类型 |
|---|---|---|
| `Bash` | `command` | string |
| `apply_patch` | `command` | string |

本机 spike 中 `PostToolUse` 的 `tool_input.command` 数量：

| tool_name | 数量 |
|---|---:|
| `Bash` | 1,718 |
| `apply_patch` | 90 |

## Codex `PermissionRequest`

字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `session_id` | string | session id |
| `turn_id` | string | turn id |
| `transcript_path` | string 或 null | rollout JSONL 路径 |
| `cwd` | string | 工作目录 |
| `hook_event_name` | string | 固定为 `PermissionRequest` |
| `model` | string | 模型 |
| `permission_mode` | string | 权限模式 |
| `tool_name` | string | 请求权限的工具 |
| `tool_input` | object | 请求权限的工具输入 |

本机 spike 中 `PermissionRequest` 数量为 1。该事件样本没有 `tool_use_id` 字段。

## Codex `Stop`

字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `session_id` | string | session id |
| `turn_id` | string | turn id |
| `transcript_path` | string 或 null | rollout JSONL 路径 |
| `cwd` | string | 工作目录 |
| `hook_event_name` | string | 固定为 `Stop` |
| `model` | string | 模型 |
| `permission_mode` | string | 权限模式 |
| `stop_hook_active` | boolean | stop hook active 标记 |
| `last_assistant_message` | string 或 null | 本轮最后一条 assistant 输出全文 |

## Hook Payload 中的完整文本字段

以下字段在 Codex hook payload 中以完整内容形式出现：

| 字段 | 出现位置 | 内容 |
|---|---|---|
| `prompt` | `UserPromptSubmit` | 用户提交的完整 prompt 正文 |
| `tool_input` | `PreToolUse`, `PostToolUse`, `PermissionRequest` | 工具输入对象 |
| `tool_response` | `PostToolUse` | 工具输出 |
| `last_assistant_message` | `Stop` | 最后一条 assistant 输出全文 |

## Hook Payload 中的命令与文件路径

本机 spike 中，`Bash` 与 `apply_patch` 工具输入均出现 `command` 字段；`PermissionRequest` 的一条 `Bash` 样本中也出现 `tool_input.command`：

| hook_event_name | tool_name | 样本数 | `tool_input.command` |
|---|---|---:|---|
| `PreToolUse` | `Bash` | 1,723 | 存在 |
| `PostToolUse` | `Bash` | 1,718 | 存在 |
| `PreToolUse` | `apply_patch` | 94 | 存在 |
| `PostToolUse` | `apply_patch` | 90 | 存在 |
| `PermissionRequest` | `Bash` | 1 | 存在 |

`apply_patch` 的 `tool_input.command` 样本中包含 patch 文本。patch 文本中出现以下文件路径标记行：

| 标记 | 含义 |
|---|---|
| `*** Update File: <path>` | 更新文件 |
| `*** Add File: <path>` | 新增文件 |
| `*** Delete File: <path>` | 删除文件 |

从本机 `PreToolUse` 的 94 条 `apply_patch` 样本中，按上述标记提取到 126 条文件路径标记。原始路径去重后为 14 个；把 `/Users/howard/zylos/` 前缀归一化为空后为 9 个。

按原始路径统计，出现次数最多的路径包括：

| 文件路径 | 出现次数 |
|---|---:|
| `/Users/howard/zylos/memory/state.md` | 35 |
| `/Users/howard/zylos/memory/sessions/current.md` | 23 |
| `memory/state.md` | 18 |
| `memory/sessions/current.md` | 18 |
| `/Users/howard/zylos/memory/reference/projects.md` | 8 |
| `memory/reference/projects.md` | 6 |
| `/Users/howard/zylos/memory/reference/decisions.md` | 5 |
| `memory/references.md` | 3 |
| `logs/run-memory-sync.sh` | 3 |

按 `/Users/howard/zylos/` 前缀归一化后，出现次数最多的路径包括：

| 文件路径 | 出现次数 |
|---|---:|
| `memory/state.md` | 53 |
| `memory/sessions/current.md` | 41 |
| `memory/reference/projects.md` | 14 |
| `memory/reference/decisions.md` | 7 |
| `memory/references.md` | 5 |
| `logs/run-memory-sync.sh` | 3 |

## Codex Rollout JSONL 事件集合

本机 rollout JSONL 中已观察到以下 top-level 类型和子类型：

| JSONL 类型 | 子类型 / role | 内容 |
|---|---|---|
| `session_meta` | - | session 元数据 |
| `turn_context` | - | turn 上下文信息 |
| `event_msg` | `task_started` | turn/task 开始事件 |
| `event_msg` | `user_message` | 用户消息事件 |
| `event_msg` | `agent_message` | assistant 输出事件 |
| `event_msg` | `token_count` | token、cache、rate limit、context window 等用量快照 |
| `event_msg` | `patch_apply_end` | patch apply 完成事件 |
| `event_msg` | `task_complete` | turn/task 完成事件，包含 duration / TTFT 等信息 |
| `response_item` | `message assistant` | assistant message |
| `response_item` | `message user` | user message |
| `response_item` | `message developer` | developer message |
| `response_item` | `reasoning` | reasoning item |
| `response_item` | `function_call` | 工具调用 |
| `response_item` | `function_call_output` | 工具调用输出 |
| `response_item` | `custom_tool_call` | custom tool 调用，例如 `apply_patch` |
| `response_item` | `custom_tool_call_output` | custom tool 输出 |

## Token 字段与 Tool Call 关联

本机 rollout JSONL 中观察到的 `token_count` 事件字段：

| 字段路径 | 内容 |
|---|---|
| `payload.info.total_token_usage.input_tokens` | `total_token_usage` 下的 input tokens |
| `payload.info.total_token_usage.cached_input_tokens` | `total_token_usage` 下的 cached input tokens |
| `payload.info.total_token_usage.output_tokens` | `total_token_usage` 下的 output tokens |
| `payload.info.total_token_usage.reasoning_output_tokens` | `total_token_usage` 下的 reasoning output tokens |
| `payload.info.total_token_usage.total_tokens` | `total_token_usage` 下的 total tokens |
| `payload.info.last_token_usage.input_tokens` | 最近一次模型响应 input tokens |
| `payload.info.last_token_usage.cached_input_tokens` | 最近一次模型响应 cached input tokens |
| `payload.info.last_token_usage.output_tokens` | 最近一次模型响应 output tokens |
| `payload.info.last_token_usage.reasoning_output_tokens` | 最近一次模型响应 reasoning output tokens |
| `payload.info.last_token_usage.total_tokens` | 最近一次模型响应 total tokens |
| `payload.info.model_context_window` | model context window |
| `payload.rate_limits` | rate limit 信息 |

本机 rollout JSONL 中观察到的 tool call 事件字段：

| JSONL item type | 字段 |
|---|---|
| `function_call` | `type`, `name`, `arguments`, `call_id` |
| `function_call_output` | `type`, `call_id`, `output` |
| `custom_tool_call` | `type`, `name`, `input`, `call_id`, `status` |
| `custom_tool_call_output` | `type`, `call_id`, `output` |

字段关系：

| 信息 | `token_count` 事件 | tool call / output 事件 |
|---|---:|---:|
| `call_id` | 未观察到 | 观察到 |
| `tool_use_id` | 未观察到 | hook 中观察到；rollout tool item 中使用 `call_id` |
| `input_tokens` | 观察到 | 未观察到 |
| `cached_input_tokens` | 观察到 | 未观察到 |
| `output_tokens` | 观察到 | 未观察到 |
| `reasoning_output_tokens` | 观察到 | 未观察到 |
| `total_tokens` | 观察到 | 未观察到 |

本机 rollout JSONL 中，`function_call_output.output` 的文本里可出现 `Original token count: <n>`。该文本位于工具输出内容内部，例如 shell 工具输出 envelope 中；它不是 `token_count` 事件中的模型 input/output token 字段，也没有 `call_id` 级的 `input_tokens` / `output_tokens` 结构。

## Tool Hook Payload 中的 Usage 字段

本机 hook spike 中，工具调用相关 hook payload 的顶层字段集合如下：

| hook_event_name | tool_name | 字段集合 |
|---|---|---|
| `PreToolUse` | `Bash` | `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `tool_input`, `tool_name`, `tool_use_id`, `transcript_path`, `turn_id` |
| `PostToolUse` | `Bash` | `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `tool_input`, `tool_name`, `tool_response`, `tool_use_id`, `transcript_path`, `turn_id` |
| `PreToolUse` | `apply_patch` | `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `tool_input`, `tool_name`, `tool_use_id`, `transcript_path`, `turn_id` |
| `PostToolUse` | `apply_patch` | `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `tool_input`, `tool_name`, `tool_response`, `tool_use_id`, `transcript_path`, `turn_id` |
| `PermissionRequest` | `Bash` | `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `tool_input`, `tool_name`, `transcript_path`, `turn_id` |

上述字段集合中未观察到名为 `usage`、`input_tokens`、`output_tokens`、`cached_input_tokens`、`reasoning_output_tokens` 或 `total_tokens` 的结构化字段。

## Codex Rollout JSONL 中的 Sub-agent 记录

本机 rollout JSONL 中可观察到 sub-agent 相关工具调用：

| 记录 | JSONL 位置 | 内容 |
|---|---|---|
| sub-agent 创建调用 | `response_item function_call`, `name = "spawn_agent"` | arguments 中包含 `message`、可选 `agent_type`、`fork_context` 等 |
| sub-agent 创建输出 | `response_item function_call_output` | output 中包含 `agent_id`、`nickname` |
| sub-agent 等待 / 状态读取 | `response_item function_call`, `name = "wait_agent"` | arguments 中包含目标 agent id 等 |
| sub-agent 等待输出 | `response_item function_call_output` | output 中包含 agent 状态或最终信息 |
| sub-agent 关闭调用 | `response_item function_call`, `name = "close_agent"` | arguments 中包含目标 agent id |
| sub-agent 消息发送 | `response_item function_call`, `name = "send_input"` | arguments 中包含目标 agent id 和消息 |

## 字段来源对照

| 信息 | Hook 中观察到 | JSONL 中观察到 |
|---|---:|---:|
| `session_id` | 是 | 是 |
| `turn_id` | 是 | 是 |
| `transcript_path` | 是 | 文件路径本身 / hook 记录 |
| `model` | 是 | 是 |
| `permission_mode` | 是 | 是 |
| `prompt` 完整正文 | 是 | 是 |
| `tool_input` 完整对象 | 是 | 是 |
| `tool_response` / tool output | 是 | 是 |
| `last_assistant_message` | 是 | `task_complete` / assistant message 中可见相关输出 |
| token usage | 未在 hook schema 中观察到 | 是，`event_msg token_count` |
| cache tokens | 未在 hook schema 中观察到 | 是，`event_msg token_count` |
| rate limits | 未在 hook schema 中观察到 | 是，`event_msg token_count` |
| context window | 未在 hook schema 中观察到 | 是，`event_msg token_count` |
| per-tool-call model input/output tokens | 未在 hook schema 中观察到 | 未在 tool call / output item 中观察到 |
| task duration / TTFT | 未在 hook schema 中观察到 | 是，`event_msg task_complete` |
| patch result | hook tool response 中有字符串输出 | 是，`event_msg patch_apply_end` |
| sub-agent id / nickname | 未在 hook schema 中观察到专用事件 | 是，`spawn_agent` output |

## Sources

- OpenAI Codex source tag inspected locally: `openai/codex` `rust-v0.130.0`
- Local Codex hook spike: `/Users/howard/zylos/components/dashboard/spike/codex-hooks.jsonl`
- Local Dashboard repo: `/Users/howard/zylos/workspace/zylos-dashboard`
