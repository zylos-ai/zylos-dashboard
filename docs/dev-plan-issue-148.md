# Dev Plan: Tiered Metric Retention + DB Maintenance (#148)

## Summary

Reduce dashboard.db write volume by aggregating multi-row-per-cycle collectors into single summary rows, implement per-metric-category retention tiers, and add guarded VACUUM with manual compaction for large DBs. Currently 4.3 GB / 22M rows from 159 days of operation.

## Scope

**In scope (from issue decisions):**
- PM2 collector → single `pm2_summary` row + per-process latest-state upsert
- System collector → single `system_summary` row
- Statusline collector → single `statusline_summary` row (Claude runtime)
- Conversation/Codex rollout collectors → single `usage_event` row per turn
- Tiered retention per metric category (7d–90d depending on type)
- Guarded VACUUM (auto when DB < 500 MB) + manual compaction procedure for large DBs
- Dashboard panels updated to read aggregated metrics
- Codex rollout `usage_event` with stable upsert keys (per Jinglever's comment)

**Out of scope:**
- otel_* aggregation (low volume, not worth complexity — per issue)
- Codex `turn_duration`/`ttft` aggregation (tiny volume — per Jinglever's comment)
- Data migration of existing 22M rows (clean via retention + VACUUM, don't backfill summaries)

## Development Checklist

### Phase 1: Store layer + schema migration

- [ ] **1.1** Add schema migration (v10): create `pm2_latest_state` table
  ```sql
  CREATE TABLE IF NOT EXISTS pm2_latest_state (
    process_name TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    cpu REAL NOT NULL DEFAULT 0,
    memory_bytes INTEGER NOT NULL DEFAULT 0,
    restarts INTEGER NOT NULL DEFAULT 0,
    uptime_ms INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  ```
- [ ] **1.2** Add `store.upsertPm2State(processName, {status, cpu, memory, restarts, uptime})` method — `INSERT OR REPLACE` into `pm2_latest_state`
- [ ] **1.3** Add `store.getAllPm2State()` method — returns all rows from `pm2_latest_state`
- [ ] **1.4** Add schema migration (v10 cont.): create unique index for Codex `usage_event` dedup
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_event_dedup
    ON metric_points(session_id, source, metric_name, json_extract(dimensions, '$.event_id'))
    WHERE metric_name = 'usage_event' AND json_extract(dimensions, '$.event_id') IS NOT NULL;
  ```
  This guarantees atomic dedup via `INSERT OR IGNORE` — no SELECT preflight race.
- [ ] **1.5** Add tiered retention delete methods to `store.js`:
  - `deleteMetricsByNameAndSource(metricNamePattern, sourcePattern, days)` — compound predicate using both `metric_name` and `source` columns. OTEL cleanup uses `source LIKE 'otel%'` to avoid hitting statusline/jsonl metrics with the same metric_name (e.g. `cache_hit_rate` exists in both otel and statusline sources).
  - The hourly cleanup job will call these with the per-category retention values

### Phase 2: Collector refactoring

- [ ] **2.1** Refactor `pm2-collector.js`:
  - Write one `pm2_summary` row per collect cycle (metric_value = process_count, dimensions = {total_memory_mb, total_cpu_pct, total_restarts, online, stopped, errored})
  - Call `store.upsertPm2State()` for each process (latest-state upsert)
  - Remove the 5 individual metric inserts per process
- [ ] **2.2** Refactor `system-collector.js`:
  - Write one `system_summary` row per collect cycle (metric_value = cpu_pct, dimensions = {cpu_pct, mem_used_mb, mem_total_mb, mem_used_pct, disk_used_pct, disk_free_gb})
  - Remove the 4-5 individual metric inserts
- [ ] **2.3** Refactor `statusline-collector.js`:
  - Write one `statusline_summary` row per update (metric_value = 0, dimensions = {session_cost, rate_limit, rate_limit_7d, context_pct, cache_hit_rate})
  - Remove individual metric inserts
- [ ] **2.4** Refactor `conversation-collector.js`:
  - Write one `usage_event` row per turn (metric_value = total input tokens, dimensions = {input_tokens, output_tokens, cache_read, cache_creation, cost, cache_hit_rate, model, speed, uuid, projects})
  - Remove individual `api_request_tokens`, `api_request_cost`, `cache_hit_rate` inserts
- [ ] **2.5** Refactor `codex-rollout-collector.js`:
  - Write one `usage_event` row per rollout position (metric_value = total_input, dimensions = {input, output, reasoning, cache_read, cache_creation, cost, cache_hit_rate, context_pct, rate_limit, rate_limit_7d, model, service_tier, event_id})
  - Use atomic dedup via the unique index from 1.4: `INSERT OR IGNORE` with `session_id + source + dimensions.event_id`. The aggregate identity key is the original `token_count` event_id from the rollout transcript (all 6 child metrics share the same position). Do NOT reuse `hasMetricEventId()` SELECT preflight — it's not atomic.
  - Remove individual metric inserts for `api_request_tokens`, `api_request_cost`, `cache_hit_rate`, `context_pct`, `rate_limit`, `rate_limit_7d`
  - Keep `ttft_ms` and `turn_duration_ms` as separate individual metrics (not aggregated)

### Phase 3: Dashboard + API updates

- [ ] **3.1** Update `/api/system` endpoint to read PM2 data from `pm2_latest_state` table (for current-state display) and `pm2_summary` metric (for trend data)
- [ ] **3.2** Update `metric-resolver.js` to resolve ALL summary-based metrics with legacy fallback:
  - Cost/cache/token aggregates: read from `usage_event` dimensions, fallback to individual `api_request_cost` / `api_request_tokens` / `cache_hit_rate`
  - Capacity metrics: `resolve('context_pct')`, `resolve('rate_limit')`, `resolve('session_cost')`, `resolve('cache_hit_rate')` must check `statusline_summary` dimensions first, then fall back to individual metric names
  - System metrics: `resolve('cpu_pct')`, `resolve('mem_used_bytes')`, etc. must check `system_summary` dimensions first, then fall back to individual metric names
  - PM2 metrics: `/api/system` current-state reads from `pm2_latest_state` table (DB-backed, not just collector memory cache), trend reads from `pm2_summary`
  - All fallback paths must work during the transition window when the DB contains a mix of old individual rows and new summary rows
- [ ] **3.3** Update `metric-aggregate.js` (`aggregateCost`, `aggregateTokens`, `aggregateCacheRate`, `aggregateCostSeries`, `aggregateTokenSeries`, `aggregateCacheRateSeries`) to query `usage_event` with dimension extraction, with fallback to legacy individual metrics
- [ ] **3.4** Verify Overview tab reads: PM2 gauges from `pm2_latest_state`, system stats from `system_summary`, capacity from `statusline_summary`, cost from `usage_event` — all with fallback
- [ ] **3.5** Verify Trends tab charts (cost, cache, token series) work with `usage_event` source
- [ ] **3.6** Ensure collector warmup still works — `/api/system` currently reads from in-memory collector cache for real-time data; keep this for real-time, use `pm2_latest_state` as the persistent backing store that survives restarts

### Phase 4: Retention + maintenance

- [ ] **4.1** Update hourly cleanup job in `index.js` to use tiered retention:
  | Category | Metric patterns | Retention |
  |----------|----------------|-----------|
  | Usage/Cost | `usage_event` | 90 days |
  | Latency | `ttft%`, `turn_duration%` | 90 days |
  | Statusline | `statusline_summary` | 30 days |
  | System | `system_summary` | 14 days |
  | PM2 | `pm2_summary` | 7 days |
  | PM2 legacy | `pm2_%` (old individual metrics) | 7 days (existing) |
  | OTEL | `source LIKE 'otel%'` (any metric_name) | 30 days |
  | Other legacy | everything else older than 90 days | 90 days |
  Note: OTEL retention uses `source` column, not `metric_name`, to avoid deleting non-OTEL metrics with the same name (e.g. `cache_hit_rate` exists in both `otel_token_usage` and `statusline` sources).
- [ ] **4.2** Add `store.vacuum()` method — runs `VACUUM` then `PRAGMA wal_checkpoint(TRUNCATE)` then `PRAGMA optimize`. Add `store.dbSizeBytes()` helper to check current file size.
- [ ] **4.3** VACUUM strategy — NOT auto-weekly on large DBs. Instead:
  - Add a `vacuumIfSmall()` guard: only auto-VACUUM if DB is under 500 MB (post-retention-cleanup, the DB should be well under this). Log a warning if DB is over 500 MB and skip auto-VACUUM.
  - For the current 4.3 GB DB: document a manual compaction procedure (stop dashboard → run VACUUM from CLI → restart). This is a one-time operation after retention cleanup removes the bulk of old data.
  - Once the DB is compacted and ongoing writes stay small (thanks to aggregation), the auto `vacuumIfSmall()` in the weekly maintenance cycle will keep it compact.
- [ ] **4.4** One-time otel cleanup: delete all rows with `source LIKE 'otel%'` (stale since May 17). Run via schema migration v10 with an idempotent check (only delete if otel rows exist), not on every startup.

### Phase 5: Tests

- [ ] **5.1** Unit tests for `pm2-collector.js` refactored output — verify single `pm2_summary` row + per-process `pm2_latest_state` upserts
- [ ] **5.2** Unit tests for `system-collector.js` — verify single `system_summary` row
- [ ] **5.3** Unit tests for `statusline-collector.js` — verify single `statusline_summary` row
- [ ] **5.4** Unit tests for `usage_event` from conversation-collector — verify aggregated row with correct dimensions
- [ ] **5.5** Unit tests for `usage_event` from codex-rollout-collector — verify aggregated row with correct dimensions, AND verify duplicate replay is rejected by unique index (INSERT OR IGNORE)
- [ ] **5.6** Unit tests for tiered retention — verify each category gets its correct retention days AND verify source-based OTEL retention only deletes otel-sourced rows (not statusline/jsonl with same metric_name)
- [ ] **5.7** Unit tests for metric-resolver fallback — verify resolution of ALL affected metrics from both new summary and legacy individual forms: `context_pct`, `rate_limit`, `session_cost`, `cache_hit_rate` (from `statusline_summary`), `cpu_pct`, `mem_used_bytes` (from `system_summary`), cost/tokens (from `usage_event`)
- [ ] **5.8** Unit tests for `/api/system` endpoint — verify it reads PM2 current state from `pm2_latest_state` table
- [ ] **5.9** Unit tests for VACUUM guard — verify `vacuumIfSmall()` skips when DB > 500 MB
- [ ] **5.10** Integration test: `npm run smoke:api` passes with new metric shapes

## Test Checklist

- [ ] `npm run check` — syntax check passes
- [ ] `npm test` — all unit tests pass
- [ ] `npm run smoke` — server starts and health check passes
- [ ] `npm run smoke:api` — API endpoints return valid data
- [ ] Manual: start dashboard, verify Overview tab shows PM2/system/cost data correctly
- [ ] Manual: verify Trends tab charts render with new metric shapes
- [ ] Manual: verify after retention cleanup, old data is removed per tier

## Assumptions

- [ ] **`pm2 jlist` output is stable** — the JSON structure with `pm2_env.status`, `monit.cpu`, `monit.memory` fields is guaranteed by PM2. Validated: this is the PM2 programmatic API, stable across versions.
- [ ] **Existing dashboard panels read metrics by name** — changing metric names from `pm2_cpu` to `pm2_summary` requires updating all query paths. Validated: `metric-resolver.js` and `metric-aggregate.js` are the central resolution points.
- [ ] **Old data will age out naturally** — no need to backfill summary rows for historical data. Old individual metrics will be deleted by the retention job within their tier window. During the transition window, the metric resolver must handle both old and new metric names.
- [ ] **VACUUM on large DBs is NOT automatic** — VACUUM on a 4.3 GB database may take minutes and hold an exclusive lock. Auto-VACUUM only runs when DB < 500 MB. The current bloated DB requires a one-time manual compaction after retention cleanup reduces the data volume. After compaction, ongoing aggregated writes keep the DB small enough for auto-VACUUM.
- [ ] **Codex `usage_event` dedup uses a unique index, not SELECT preflight** — the existing `hasMetricEventId()` is a non-atomic SELECT check. The new approach uses a unique index on `(session_id, source, metric_name, dimensions.event_id)` with `INSERT OR IGNORE` for atomic dedup. The aggregate identity key is the `token_count` event_id from the rollout transcript.
- [ ] **`pm2_latest_state` is single-host** — the table uses `process_name` as PK without runtime/host dimension. This is correct because PM2 processes are machine-level (the same process list regardless of whether Claude or Codex runtime is active). Dashboard.db is per-host, single-agent. If multi-host support is ever needed, the PK would need to include a host dimension — but that's out of scope.

## Acceptance Checklist

- [ ] PM2 collector writes single `pm2_summary` row per cycle (not 5×N individual rows)
- [ ] PM2 per-process current state available via `pm2_latest_state` table
- [ ] System collector writes single `system_summary` row per cycle (not 4-5 individual rows)
- [ ] Statusline collector writes single `statusline_summary` row per update (not 4-5 individual rows)
- [ ] Conversation collector writes single `usage_event` row per turn (not 3 individual rows)
- [ ] Codex rollout collector writes single `usage_event` row per position (not 6 individual rows)
- [ ] Codex `usage_event` uses stable upsert keys (no duplicates)
- [ ] Retention tiers implemented per the table above
- [ ] VACUUM runs automatically when DB < 500 MB; manual compaction documented for bloated DBs
- [ ] Dashboard Overview tab: PM2 gauges, system stats, cost/cache display all work
- [ ] Dashboard Trends tab: cost, cache, token charts render correctly
- [ ] All existing tests pass (`npm test`)
- [ ] New tests cover aggregated collection and tiered retention
- [ ] `npm run smoke` and `npm run smoke:api` pass
- [ ] No regressions in existing features
- [ ] Old otel data cleaned up on first run
