# OTel 数据清单（Claude Code + Codex）

> 采集端点：otlp-spike (http://127.0.0.1:4318)
> 协议：HTTP/JSON (OTLP)
> 采集时间：2026-05-09 23:48 起（clean env 重启后）

## 概述

Claude Code 通过 OTLP 协议发送三类遥测数据：**Traces**（调用链）、**Logs**（事件日志）、**Metrics**（指标度量）。所有数据共享一组公共属性标识用户和会话。

## 公共属性（所有数据类型共享）

| 属性 | 说明 | 示例值 |
|------|------|--------|
| `host.arch` | 主机架构 | `amd64` |
| `os.type` | 操作系统 | `linux` |
| `os.version` | 内核版本 | `6.8.0-110-generic` |
| `service.name` | 服务名 | `claude-code` |
| `service.version` | 版本号 | `2.1.138` |
| `user.id` | 用户ID（hash） | `070cef4b...` |
| `session.id` | 会话ID | `a77d9d30-...` |
| `app.version` | 应用版本 | `2.1.138` |
| `organization.id` | 组织ID | `ab955fd7-...` |
| `user.email` | 用户邮箱 | `***@outlook.com` |
| `user.account_uuid` | 账户UUID | `25cd63a9-...` |
| `user.account_id` | 账户ID | `user_015fk7...` |
| `terminal.type` | 终端类型 | `xterm-256color` |

---

## 一、Traces（调用链追踪）

追踪作用域：`com.anthropic.claude_code.tracing` v1.0.0

Traces 使用 span 树结构，记录每次交互从用户输入到工具执行的完整调用链。

### 1.1 Span 类型

#### `interaction` — 用户交互

顶层 span，记录一次完整的用户交互回合。

| 属性 | 类型 | 说明 |
|------|------|------|
| `span.type` | string | `interaction` |
| `user_prompt` | string | 用户输入的完整内容 |
| `user_prompt_length` | int | 输入字符数 |
| `interaction.sequence` | int | 交互序号（从 1 开始） |
| `interaction.duration_ms` | int | 交互总耗时（ms） |

#### `llm_request` — LLM API 请求

记录每次对 Anthropic API 的调用，包含完整的 token 和性能数据。

| 属性 | 类型 | 说明 |
|------|------|------|
| `span.type` | string | `llm_request` |
| `model` | string | 实际使用的模型（如 `claude-opus-4-6`, `claude-haiku-4-5-20251001`） |
| `gen_ai.system` | string | `anthropic` |
| `gen_ai.request.model` | string | 请求的模型名 |
| `llm_request.context` | string | 请求上下文（如 `interaction`） |
| `speed` | string | 速度模式（`normal`） |
| `duration_ms` | int | API 调用耗时（ms） |
| `input_tokens` | int | 输入 token 数 |
| `output_tokens` | int | 输出 token 数 |
| `cache_read_tokens` | int | 缓存读取 token 数 |
| `cache_creation_tokens` | int | 缓存创建 token 数 |
| `success` | bool | 是否成功 |
| `attempt` | int | 重试次数 |
| `request_id` | string | Anthropic 请求 ID |
| `gen_ai.response.id` | string | 响应 ID |
| `client_request_id` | string | 客户端请求 ID |
| `ttft_ms` | int | Time to First Token（ms） |
| `stop_reason` | string | 停止原因（`end_turn`, `tool_use`） |
| `gen_ai.response.finish_reasons` | array | 完成原因列表 |

**Span 事件：**
- `gen_ai.request.attempt`：记录每次请求尝试，含 `attempt` 序号和 `client_request_id`

#### `tool` — 工具调用

记录每个工具的调用详情。

| 属性 | 类型 | 说明 |
|------|------|------|
| `span.type` | string | `tool` |
| `tool_name` | string | 工具名（`Bash`, `Read`, `Edit`, `Write`, `Agent` 等） |
| `full_command` | string | 完整命令（Bash 工具时） |
| `file_path` | string | 文件路径（Read/Edit/Write 工具时） |
| `subagent_type` | string | 子代理类型（Agent 工具时） |
| `duration_ms` | int | 工具执行总耗时（ms） |

**Span 事件：**
- `tool.output`：工具输出内容
  - `bash_command`：Bash 命令
  - `output`：命令输出内容（完整）

#### `tool.blocked_on_user` — 权限决策

记录工具调用是否需要用户授权。

| 属性 | 类型 | 说明 |
|------|------|------|
| `span.type` | string | `tool.blocked_on_user` |
| `duration_ms` | int | 等待决策耗时（ms） |
| `decision` | string | 决策结果（`accept`, `reject`） |
| `source` | string | 决策来源（`config` = 自动授权, `user` = 用户手动） |

#### `tool.execution` — 工具执行

工具的实际执行阶段。

| 属性 | 类型 | 说明 |
|------|------|------|
| `span.type` | string | `tool.execution` |
| `duration_ms` | int | 执行耗时（ms） |
| `success` | bool | 是否成功 |

### 1.2 Span 层级关系

```
interaction (用户交互)
├── llm_request (LLM 调用, 可能多次)
│   └── link → 上一个 llm_request (会话串联)
├── tool (工具调用)
│   ├── tool.blocked_on_user (权限检查)
│   └── tool.execution (实际执行)
└── llm_request (下一次 LLM 调用)
```

---

## 二、Logs（事件日志）

日志作用域：`com.anthropic.claude_code.events` v2.1.138

### 2.1 事件类型

#### `user_prompt` — 用户输入

| 属性 | 类型 | 说明 |
|------|------|------|
| `event.name` | string | `user_prompt` |
| `event.timestamp` | string | ISO 时间戳 |
| `event.sequence` | int | 事件序号 |
| `prompt.id` | string | 提示 ID |
| `prompt_length` | string | 输入长度 |
| `prompt` | string | 完整用户输入（需 `OTEL_LOG_USER_PROMPTS=true`） |
| `command_name` | string | 斜杠命令名（如 `exit`，非命令时不存在） |
| `command_source` | string | 命令来源（如 `builtin`） |

#### `api_request` — API 请求完成

| 属性 | 类型 | 说明 |
|------|------|------|
| `event.name` | string | `api_request` |
| `prompt.id` | string | 关联的提示 ID |
| `model` | string | 使用的模型 |
| `input_tokens` | int | 输入 token |
| `output_tokens` | int | 输出 token |
| `cache_read_tokens` | int | 缓存读取 token |
| `cache_creation_tokens` | int | 缓存创建 token |
| `cost_usd` | double | **本次请求费用（USD）** |
| `duration_ms` | int | 请求耗时（ms） |
| `request_id` | string | Anthropic 请求 ID |
| `speed` | string | 速度模式 |
| `query_source` | string | 查询来源（`generate_session_title`, `interaction` 等） |
| `effort` | string | 思考力度（有时出现） |

#### `hook_execution_start` — Hook 开始执行

| 属性 | 类型 | 说明 |
|------|------|------|
| `event.name` | string | `hook_execution_start` |
| `hook_event` | string | Hook 事件类型（`SessionStart`, `UserPromptSubmit` 等） |
| `hook_name` | string | Hook 名称 |
| `num_hooks` | string | 该事件注册的 hook 数量 |
| `managed_only` | string | 是否仅限托管 hook |
| `hook_source` | string | Hook 来源（`merged`） |

#### `hook_execution_complete` — Hook 执行完成

| 属性 | 类型 | 说明 |
|------|------|------|
| `event.name` | string | `hook_execution_complete` |
| `hook_event` | string | Hook 事件类型 |
| `hook_name` | string | Hook 名称 |
| `num_hooks` | string | Hook 总数 |
| `num_success` | string | 成功数 |
| `num_blocking` | string | 阻塞数 |
| `num_non_blocking_error` | string | 非阻塞错误数 |
| `num_cancelled` | string | 取消数 |
| `total_duration_ms` | string | 总耗时（ms） |

#### `tool_decision` — 工具权限决策

| 属性 | 类型 | 说明 |
|------|------|------|
| `event.name` | string | `tool_decision` |
| `tool_name` | string | 工具名 |
| `tool_use_id` | string | 工具使用 ID |
| `decision` | string | 决策（`accept`, `reject`） |
| `source` | string | 来源（`config`, `user`） |

#### `tool_result` — 工具执行结果

| 属性 | 类型 | 说明 |
|------|------|------|
| `event.name` | string | `tool_result` |
| `tool_name` | string | 工具名 |
| `tool_use_id` | string | 工具使用 ID |
| `success` | string | 是否成功 |
| `duration_ms` | string | 执行耗时 |
| `tool_parameters` | string | 工具参数（JSON，含解析后的命令类型） |
| `tool_input` | string | 工具输入（JSON） |
| `tool_input_size_bytes` | string | 输入大小 |
| `tool_result_size_bytes` | string | 结果大小 |
| `decision_source` | string | 权限来源 |
| `decision_type` | string | 权限类型 |

---

## 三、Metrics（指标度量）

指标作用域：`com.anthropic.claude_code` v2.1.138

所有指标使用 `sum`（累积计数器）类型。

### 3.1 指标列表

| 指标名 | 单位 | 说明 | 特有属性 |
|--------|------|------|----------|
| `claude_code.session.count` | — | CLI 会话启动次数 | `start_type`（`fresh` / `resume`） |
| `claude_code.active_time.total` | seconds | 活跃时间累计 | `type`（时间类型） |
| `claude_code.cost.usage` | USD | **会话费用累计** | `model`, `query_source`, `effort` |
| `claude_code.token.usage` | tokens | Token 使用量累计 | `model`, `query_source`, `effort`, `type`（`input`/`output`/`cache_read`/`cache_creation`） |
| `claude_code.lines_of_code.count` | — | 代码行修改统计 | `type`（`added` / `removed`） |
| `claude_code.code_edit_tool.decision` | — | 代码编辑权限决策计数 | `decision`, `source`, `tool_name`, `language` |

---

## 四、隐私控制

通过环境变量控制数据采集粒度：

| 变量 | 当前值 | 作用 |
|------|--------|------|
| `OTEL_LOG_USER_PROMPTS` | `true` | Logs 中包含用户完整输入 |
| `OTEL_LOG_TOOL_CONTENT` | `true` | Logs 中包含工具输入/输出内容 |
| `OTEL_LOG_TOOL_DETAILS` | `true` | Traces 中包含工具详情（命令、文件路径） |
| `OTEL_METRICS_INCLUDE_SESSION_ID` | `true` | Metrics 包含 session.id |
| `OTEL_METRICS_INCLUDE_VERSION` | `true` | Metrics 包含 app.version |

关闭任一变量将移除对应的敏感字段，但保留结构化元数据。

---

## 五、数据量统计

采集时间窗口：约 25 分钟（2026-05-09 23:48 — 00:12）

| 数据类型 | 记录数 | 文件大小 |
|----------|--------|----------|
| Traces | 20 行 | 47 KB |
| Logs | 22 行 | 93 KB |
| Metrics | 5 行 | 5 KB |

注：每行为一个 OTLP batch，一行内可包含多个 span/log record/metric data point。实际：
- 4 interaction spans, 22 llm_request spans, 29 tool spans, 29 permission spans, 29 execution spans
- 5 user_prompt logs, 22 api_request logs, 90 hook logs, 31 tool_decision logs, 31 tool_result logs
- 6 metric instruments × 多个 data points

---

## 六、对比：OTel vs Hook 数据

| 维度 | OTel | Hook |
|------|------|------|
| 来源 | Claude Code 内置遥测 | 自定义 hook 脚本捕获 |
| 结构 | 标准 OTLP，三类分离 | 统一 JSONL，payload 嵌套 |
| 性能数据 | ✅ TTFT、token、费用、缓存 | ❌ |
| 工具内容 | ✅ 命令输入/输出 | ✅ 工具输入/输出 |
| 用户输入 | ✅（可控） | ✅ UserPromptSubmit 事件 |
| 调用链 | ✅ span 树，可追踪父子关系 | ❌ 平铺事件，无关联 |
| 模型/费用 | ✅ 精确到每次 API 调用 | ❌ |
| Hook 执行 | ✅ start/complete 配对 | ✅ 通过 hook 自身记录 |
| 子代理 | ✅ span.type + subagent_type | ✅ SubagentStart/Stop |
| 扩展性 | 标准协议，可接入任何 OTLP 后端 | 自定义格式 |

---

# Codex OTel 数据清单

> 数据来源：Codex CLI (Rust) v0.128.0，OpenTelemetry SDK 0.31.0
> 配置方式：`~/.codex/config.toml` 的 `[otel]` section（非环境变量）
> 采集数据：Jinglever 提供（151 条 OTLP JSON request）

## 配置方式

Codex 与 Claude Code 的配置方式不同：Claude Code 用 `OTEL_*` 环境变量，Codex 用 TOML 配置文件。

```toml
[otel]
log_user_prompt = true          # 默认 false
environment = "dev"
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318", protocol = "json" } }
trace_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318", protocol = "json" } }
metrics_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318", protocol = "json" } }
```

关键差异：
- `exporter` 只管 logs，不隐式启用 traces
- `metrics_exporter` 默认是 Codex 内置 Statsig；要落到本地 collector 必须显式改成 OTLP
- `trace_exporter` 默认 none；要抓 traces 必须显式声明
- HTTP JSON 需要 `protocol = "json"`

## 公共 Resource 属性

| 属性 | 说明 | 示例值 |
|------|------|--------|
| `service.name` | 服务名 | `codex_cli_rs` |
| `service.version` | 版本号 | `0.128.0` |
| `telemetry.sdk.name` | SDK 名称 | `opentelemetry` |
| `telemetry.sdk.version` | SDK 版本 | `0.31.0` |
| `telemetry.sdk.language` | SDK 语言 | `rust` |
| `env` | 环境标识 | `dev` |
| `host.name` | 主机名 | — |
| `os` | 操作系统 | — |
| `os_version` | OS 版本 | — |

数据置信度分三档：✅ 已实测（spike 中实际收到）、🔍 源码确认但未触发、📂 可作诊断源但默认不采原文。

## 一、Codex Logs ✅ 已实测

| 事件名 | 说明 |
|--------|------|
| `codex.conversation_starts` | 会话开始 |
| `codex.user_prompt` | 用户输入 |
| `codex.websocket_connect` | WebSocket 连接建立 |
| `codex.websocket_request` | WebSocket 请求发送 |
| `codex.websocket_event` | WebSocket 事件接收 |
| `codex.sse_event` | SSE 事件 |
| `codex.tool_decision` | 工具权限决策 |
| `codex.tool_result` | 工具执行结果 |
| `flushing OTEL metrics` | OTEL metrics 刷新 |

## 二、Codex Metrics（33 个） ✅ 已实测

| 指标名 | 说明 |
|--------|------|
| `codex.conversation.turn.count` | 对话轮次计数 |
| `codex.hooks.run` | Hook 运行次数 |
| `codex.hooks.run.duration_ms` | Hook 运行耗时 |
| `codex.mcp.tools.*.duration_ms` | MCP 工具调用耗时 |
| `codex.plugins.startup_sync` | 插件启动同步 |
| `codex.plugins.startup_sync.final` | 插件启动同步最终状态 |
| `codex.remote_models.load_cache.duration_ms` | 远程模型缓存加载耗时 |
| `codex.shell_snapshot` | Shell 快照 |
| `codex.shell_snapshot.duration_ms` | Shell 快照耗时 |
| `codex.skill.injected` | Skill 注入计数 |
| `codex.startup_prewarm.*` | 启动预热指标 |
| `codex.thread.*` | 线程相关指标 |
| `codex.tool.call` | 工具调用计数 |
| `codex.tool.call.duration_ms` | 工具调用耗时 |
| `codex.tool.unified_exec` | 统一执行器调用 |
| `codex.turn.e2e_duration_ms` | 轮次端到端耗时 |
| `codex.turn.memory` | 轮次内存使用 |
| `codex.turn.network_proxy` | 网络代理状态 |
| `codex.turn.token_usage` | **轮次 Token 使用量** |
| `codex.turn.tool.call` | 轮次内工具调用 |
| `codex.turn.ttfm.duration_ms` | Time to First Message |
| `codex.turn.ttft.duration_ms` | **Time to First Token** |
| `codex.websocket.event` | WebSocket 事件计数 |
| `codex.websocket.event.duration_ms` | WebSocket 事件耗时 |
| `codex.websocket.request` | WebSocket 请求计数 |
| `codex.websocket.request.duration_ms` | WebSocket 请求耗时 |

## 三、Codex Traces ✅ 已实测

Codex traces 是实现级 span（非稳定 API），span 层级较深。

| Span 名 | 说明 |
|----------|------|
| `session_init` | 会话初始化 |
| `run_turn` | 运行一个轮次 |
| `session_task.turn` | 会话任务轮次 |
| `turn/start` | 轮次开始 |
| `turn/steer` | 轮次引导 |
| `handle_responses` | 处理响应 |
| `handle_tool_call` | 处理工具调用 |
| `exec_command` | 执行命令 |
| `write_stdin` | 写入 stdin |
| `model_client.stream_responses_websocket` | WebSocket 流式响应 |
| `responses_websocket.connect` | WebSocket 连接 |
| `responses_websocket.stream_request` | WebSocket 流式请求 |
| `app_server.thread_start.*` | 应用服务器线程启动 |

## 四、Codex 本地诊断数据（非 OTel） 📂 可作诊断源

### Rollout JSONL（最有价值的本地诊断源）

路径：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`

包含 response items、tool calls 和 token_count 事件：

| 字段 | 说明 |
|------|------|
| `last_token_usage` | 最近一次 token 使用量 |
| `total_token_usage` | 累计 token 使用量 |
| `model_context_window` | 模型上下文窗口大小 |
| `rate_limits.primary.used_percent` | 主限速使用率 |
| `rate_limits.primary.window_minutes` | 主限速窗口（分钟） |
| `rate_limits.primary.resets_at` | 主限速重置时间 |
| `rate_limits.secondary.*` | 次级限速信息 |
| `plan_type` | 用户计划类型 |

### 其他本地文件

| 路径 | 说明 | 敏感性 |
|------|------|--------|
| `~/.codex/history.jsonl` | 用户输入历史 | ⚠️ 高 |
| `~/.codex/models_cache.json` | 模型缓存 | 低 |
| `~/.codex/logs_2.sqlite` | 本地日志/状态库 | 中 |
| `~/.codex/state_5.sqlite` | Thread/state 元数据 | 中 |

---

## 五、Claude Code vs Codex OTel 对比

| 维度 | Claude Code | Codex |
|------|-------------|-------|
| 语言/SDK | Node.js / JS | Rust / opentelemetry 0.31 |
| 配置方式 | `OTEL_*` 环境变量 | `config.toml` [otel] section |
| service.name | `claude-code` | `codex_cli_rs` |
| Logs | 6 种事件 | 9 种事件 |
| Metrics | 6 个指标 | 33 个指标（更丰富） |
| Traces | 5 种 span（稳定 API） | 13+ 种 span（实现级） |
| 独有数据 | cost_usd、cache tokens | MCP 工具耗时、shell_snapshot、thread 指标、rate_limits |
| 隐私控制 | 5 个 OTEL_* 开关 | `log_user_prompt` 1 个开关 |
| 本地诊断 | transcript JSONL | rollout JSONL + SQLite |

## 六、安全边界建议

| 数据类型 | 建议 |
|----------|------|
| OTel 结构化计数/耗时/状态 | ✅ 可进 dashboard 持久化 |
| OTel payload 原文（prompt、tool output） | ⚠️ 仅限本机临时 spike/debug 存储 |
| rollout/history JSONL | ❌ 不进默认 dashboard persistence |
| 敏感字段（API key、secret） | ❌ 任何路径都不持久化 |

Dashboard 默认只存结构化指标，payload 原文按 owner 明确开关启用。
