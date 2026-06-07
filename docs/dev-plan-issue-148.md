# Dev Plan: Tiered Metric Retention + DB Maintenance (#148)

## Summary

Reduce dashboard.db write volume by aggregating multi-row-per-cycle collectors into single summary rows, implement per-metric-category retention tiers, and add periodic VACUUM for disk reclamation. Currently 4.3 GB / 22M rows from 159 days of operation.

## Scope

**In scope (from issue decisions):**
- PM2 collector → single `pm2_summary` row + per-process latest-state upsert
- System collector → single `system_summary` row
- Statusline collector → single `statusline_summary` row (Claude runtime)
- Conversation/Codex rollout collectors → single `usage_event` row per turn
- Tiered retention per metric category (7d–90d depending on type)
- Periodic VACUUM in maintenance job
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
- [ ] **1.4** Add tiered retention delete methods to `store.js`:
  - `deleteMetricsByCategory(metricName, days)` — parameterized by metric name pattern
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
  - Use stable upsert key: `session_id + source + event_id` via `hasMetricEventId()` (already exists)
  - Remove individual metric inserts for `api_request_tokens`, `api_request_cost`, `cache_hit_rate`, `context_pct`, `rate_limit`, `rate_limit_7d`
  - Keep `ttft_ms` and `turn_duration_ms` as separate individual metrics (not aggregated)

### Phase 3: Dashboard + API updates

- [ ] **3.1** Update `/api/system` endpoint to read PM2 data from `pm2_latest_state` table (for current-state display) and `pm2_summary` metric (for trend data)
- [ ] **3.2** Update `metric-resolver.js` / `metric-aggregate.js` to resolve cost/cache/token aggregates from `usage_event` dimensions instead of individual metrics. Add fallback: check both new `usage_event` and old individual metric names for backwards compatibility during the transition window before old data ages out.
- [ ] **3.3** Update system metrics display to read from `system_summary` dimensions
- [ ] **3.4** Update statusline/capacity display to read from `statusline_summary` dimensions
- [ ] **3.5** Verify Trends tab charts (cost, cache, token series) work with `usage_event` source — update `aggregateCostSeries`, `aggregateTokenSeries`, `aggregateCacheRateSeries` queries if needed

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
  | OTEL | `source LIKE 'otel%'` | 30 days |
  | Other legacy | everything else older than 90 days | 90 days |
- [ ] **4.2** Add `store.vacuum()` method — runs `VACUUM` then `PRAGMA wal_checkpoint(TRUNCATE)` then `PRAGMA optimize`
- [ ] **4.3** Add weekly VACUUM to the maintenance job (check day of week, run once per week during cleanup cycle)
- [ ] **4.4** Delete otel data in first run (all otel_* rows are stale since May 17, can be removed immediately)

### Phase 5: Tests

- [ ] **5.1** Unit tests for `pm2-collector.js` refactored output — verify single `pm2_summary` row + per-process `pm2_latest_state` upserts
- [ ] **5.2** Unit tests for `system-collector.js` — verify single `system_summary` row
- [ ] **5.3** Unit tests for `statusline-collector.js` — verify single `statusline_summary` row
- [ ] **5.4** Unit tests for `usage_event` from conversation-collector — verify aggregated row with correct dimensions
- [ ] **5.5** Unit tests for `usage_event` from codex-rollout-collector — verify aggregated row with stable key dedup
- [ ] **5.6** Unit tests for tiered retention — verify each category gets its correct retention days
- [ ] **5.7** Unit tests for metric-resolver fallback — verify it can read from both `usage_event` and legacy individual metrics
- [ ] **5.8** Integration test: `npm run smoke:api` passes with new metric shapes

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
- [ ] **VACUUM is safe to run under normal load** — SQLite VACUUM acquires an exclusive lock. At dashboard scale (single process, low write rate), this completes in seconds even for a 4 GB database, and the only impact is briefly blocking the hourly metric inserts. Validated: single-writer process, no concurrent writer contention.
- [ ] **Codex `usage_event` dedup uses existing `hasMetricEventId()`** — the codex-rollout-collector already checks for duplicate event_ids before inserting. This mechanism works for `usage_event` rows as well.

## Acceptance Checklist

- [ ] PM2 collector writes single `pm2_summary` row per cycle (not 5×N individual rows)
- [ ] PM2 per-process current state available via `pm2_latest_state` table
- [ ] System collector writes single `system_summary` row per cycle (not 4-5 individual rows)
- [ ] Statusline collector writes single `statusline_summary` row per update (not 4-5 individual rows)
- [ ] Conversation collector writes single `usage_event` row per turn (not 3 individual rows)
- [ ] Codex rollout collector writes single `usage_event` row per position (not 6 individual rows)
- [ ] Codex `usage_event` uses stable upsert keys (no duplicates)
- [ ] Retention tiers implemented per the table above
- [ ] VACUUM runs weekly in the maintenance job
- [ ] Dashboard Overview tab: PM2 gauges, system stats, cost/cache display all work
- [ ] Dashboard Trends tab: cost, cache, token charts render correctly
- [ ] All existing tests pass (`npm test`)
- [ ] New tests cover aggregated collection and tiered retention
- [ ] `npm run smoke` and `npm run smoke:api` pass
- [ ] No regressions in existing features
- [ ] Old otel data cleaned up on first run
