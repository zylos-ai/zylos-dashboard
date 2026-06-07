# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-06-08

### Added
- Multi-Agent Pulse Wall — single wall showing every agent's live state on one tile each: live mascot (busy/thinking/idle/stuck/offline), per-agent color derived from a name hash, context ring, now-playing, cost + sparkline, and last-seen; offline tiles go grey and clicking a tile drills into that agent's full dashboard through the hub (#156)
- Agent identity + registry — each install resolves a name/id (config `agent.name` → `ZYLOS_AGENT_NAME` → hostname → dir name → `zylos`) used for color and registry membership (#156)
- Fleet hub backend — `fleet-poller`, `agent-color`, fleet registry, and a token-isolated drill-down proxy (`fleet-proxy`) that never leaks an agent's token to the browser (#156)

## [0.2.0] - 2026-06-03

### Added
- Codex runtime observability MVP — full dashboard support for Codex runtime with latency metrics (TTFT, turn duration), Codex-specific collectors, and runtime-aware panel visibility (#131)
- Codex runtime adaptation plan documentation (#129)

### Fixed
- Map Claude runtime timeline events to proper labels — `post_tool_use` → "Tool", `stop` → "Turn" (#135)
- Hide latency section on Claude runtime — TTFT and turn duration are Codex-only metrics (#136)
- Latency card CSS specificity — `.latency-section { display: flex }` overrode `[hidden]` attribute (#138)

## [0.1.1] - 2026-05-18

### Fixed
- Mobile layout: Cost cards stack vertically on narrow screens (< 480px) instead of overflowing (#125)

## [0.1.0] - 2026-05-18

First release.

### Added
- Real-time agent state monitoring — idle, busy, stuck, waiting states with pixel mascot (#100, #102)
- Context usage, rate limit, and cost tracking from statusline data (#77, #79)
- Tool activity feed with running tools and subagent tracking (#53, #58, #66, #87)
- Token stats panel — input/output/cache hit breakdown (#57)
- Cost and cache metrics with 3 time dimensions (session/today/7d) (#56)
- Project distribution by output tokens (#97, #101)
- Actions modal — runtime switch, model/effort change, threshold, upgrade (#72, #109)
- Settings modal with model price editor (#86)
- Full i18n support (English + Chinese) with locale toggle (#89, #93, #107)
- SSE-based live updates with fs.watch file monitoring (#52)
- PM2 service health monitoring with ring gauges (#60)
- Communication channel stats from C4 bridge (#64, #65, #67, #71)
- Trends tab with 4 charts and date range controls (#69, #77)
- Cookie-based authentication with scrypt hashing and Remember Me (#98, #99)
- Caddy reverse proxy support with X-Forwarded-Prefix handling
- Hook-based data collection — 7 Claude events, 5 Codex events (#83, #75)
- Offline spool for hook events when dashboard is unavailable
- Graceful Codex runtime degradation — hide Claude-only panels (#104)
- Countdown timer and auto-refresh on runtime switch (#104)
- Install/uninstall lifecycle hooks for Claude Code settings (#112, #113)
- Secure defaults — auto-generated 32-char auth password on install (#119)
- CPU gauge warm-up with double-sample on startup (#121)
- macOS memory reporting — parse vm_stat to exclude cached files (#123)
- Runtime info bar with version, runtime, and state display (#72)
- Friendly metric source labels (#55)
- JSONL usage extraction, retired OTel dependency (#83)
- Rich timeline with assistant messages and top project extraction (#61, #62, #63)

### Fixed
- State inference improvements — skip POSSIBLY_STUCK on recent tool progress (#70, #73)
- CPU percentage uses os.cpus() delta for accuracy (#74)
- Persist lastProgressAt across dashboard restarts (#76)
- Context bar uses standard 0-100% color scale (#81)
- Cache buster versioning for frontend assets (#80)

### Security
- Ingest endpoint dual gate: loopback IP + X-Forwarded-Prefix rejection (#112)
- Rate limiting and IP lockout on failed login attempts
- CSRF protection on logout
- Secure cookie attributes (HttpOnly, Secure, SameSite=Strict)
- Auth enabled by default with auto-generated password (#119)
- ingestToken authorization header support (#119)

### Changed
- Template conformance — auth configure, fail-fast, lib→src/lib structure (#115)
- Cleaned post-upgrade migration logic for first release (#117)
