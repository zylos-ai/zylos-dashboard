# 部署与安全

> 所属总方案：[solution.md](../solution.md)

## 模块职责

Dashboard 的组件结构、部署配置、安全保护和验证计划。

## 组件目录结构

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
│   │   └── telemetry-adapter.js # OTel OTLP (Phase 2)
│   ├── otel/
│   │   ├── collector.js         # OTLP 接收端
│   │   ├── claude-codec.js      # claude_code.* 解析
│   │   ├── codex-codec.js       # codex.* 解析
│   │   └── storage.js           # OTel → SQLite
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

## Caddy 路由

走 http_routes marker block：

```
handle_path /dashboard/* {
    reverse_proxy localhost:{DASHBOARD_PORT}
}
```

访问地址：`https://zylos01.jinglever.com/dashboard/`

## PM2 服务

```yaml
service:
  name: zylos-dashboard
  entry: scripts/server.js
```

## 技术选型

| 层 | 选型 | 理由 |
|---|------|------|
| 后端 | Node.js + Express/Fastify | 与 zylos 技术栈一致 |
| 前端 | Vanilla JS + Chart.js | 零构建、即开即用 |
| 数据读取 | better-sqlite3 (readonly) + fs.watch + polling | 三层只读；fs.watch + polling 兜底 |
| 实时推送 | SSE + polling fallback | 只读不需要双向通信 |
| OTel 接收 | @opentelemetry/sdk-node | 轻量 OTLP 接收端 |
| OTel 存储 | SQLite (dashboard 自有 DB) | 不污染已有数据库 |
| 部署 | PM2 + Caddy route | zylos 标准方式 |

## 安全

### 数据只读保护

- **SQLite 三层只读**：URI `?mode=ro` + `fileMustExist: true` + `PRAGMA query_only = ON`
- **查询即开即关**：不持长事务，避免 WAL checkpoint 被拖住
- **无外部网络依赖**：仅读取本地文件和数据库

### 访问控制

- **认证**：管理界面登录后发 HttpOnly + SameSite=Strict cookie；REST API 和 SSE 走同源 cookie；CLI 支持 `Authorization: Bearer <token>`
- **URL token 默认关闭**：有泄露面（浏览器历史、access log、Referer），仅 localhost + 显式配置时可用
- **绑定 localhost**：server 只监听 127.0.0.1，外部走 Caddy 反代

### 敏感信息保护

- **字段白名单**：API 只返回状态、计数、时间戳、成本等聚合数据，不返回 prompt 原文、.env 值、消息正文
- **工具事件脱敏**：只返回 tool_name、duration、success，不返回输入参数
- **OTel 数据本地存储**：不发送到外部 SaaS

### OTel 安全清单（Phase 2 前必过）

1. **Prompt redaction 验证**：Claude (`OTEL_LOG_USER_PROMPTS` 默认关) 和 Codex (`log_user_prompt` 默认 false) 均确认 prompt 不出现在 traces/logs 中
2. **Collector 仅 localhost**：OTel 数据不直接发往外部
3. **Payload field audit**：两个 runtime 的 OTel 输出逐字段检查，确认无 .env 值、API key、消息正文
4. **Exporter flush**：验证两个 runtime 的 exporter 在退出时正确 flush
5. **默认不采集 prompt 内容**：如启用，配置中标记为高风险选项

### API 降级语义

每个 adapter 独立 health check，resolver 输出包含 per-metric availability 状态。单个 adapter 故障不影响其他指标展示。

## 验证清单

### P0（MVP 上线前必过）

1. SQLite readonly smoke test（不存在不创建、INSERT 失败、SELECT 正常）
2. SQLite 并发压测（WAL 下写入循环 + dashboard 高频查询，观察 writer latency 和 WAL 增长）
3. JSON watcher 稳定性（原地写、temp+rename、半截 JSON、1000 次快速更新）
4. Caddy 路由验证（validate + reload + healthz + 现有路由不受影响）
5. Dashboard 资源基线（空闲、单客户端、5 客户端、持续更新 10 分钟，记录 RSS/CPU/事件延迟）

### P1（Phase 2 前必过）

6. OTel 隔离测试（独立 HOME/测试进程/localhost collector，对比 on/off 延迟和资源）
7. OTel payload 敏感信息检查（安全清单全部通过）
8. JSONL rotation 测试（copytruncate、rename-create、truncate 下 tail offset 恢复）
9. Caddy SSE 缓冲验证（是否需要 `flush_interval -1`）
10. Codex OTel 字段映射验证（`codex.*` 事件逐字段映射到统一指标）
11. Claude OTel 字段映射验证（`claude_code.*` 事件逐字段确认与文档一致）

## 依赖

- Caddy（HTTP 反代）
- PM2（进程管理）
- Node.js + npm（运行时和依赖安装）
- zylos 组件规范（`zylos add` 标准安装流程）
