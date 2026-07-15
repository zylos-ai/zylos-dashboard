# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.4] - 2026-07-15

### Security
- **Sanitize PM2 data in /api/system**: the endpoint returned raw PM2 process objects including full `pm2_env` with internal filesystem paths, proxy URLs, usernames, and system details. Now whitelists only safe fields (pid, name, status, cpu, memory, uptime, restarts, version). (#287)

## [0.5.3] - 2026-07-04

### Fixed
- Metric maintenance retention deletes now honor the injected `now` (time anchor threaded into the delete SQL instead of SQLite `datetime('now')`), fixing the permanently-failing fixed-date PM2 retention test; production behavior unchanged (anchor defaults to the current time)

### Added
- Fleet tiles show an active-subagent count badge (⚡N) in the activity area, hidden when no subagents are running (#279)
- Header shows the dashboard component's own version next to the Zylos Dashboard logo; `/api/state` now exposes `dashboard_version`
- Single-agent view shows the viewed agent's name at the right end of the tab bar

## [0.5.2] - 2026-06-23

### Fixed
- Codex runtime metric fallback is now runtime-scoped: dashboard no longer falls back to stale Claude `statusline` metrics after switching an agent to Codex.

## [0.5.1] - 2026-06-13

### Added
- **CLI key lifecycle commands** (#276): `api-key.js` now supports `rotate <name>` (new secret, sessions invalidated atomically), `delete <name>` (permanently remove revoked keys by name), and `purge-revoked` (remove all revoked keys). CLI refactored to use Store class for the same transactional guarantees as the HTTP API.

### Fixed
- `generate` command no longer blocks name reuse after revoke — was checking all rows including revoked, now relies on the partial unique index.

## [0.5.0] - 2026-06-13

### Added
- API keys now support a full lifecycle: revoked names can be reused, active keys can be rotated atomically with the new plaintext returned once, and revoked keys can be permanently deleted individually or purged in bulk (#273).

### Fixed
- Creating a key with an active duplicate name now returns a clean conflict response instead of falling through to a generic save failure (#273).

### Upgrade notes
- Rotating a key invalidates outstanding API sessions immediately. If a fleet consumer stores that key's plaintext in config, update the consumer config with the newly returned plaintext key after rotation (#273).

## [0.4.0] - 2026-06-12

### Added
- **Event-loop delay observability** — the dashboard measures its own event-loop delay and surfaces slow-ingest warnings in logs and `/api/health`, making producer-side wedging diagnosable instead of silent (#260, #262)
- **Ingest queue** — hook event ACK is decoupled from event processing, so hook storms no longer wedge the event loop; queue depth and processing counters exposed in `/api/health` (#260, #264)
- **Fleet slow-member observability** — per-member link latency probe and connection quality levels (`ok`/`slow`/`degraded`/`stale`/`down`, strict priority) with granular failure reasons, so a slow remote is distinguishable from a dead one (#263, #266)
- Fable models in the Actions modal Claude model list — `fable[1m]` and `claude-fable-5[1m]` with `xhigh` effort support (#267, #268)

### Fixed
- **Fleet poller self-heals** — SSE connect attempts get a hard deadline (wedged handshakes can no longer freeze a member's polling forever), a watchdog revives dead or wedged recovery loops, fallback polling bridges SSE outages, and hard-down members show OFFLINE with advancing freshness instead of silently freezing; fleet payload redaction unified across the SSE and HTTP surfaces via a shared helper (#265, #270)
- Codex rollout ingestion moved off the startup path with bounded per-pass reads; the readiness listener starts before initialization; oversized rollout lines no longer stall the ingestion cursor (#254)
- Fleet proxy strips `Content-Encoding` from upstream responses — remote detail pages no longer hang when a fronting CDN compresses payloads the proxy already decoded (#255, #256)
- Fleet SSE relay failures no longer crash the dashboard process (#258)
- Subagent list height is capped with internal scrolling, and scroll position survives re-renders (#259, #261)

### Changed
- Acceptance test suite (`ACCEPTANCE=1`) now runs write-path tests against an ephemeral sandbox instance instead of the deployed dashboard — running it leaves zero synthetic rows in production data; deployed-box checks are read-only and skip when artifacts are absent (#269, #271)

## [0.3.3] - 2026-06-12

### Fixed
- Progress bars no longer 100x-inflate genuine 0-1% readings. The fraction-vs-percent heuristic (`n <= 1 ? n * 100 : n`) was removed from every percent-typed gauge — fleet tiles (context ring, threshold chip, 5h/7d rate bars, CPU/Memory/Disk mini rings) and the single-agent page (bars, labels, context threshold marker, system CPU/Disk rings). A remote agent's genuine 1% weekly usage rendered as a full red 100% bar, most visibly right after a rate-limit window reset. Cache-rate sites (true 0-1 ratios) now scale explicitly, and a static regression guard keeps the heuristic from returning (#251, #252)

## [0.3.2] - 2026-06-11

Everything since v0.2.0. (0.3.0 and 0.3.1 were version-bumped internally but never published; their changes ship here.)

### Upgrade notes
- **A one-time manual VACUUM may be required after upgrading.** The new automatic maintenance prunes old rows hourly, but the weekly VACUUM that actually shrinks the file is skipped whenever `dashboard.db` exceeds 2 GB (`db_too_large`) — so a database that already grew large under earlier versions will never slim down on its own. Agents upgrading this component: check the size of `dashboard.db` in the component data directory (e.g. `~/zylos/components/dashboard/`); if it is over 2 GB, ask your owner for approval and run a one-time manual compaction following ["Manual Compaction For Large Databases" in `docs/modules/db-maintenance.md`](docs/modules/db-maintenance.md) — in short: check free disk (VACUUM temporarily needs roughly the database's size), stop the service, back up `dashboard.db` + `-wal` + `-shm`, run `VACUUM; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;`, restart and validate. Run it at least an hour after the upgraded service has started, so the first hourly retention pass has pruned old rows first (databases from v0.2.0 start fully unpruned).

### Added
- **Agent Fleet wall** — replaces Pulse Wall as the multi-agent landing view: per-agent mascot tiles with state-aligned motion, identity hue, model/effort, context ring with threshold chip, session/today/7d cost tiers, CPU/memory/disk mini rings, 5h/7d rate-limit bars, live activity feed with subagent indicator, and summary state dots with aggregated fleet costs; the single-agent page shares the same octopus mascot set and identity hue (legacy robot mascot retired) (#164, #185, #187, #189, #190, #191)
- **Memory browser** — admin-only read view of the agent's memory directory: file tree, rendered/raw markdown viewer, git commit metadata; remote agents browsable through the fleet proxy with path jail, size caps, and symlink rejection (#213)
- **Memory online editing** — edit memory files from the Memory tab, locally and on remote agents via admin-scope keys: sha256 optimistic locking (409 on conflict, never blind-overwrite), conflict panel with mine/theirs line diff and use-mine / take-theirs / manual-merge actions, localStorage draft autosave surviving reloads, 20s live change detection while editing; read keys stay fully read-only (#227)
- **markdown-it rendering** for memory files — vendored bundle, raw HTML disabled (escaped), links hardened with `target="_blank" rel="noopener noreferrer"`, tables/blockquotes/inline formatting now render (#229)
- **In-page remote agent detail** — fleet tiles open remote dashboards inside the page through the fleet proxy instead of full navigation, with smooth view transitions (#203)
- **API key management UI** and scoped fleet access — create/revoke admin- and read-scope keys; remote Actions/Settings/Memory gated by exchanged key scope with producer-side final authority (#207, #212)
- **Fleet onboarding management UI** — add/remove remote fleet agents and rename the local dashboard agent, all from the dashboard (#210, #215)
- **Copyable Base URL in the API Keys tab** — key handoff now carries both halves the consumer's add-agent form needs (#239)
- **Sound cues** — fleet wall plays cues on agent start/finish, iterated to an ear-picked marimba scheme, with a global mute toggle that follows system output device changes (#194, #218, #223)
- Busy mascot now types on a small keyboard (#192)
- **API token authentication** for programmatic access — create scoped keys (read/admin) and exchange them for 24h session tokens via `POST /api/auth/token`; SSE connections are evicted on key revoke/expiry (#140, #146)
- **Codex runtime version visibility** — tracks the latest Codex CLI release and the running session's version, reset on session change so badges never go stale (#150, #151)
- **Tiered metric retention and DB maintenance** — metric aggregation tiers with bounded retention, PM2 sampling at 60s with 7-day windows, WAL checkpointing; keeps the dashboard database compact long-term (#141, #148)

### Changed
- Fleet liveness is connection-based with an SSE idle watchdog — remote tiles no longer flap to OFFLINE between event bursts (#180)
- Rate-limit bars invalidate after the reset window expires — show `--` instead of a stale frozen percentage, on both fleet tiles and the single-agent page (#224)
- Memory tab pins the page frame on desktop with independently scrolling tree/content panes; directory tree is collapsible with clear chevrons and a collapse-all/expand-all toggle (#222, #226)
- Memory edit mode's Reset button is now labeled Cancel — it exits editing and discards changes (#236)
- Assistant transcript ingestion now uses the JSONL pipeline for assistant messages, token usage, and turn-duration support; UserPromptSubmit/Stop hooks were restored and self-heal after upgrades (#147, #160)
- Claude model selector refreshed — Opus 4.8 and Haiku 4.5 with default aliases; Haiku hides the effort selector (#152, #153)
- Add-agent "Read key" field and hints renamed to "API key" — the field accepts any-scope key, and admin keys grant remote write; `read_api_key` API/config field unchanged (#238)
- Automatic weekly VACUUM threshold raised from 500 MB to 2 GB — typically grown databases now compact on their own; manual compaction is only needed beyond 2 GB (#249)

### Fixed
- Phantom "running tools" from out-of-order hook ingestion (post-before-pre race) with session-superseded sweep (#182)
- Custom model settings: Apply button, mobile layout, and cancel revert state (#177)
- Thinking state derived from structured feed signal instead of label sniffing — mascot and state badge stay consistent (#186)
- Own fleet wall's self tile updates live via local fleet broadcast instead of lagging behind remote polls (#188)
- i18n pack fetches survive transient failures (#208)
- Fable 5 pricing added so cost aggregates keep counting (#201)
- Sound cue loudness, scheduling consistency, and cross-page playback (#195–#200)
- Bell first-paint flash and rate-limit reset countdown regression (#202)
- Last tool-feed row's elapsed time right-aligns like the others (#233)
- Version reminder no longer suggests an older version as the upgrade target (#143)
- Fleet routing and single-agent polish — back-to-fleet control hidden in single-agent mode, reverse-proxied remote drill-down asset/API paths, stable mascot tint across SSE updates, tile alignment (#159, #161, #163, #184)
- Fleet wall switches to the live wall after the first agent is added to an empty fleet (#214)
- ← Fleet back button no longer stretches full width on the Memory tab (#241)
- Fleet manage modal status feedback auto-dismisses after 5s and clears on close instead of persisting forever (#242)
- Returning to a backgrounded tab refetches all data immediately — the page no longer paints a stale pre-freeze frame (e.g. an expired rate-limit window stuck at 100%) for 10–30s until the fallback timers fire (#247, #249)

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
