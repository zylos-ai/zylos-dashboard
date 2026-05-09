# Hook + StatusLine 数据清单（Claude Code + Codex）

> Claude Code 数据来源：Hook 系统 + StatusLine + 自定义 spike probe 脚本
> Codex 数据来源：Jinglever 实测（0.128 spike）+ upstream 源码分析
> 采集时间：2026-05-08 起

## 概述

Hook 数据通过 Claude Code 的 Hook 机制（`settings.json` 中配置）在各种生命周期事件触发时捕获。每个事件由 spike probe 脚本写入 JSONL 文件。

## 数据格式

每行一个 JSON 对象：

```json
{
  "ts": "2026-05-09T15:49:37.863Z",
  "event": "unknown",
  "payload": { ... }
}
```

- `ts`：事件时间戳（ISO 8601）
- `event`：事件分类标记（当前统一为 `unknown`，分类靠 payload 内字段）
- `payload`：事件详情对象

## 公共 Payload 属性

所有事件都包含以下属性：

| 属性 | 说明 | 示例值 |
|------|------|--------|
| `session_id` | 会话 ID | `78bbe2b1-d042-...` |
| `transcript_path` | 对话记录文件路径 | `/home/howard/.claude/projects/...` |
| `cwd` | 当前工作目录 | `/home/howard/zylos` |
| `permission_mode` | 权限模式 | `bypassPermissions` |
| `hook_event_name` | Hook 事件类型 | `PreToolUse`, `PostToolUse` 等 |

---

## 一、会话生命周期事件

### `SessionStart`（19 条）

会话启动事件。

| 属性 | 说明 |
|------|------|
| `model` | 使用的模型 |
| `source` | 启动来源 |

### `SessionEnd`（18 条）

会话结束事件。

| 属性 | 说明 |
|------|------|
| `reason` | 结束原因 |

### `Stop`（162 条）

模型停止响应。

| 属性 | 说明 |
|------|------|
| `effort` | 思考力度 |
| `last_assistant_message` | 最后一条助手消息（完整内容） |
| `stop_hook_active` | 是否有 stop hook 活跃 |

---

## 二、用户输入事件

### `UserPromptSubmit`（163 条）

用户提交输入。

| 属性 | 说明 |
|------|------|
| `prompt` | 用户完整输入内容 |

---

## 三、工具调用事件（核心）

### `PreToolUse`（总计 1,855 条）

工具调用前触发，按工具名细分：

| 工具名 | 数量 | 特有属性 |
|--------|------|----------|
| `Bash` | 1,009 | `tool_input.command`, `tool_input.description` |
| `Read` | 405 | `tool_input.file_path`, `tool_input.limit`, `tool_input.offset` |
| `Edit` | 214 | `tool_input.file_path`, `tool_input.old_string`, `tool_input.new_string` |
| `WebSearch` | 69 | `tool_input.query` |
| `WebFetch` | 38 | `tool_input.url` |
| `Write` | 31 | `tool_input.file_path`, `tool_input.content` |
| `Agent` | 27 | `tool_input.prompt`, `tool_input.subagent_type` |
| `ToolSearch` | 27 | `tool_input.query` |
| `Skill` | 20 | `tool_input.skill`, `tool_input.args` |
| `TaskList` | 9 | — |
| `TaskUpdate` | 3 | `tool_input.task_id`, `tool_input.status` |
| `TaskCreate` | 2 | `tool_input.description`, `tool_input.subject` |

**公共 PreToolUse 属性：**

| 属性 | 说明 |
|------|------|
| `tool_name` | 工具名称 |
| `tool_input` | 工具输入参数（完整 JSON 对象） |
| `tool_use_id` | 工具使用 ID |
| `agent_id` | 子代理 ID（子代理内的工具调用） |
| `agent_type` | 子代理类型 |
| `effort` | 思考力度 |

### `PostToolUse`（总计 1,826 条）

工具调用成功后触发，工具分布与 PreToolUse 对应。

| 属性 | 说明 |
|------|------|
| `tool_name` | 工具名称 |
| `tool_input` | 工具输入 |
| `tool_response` | **工具输出内容（完整）** |
| `tool_use_id` | 工具使用 ID |
| `duration_ms` | 工具执行耗时（ms） |
| `agent_id` | 子代理 ID |
| `agent_type` | 子代理类型 |
| `effort` | 思考力度 |

### `PostToolUseFailure`（总计 60 条）

工具调用失败时触发。

| 工具名 | 数量 |
|--------|------|
| `Bash` | 33 |
| `Read` | 26 |
| `WebFetch` | 1 |

| 属性 | 说明 |
|------|------|
| `tool_name` | 工具名称 |
| `error` | 错误信息 |
| `is_interrupt` | 是否被中断 |
| `duration_ms` | 耗时 |

### `PostToolBatch`（1,560 条）

一组工具调用完成后的批次事件。

| 属性 | 说明 |
|------|------|
| `tool_calls` | 工具调用列表（数组），每个元素包含：|
| ↳ `tool_name` | 工具名 |
| ↳ `tool_input` | 工具输入 |
| ↳ `tool_use_id` | 使用 ID |
| ↳ `tool_response` | 工具输出（完整内容） |
| `agent_id` | 子代理 ID |
| `agent_type` | 子代理类型 |
| `effort` | 思考力度 |

---

## 四、子代理事件

### `SubagentStart`（27 条）

子代理启动。

| 属性 | 说明 |
|------|------|
| `agent_id` | 子代理 ID |
| `agent_type` | 子代理类型（如 `general-purpose`, `Explore`） |

### `SubagentStop`（185 条）

子代理停止。

| 属性 | 说明 |
|------|------|
| `agent_id` | 子代理 ID |
| `agent_transcript_path` | 子代理对话记录路径 |
| `agent_type` | 子代理类型 |
| `effort` | 思考力度 |
| `last_assistant_message` | 子代理最后消息 |
| `stop_hook_active` | 是否有 stop hook |

---

## 五、配置与环境事件

### `InstructionsLoaded`（35 条）

CLAUDE.md / 指令文件加载。

| 属性 | 说明 |
|------|------|
| `file_path` | 加载的文件路径 |
| `load_reason` | 加载原因 |
| `memory_type` | 内存类型 |
| `trigger_file_path` | 触发文件路径 |

### `ConfigChange`（32 条）

配置文件变更。

| 属性 | 说明 |
|------|------|
| `file_path` | 变更的配置文件 |
| `source` | 变更来源 |

### `CwdChanged`（16 条）

工作目录变更。

| 属性 | 说明 |
|------|------|
| `old_cwd` | 旧目录 |
| `new_cwd` | 新目录 |

---

## 六、通知事件

### `Notification`（102 条）

系统通知。

| 属性 | 说明 |
|------|------|
| `message` | 通知内容 |
| `notification_type` | 通知类型 |

---

## 七、任务事件

### `TaskCreated`（2 条）

| 属性 | 说明 |
|------|------|
| `task_id` | 任务 ID |
| `task_description` | 任务描述 |
| `task_subject` | 任务主题 |

### `TaskCompleted`（2 条）

属性同 TaskCreated。

---

## 八、数据量统计

### 按事件类型

| 事件类型 | 数量 | 占比 |
|----------|------|------|
| PostToolBatch | 1,560 | 25.9% |
| PreToolUse (合计) | 1,855 | 30.8% |
| PostToolUse (合计) | 1,826 | 30.3% |
| PostToolUseFailure (合计) | 60 | 1.0% |
| SubagentStop | 185 | 3.1% |
| UserPromptSubmit | 163 | 2.7% |
| Stop | 162 | 2.7% |
| Notification | 102 | 1.7% |
| InstructionsLoaded | 35 | 0.6% |
| ConfigChange | 32 | 0.5% |
| SubagentStart | 27 | 0.4% |
| SessionStart | 19 | 0.3% |
| SessionEnd | 18 | 0.3% |
| CwdChanged | 16 | 0.3% |
| TaskCreated / TaskCompleted | 4 | <0.1% |

### 按工具使用频率

| 工具 | PreToolUse | PostToolUse | Failure |
|------|------------|-------------|---------|
| Bash | 1,009 | 975 | 33 |
| Read | 405 | 379 | 26 |
| Edit | 214 | 214 | 0 |
| WebSearch | 69 | 69 | 0 |
| WebFetch | 38 | 37 | 1 |
| Write | 31 | 31 | 0 |
| Agent | 27 | 27 | 0 |
| ToolSearch | 27 | 27 | 0 |
| Skill | 20 | 20 | 0 |
| TaskList | 9 | 9 | 0 |
| TaskUpdate | 3 | 3 | 0 |
| TaskCreate | 2 | 2 | 0 |

---

## 九、数据内容特点

### 可获取的完整内容
- 每次 Bash 命令的完整输入和输出
- 每次文件读取/编辑/写入的完整参数（文件路径、编辑内容）
- 用户每次输入的完整文本
- 模型最后一条回复的完整内容（Stop 事件）
- 子代理的完整最后消息
- WebSearch 查询词和 WebFetch URL

### 不包含的数据
- Token 使用量和费用（无，需从 OTel 获取）
- API 请求的模型名和性能指标（无，需从 OTel 获取）
- 调用链关系（扁平事件，无 trace/span 关联）
- 缓存命中率（无）
- Time to First Token（无）

---

## 十、StatusLine 数据（Claude Code 独有）

StatusLine 是 Claude Code 底部状态栏，通过 `settings.json` 配置一个 shell 脚本，每次状态更新时从 stdin 接收完整的 JSON 会话数据。

**这是 Hook 无法获取的 token/费用/缓存数据的补充来源。**

### 配置方式

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh",
    "refreshInterval": 5
  }
}
```

脚本从 stdin 读取 JSON → 解析 → stdout 输出显示内容。也可以同时写入文件用于数据采集。

### 可获取的数据字段

#### 模型信息

| 字段 | 类型 | 说明 |
|------|------|------|
| `model.id` | string | 模型 ID（如 `claude-opus-4-6`） |
| `model.display_name` | string | 模型显示名（如 `Opus`） |

#### Context Window 与 Token 使用（最关键）

| 字段 | 类型 | 说明 |
|------|------|------|
| `context_window.total_input_tokens` | number | 当前上下文中的总输入 token |
| `context_window.total_output_tokens` | number | 最近一次响应的输出 token |
| `context_window.context_window_size` | number | 最大上下文窗口（200000 或 1000000） |
| `context_window.used_percentage` | number | 上下文使用百分比 |
| `context_window.remaining_percentage` | number | 上下文剩余百分比 |
| `context_window.current_usage.input_tokens` | number | 新输入 token |
| `context_window.current_usage.output_tokens` | number | 当前响应输出 token |
| `context_window.current_usage.cache_creation_input_tokens` | number | **缓存创建 token** |
| `context_window.current_usage.cache_read_input_tokens` | number | **缓存命中 token** |

注：`current_usage` 在首次 API 调用前和 `/compact` 后为 null，直到下一次 API 调用。

#### 费用与时长

| 字段 | 类型 | 说明 |
|------|------|------|
| `cost.total_cost_usd` | number | **会话累计费用（USD）** |
| `cost.total_duration_ms` | number | 会话总时长（ms） |
| `cost.total_api_duration_ms` | number | API 等待总时长（ms） |
| `cost.total_lines_added` | number | 代码新增行数 |
| `cost.total_lines_removed` | number | 代码删除行数 |

#### 速率限制（仅 Pro/Max 订阅用户）

| 字段 | 类型 | 说明 |
|------|------|------|
| `rate_limits.five_hour.used_percentage` | number | 5 小时窗口使用率 |
| `rate_limits.five_hour.resets_at` | number | 5 小时窗口重置时间（Unix epoch） |
| `rate_limits.seven_day.used_percentage` | number | 7 天窗口使用率 |
| `rate_limits.seven_day.resets_at` | number | 7 天窗口重置时间 |

注：仅首次 API 调用后可用，仅限 Claude.ai 订阅用户。

#### 推理控制

| 字段 | 类型 | 说明 |
|------|------|------|
| `effort.level` | string | 推理力度（`low`/`medium`/`high`/`xhigh`/`max`） |
| `thinking.enabled` | boolean | 是否启用 extended thinking |

#### 会话信息

| 字段 | 类型 | 说明 |
|------|------|------|
| `session_id` | string | 会话 ID |
| `session_name` | string | 自定义会话名（`--name` 或 `/rename`） |
| `transcript_path` | string | 对话记录文件路径 |
| `version` | string | Claude Code 版本号 |

#### 工作区

| 字段 | 类型 | 说明 |
|------|------|------|
| `workspace.current_dir` | string | 当前工作目录 |
| `workspace.project_dir` | string | 项目启动目录 |
| `workspace.added_dirs` | array | `/add-dir` 添加的额外目录 |
| `workspace.git_worktree` | string | Git worktree 名称 |

#### Agent 与 Worktree

| 字段 | 类型 | 说明 | 条件 |
|------|------|------|------|
| `agent.name` | string | Agent 名称 | `--agent` 模式 |
| `worktree.name` | string | Worktree 名称 | `--worktree` 模式 |
| `worktree.path` | string | Worktree 路径 | `--worktree` 模式 |
| `worktree.branch` | string | Worktree 分支 | `--worktree` 模式 |

#### 其他

| 字段 | 类型 | 说明 |
|------|------|------|
| `output_style.name` | string | 当前输出样式名 |
| `exceeds_200k_tokens` | boolean | token 总量是否超过 200K |
| `vim.mode` | string | Vim 模式（`NORMAL`/`INSERT`/`VISUAL`） |

### 更新时机

StatusLine 在以下事件后更新（300ms 防抖）：
- 新的助手消息
- `/compact` 完成
- 权限模式变更
- Vim 模式切换
- `refreshInterval` 定时刷新（空闲时也会触发）

### 作为数据采集源的方案

StatusLine 脚本可以同时完成两件事：显示状态栏 + 写入数据文件。

```bash
#!/bin/bash
input=$(cat)
# 1. 追加到 JSONL 数据文件
echo "$input" >> ~/zylos/workspace/zylos-dashboard/spike/data/statusline-events.jsonl
# 2. 输出状态栏显示
MODEL=$(echo "$input" | jq -r '.model.display_name')
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
COST=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')
echo "[$MODEL] ${PCT}% | \$${COST}"
```

### StatusLine 独有数据（Hook 和 OTel 都不提供）

| 数据 | StatusLine | Hook | OTel |
|------|-----------|------|------|
| context_window.used_percentage | ✅ | ❌ | ❌ |
| context_window.remaining_percentage | ✅ | ❌ | ❌ |
| context_window_size | ✅ | ❌ | ❌ |
| cost.total_cost_usd（累计） | ✅ | ❌ | ✅ 按次（非累计） |
| cost.total_duration_ms | ✅ | ❌ | ❌ |
| cost.total_api_duration_ms | ✅ | ❌ | ❌ |
| rate_limits（5h/7d） | ✅ | ❌ | ❌ |
| effort.level | ✅ | ❌ | ❌ |
| thinking.enabled | ✅ | ❌ | ❌ |
| cache_read/creation_tokens（当前） | ✅ | ❌ | ✅ 按次 |
| lines_added / lines_removed（累计） | ✅ | ❌ | ✅ |
| exceeds_200k_tokens | ✅ | ❌ | ❌ |

---

## 十一、三源对比：Hook vs OTel vs StatusLine

| 维度 | Hook | OTel | StatusLine |
|------|------|------|------------|
| 工具输入/输出 | ✅ 完整 | ✅ 完整（需开启隐私控制） | ❌ |
| 用户输入 | ✅ 完整 | ✅ 可控 | ❌ |
| 模型/Token/费用 | ❌ | ✅ 精确（按次） | ✅ 累计 |
| 调用链追踪 | ❌ | ✅ span 树 | ❌ |
| 子代理追踪 | ✅ Start/Stop | ✅ span + link | ❌ |
| 上下文窗口用量 | ❌ | ❌ | ✅ 实时百分比 |
| 速率限制 | ❌ | ❌ | ✅ 独有 |
| 推理力度/思考 | ❌ | ❌ | ✅ 独有 |
| 缓存命中率 | ❌ | ✅ 按次 | ✅ 当前快照 |
| 配置/环境变更 | ✅ 独有 | ❌ | ❌ |
| 通知事件 | ✅ 独有 | ❌ | ❌ |
| CLAUDE.md 加载 | ✅ 独有 | ❌ |
| 数据量 | 大（~30MB/天） | 小（~145KB/25min） |
| 扩展性 | 自定义 JSONL | 标准 OTLP |

---

# Codex Hook 数据清单

> 数据来源：Jinglever 实测（Codex v0.128.0 spike）+ upstream 源码分析

## 概述

Codex Hook 机制与 Claude Code 类似，通过配置文件注册 shell 命令，在生命周期事件触发时从 stdin 接收 JSON payload。

## Hook 事件类型（8 种）

数据置信度分三档标注：

### ✅ 已实测（spike 中实际收到数据）

#### `SessionStart`

| 属性 | 说明 |
|------|------|
| `session_id` | 会话 ID |
| `transcript_path` | 对话记录路径（rollout JSONL） |
| `cwd` | 工作目录 |
| `hook_event_name` | `SessionStart` |
| `model` | 模型名 |
| `permission_mode` | 权限模式 |
| `source` | 启动来源（`startup` / `resume` / `clear`） |

#### `UserPromptSubmit`

| 属性 | 说明 |
|------|------|
| `session_id` | 会话 ID |
| `turn_id` | 轮次 ID |
| `transcript_path` | 对话记录路径 |
| `cwd` | 工作目录 |
| `hook_event_name` | `UserPromptSubmit` |
| `model` | 模型名 |
| `permission_mode` | 权限模式 |
| `prompt` | **用户完整输入** |

#### `PreToolUse`

| 属性 | 说明 |
|------|------|
| `session_id` | 会话 ID |
| `turn_id` | 轮次 ID |
| `transcript_path` | 对话记录路径 |
| `cwd` | 工作目录 |
| `hook_event_name` | `PreToolUse` |
| `model` | 模型名 |
| `permission_mode` | 权限模式 |
| `tool_name` | 工具名 |
| `tool_input` | 工具输入参数 |
| `tool_use_id` | 工具使用 ID |

#### `PostToolUse`

| 属性 | 说明 |
|------|------|
| `session_id` | 会话 ID |
| `turn_id` | 轮次 ID |
| `transcript_path` | 对话记录路径 |
| `cwd` | 工作目录 |
| `hook_event_name` | `PostToolUse` |
| `model` | 模型名 |
| `permission_mode` | 权限模式 |
| `tool_name` | 工具名 |
| `tool_input` | 工具输入 |
| `tool_response` | **工具输出（完整）** |
| `tool_use_id` | 工具使用 ID |

#### `Stop`

| 属性 | 说明 |
|------|------|
| `session_id` | 会话 ID |
| `turn_id` | 轮次 ID |
| `transcript_path` | 对话记录路径 |
| `cwd` | 工作目录 |
| `hook_event_name` | `Stop` |
| `model` | 模型名 |
| `permission_mode` | 权限模式 |
| `stop_hook_active` | 是否有 stop hook |
| `last_assistant_message` | 最后回复内容 |

### 🔍 源码确认但未在 spike 中触发

#### `PermissionRequest`

配置了但未触发（因测试环境为 bypass 模式）。

| 属性 | 说明 |
|------|------|
| `session_id` | 会话 ID |
| `turn_id` | 轮次 ID |
| `transcript_path` | 对话记录路径 |
| `cwd` | 工作目录 |
| `hook_event_name` | `PermissionRequest` |
| `model` | 模型名 |
| `permission_mode` | 权限模式 |
| `tool_name` | 工具名 |
| `tool_input` | 工具输入 |
| — | **注意：无 tool_use_id** |

#### `PreCompact` / `PostCompact`

manual/auto compaction 时触发。

| 属性 | 说明 |
|------|------|
| `session_id` | 会话 ID |
| `turn_id` | 轮次 ID |
| `transcript_path` | 对话记录路径 |
| `cwd` | 工作目录 |
| `hook_event_name` | `PreCompact` / `PostCompact` |
| `model` | 模型名 |
| `trigger` | 触发方式（`manual` / `auto`） |

## Hook 输出能力

Hook 脚本可通过 stdout 返回 JSON 影响 Codex 行为：

| 事件 | 可输出字段 | 说明 |
|------|-----------|------|
| 所有事件 | `continue`, `stopReason`, `suppressOutput`, `systemMessage` | 通用控制 |
| SessionStart / UserPromptSubmit / PreToolUse / PostToolUse | `additionalContext` | 注入额外上下文 |
| PreToolUse | `decision=block` | 阻断工具调用 |
| PostToolUse | `updatedMCPToolOutput` | 修改 MCP 工具输出 |
| PermissionRequest | `decision.behavior = allow / deny` | 权限决策 |
| PreCompact / PostCompact | continue / stop 语义 | 仅控制流程 |

---

## Claude Code vs Codex Hook 对比

| 维度 | Claude Code | Codex |
|------|-------------|-------|
| 事件类型 | 17 种（含 PostToolBatch 等） | 8 种 |
| 工具调用 | PreToolUse + PostToolUse + PostToolUseFailure + PostToolBatch | PreToolUse + PostToolUse |
| 子代理 | ✅ SubagentStart/Stop | ❌ |
| 配置变更 | ✅ ConfigChange / InstructionsLoaded | ❌ |
| 通知 | ✅ Notification | ❌ |
| 目录变更 | ✅ CwdChanged | ❌ |
| 权限请求 | ❌（通过 OTel tool_decision） | ✅ PermissionRequest |
| Compaction | ❌ | ✅ PreCompact/PostCompact |
| 输出控制 | 有限（continue/block） | 更丰富（additionalContext、decision、updatedMCPToolOutput） |
| turn_id | ❌ | ✅ 每个事件都有 |
| 总数据量 | 6003 条 / ~30 MB | — |
