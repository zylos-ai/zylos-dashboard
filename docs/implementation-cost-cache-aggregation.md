# Cost & Cache Metrics Aggregation

## Problem

OTel emits per-request metrics (cost per API call, cache hit rate per request). The current resolver picks the latest value regardless of granularity, so a single $0.07 request shows as "Cost" and a single uncached request shows 0% cache hit rate — overriding meaningful session-level data.

## Requirements

### Overview Panel — Three Time Dimensions

| Metric | Session | Today | 7 Day |
|--------|---------|-------|-------|
| Cost | Current session cumulative | Today local-day sum | Last 7 local-days sum |
| Cache Hit Rate | Current session weighted avg | Today local-day weighted avg | 7 local-day weighted avg |

"Today" and "7 days" use timezone-local day boundaries (TZ from .env, e.g. Asia/Singapore). DB stores UTC; day boundaries are computed by converting local midnight to UTC.

"Weighted avg" for cache = SUM(cache_read_tokens) / SUM(input_tokens + cache_creation_tokens + cache_read_tokens) across the period, not average of per-request percentages.

### Analytics Tab (Data Layer Only — UI Deferred)

- Time-series query for cost and cache over selectable ranges (1d, 7d, 30d, custom)
- Minimum granularity: 1 hour
- Returns: series of data points + period total/average
- DB stores UTC; API accepts `tz` parameter (default from `TZ` in .env, e.g. `Asia/Singapore`) for timezone-local day-boundary alignment

## Current Data Sources

### OTel (per-request)

| Metric | metric_name | Source | Value | session_id |
|--------|------------|--------|-------|------------|
| Per-request cost | `session_cost` | `otel_cost_sum` | Single request USD (e.g. $0.07) | NULL |
| Cumulative cost counter | `daily_cost` | `otel_cost_sum` | OTel sum metric, multiple data points per export | NULL |
| Per-request cache rate | `cache_hit_rate` | `otel_token_usage` | cache_read / total_input for one request | NULL |

Problem: OTel data has `session_id = NULL` — cannot aggregate per-session from OTel alone. Solution: at ingest time, stamp OTel data with the current active session_id from StateEngine (see §1).

### Statusline (session-level cumulative)

| Metric | metric_name | Source | Value | session_id |
|--------|------------|--------|-------|------------|
| Session total cost | `session_cost` | `statusline` | Cumulative USD (e.g. $124.23) | Set |
| Session cache rate | `cache_hit_rate` | `statusline_current_usage` | Cumulative ratio | Set |

Problem: Statusline `session_cost` is cumulative across ALL sessions (total spend), not per-session delta.

### OTel Token Counts (for accurate cache aggregation)

The OTel `_processLlmSpan` extracts `input_tokens`, `cache_read_tokens`, `cache_creation_tokens` per request. Currently only the derived ratio is stored. To compute weighted averages over time periods, we need the raw token counts.

## Design

### 1. Store Raw Per-Request Data from OTel

Two separate raw metrics, matching the two OTel signal paths that already exist:

**From `_processLlmSpan` (trace spans) — token counts:**

```
metric_name: 'api_request_tokens'
metric_value: <input_tokens + cache_creation_tokens + cache_read_tokens>   (total input denominator)
dimensions: { cache_read: N, cache_creation: N, input: N, output: N }
source: 'otel_llm_span'
session_id: <active session_id from StateEngine, or NULL if unknown>
```

**From `_processApiRequestLog` (log records) — cost:**

```
metric_name: 'api_request_cost'
metric_value: <cost_usd>
dimensions: { model: "..." }
source: 'otel_api_log'
session_id: <active session_id from StateEngine, or NULL if unknown>
```

No span-to-log correlation needed — cost and tokens are stored independently and aggregated separately. Cost aggregation uses `api_request_cost`; cache aggregation uses `api_request_tokens`.

**Session ID binding:** When OTel data arrives at the ingest endpoint, the handler reads the current session_id and stamps it onto each metric. Source: add a public `StateEngine.getCurrentSessionId()` method that returns `this._state.mainSessionId || this._currentSessionId()` (prefers event-derived session, falls back to env var). If no session is known, `session_id` remains NULL — data is still usable for today/7d aggregation (timestamp-based), but session-level aggregation falls back to statusline.

### 2. Aggregation Queries in Store

New `Store` methods:

```js
aggregateCost({ since, until, sessionId? })
// SUM(metric_value) FROM metric_points WHERE metric_name = 'api_request_cost'
//   AND timestamp BETWEEN since AND until
//   [AND session_id = sessionId]  -- only if sessionId provided

aggregateCacheRate({ since, until, sessionId? })
// SUM(dimensions.cache_read) / SUM(metric_value) FROM metric_points
//   WHERE metric_name = 'api_request_tokens' ...
// metric_value is total input denominator (input + cache_creation + cache_read)

aggregateCostSeries({ since, until, bucketSeconds })
// [{bucket_start, cost_sum}] — for time-series chart
// bucketSeconds: 3600 for hourly, 86400 for daily

aggregateCacheRateSeries({ since, until, bucketSeconds })
// [{bucket_start, cache_read_sum, total_input_sum, rate}]
```

Session-level: pass `sessionId` from current StateEngine session. If no OTel data has that session_id (e.g. session just started, or OTel binding failed), return `null` — caller falls back to statusline cumulative.

Today/7d: filter by timestamp range only (no session_id filter), so all OTel data contributes regardless of session binding status.

### 3. Time Boundaries

Day boundaries depend on timezone. API approach:

- DB stores all timestamps in UTC (no change)
- New helper: `dayBoundariesUTC(tz, daysBack)` — given a timezone string, compute today's start/end in UTC
- TZ default read from `process.env.TZ` or config, overridable per request via `?tz=` query param

Example: TZ=Asia/Singapore, "today" = 2026-05-12 00:00 SGT = 2026-05-11T16:00:00Z

### 4. Resolver Chain Fix

For overview display, change the resolver to use aggregation results instead of latest-value lookup:

```
session_cost:
  1. aggregateCost({ sessionId: currentSessionId })  — sum of per-request costs for current session
     Returns null if no OTel data bound to this session yet.
  2. statusline session_cost (fallback) — note: this is total lifetime, not per-session.
     Display with a "(lifetime)" qualifier so the user knows the semantics differ.

cache_hit_rate:
  1. aggregateCacheRate({ sessionId: currentSessionId }) — weighted average for current session
     Returns null if no OTel data bound to this session yet.
  2. statusline cache_hit_rate (fallback) — cumulative session ratio
```

`currentSessionId` comes from `stateEngine.getCurrentSessionId()` — new public method returning `this._state.mainSessionId || this._currentSessionId()`.

### 5. New API Endpoints

```
GET /api/metrics/aggregate?metric=cost&period=session|today|7d&tz=Asia/Singapore
Response: { value, period, since, until, source: 'aggregated' }

GET /api/metrics/series?metric=cost&since=...&until=...&bucket=3600&tz=Asia/Singapore
Response: { points: [{t, v}], total, period }
```

### 6. Frontend Changes — Overview Panel

Current layout:
```
Cost          Cache Hit Rate
$0.0667       0%
OpenTelemetry OpenTelemetry
```

New layout:
```
Cost                          Cache Hit Rate
$12.34  session               97.2%  session
$45.67  today                 95.1%  today
$234.56 7 days                93.8%  7 days
```

Three rows per metric, each with a small time-dimension label. The first row (session) uses the progress bar style matching other metrics; the lower two are compact text-only.

### 7. DB Migration (v5)

No schema migration needed for the table — `metric_points` is unchanged. The new `api_request_tokens` and `api_request_cost` metrics use the existing table with new `metric_name` and `dimensions` values.

Index: `idx_metrics_name_ts ON metric_points(metric_name, timestamp)` already exists. For session-filtered aggregation, add a composite index:

```sql
CREATE INDEX IF NOT EXISTS idx_metric_points_name_session_ts
ON metric_points (metric_name, session_id, timestamp);
```

This covers session-filtered queries (`WHERE metric_name = ? AND session_id = ? AND timestamp BETWEEN ...`). Timestamp-only aggregation (today/7d without session filter) reuses the existing `idx_metrics_name_ts(metric_name, timestamp)` index. Added as part of Store step (§2), both query shapes validated with EXPLAIN QUERY PLAN before proceeding to API/frontend.

### 8. Data Retention

Current retention config applies. With hourly granularity and per-request storage, a 30-day window at ~100 requests/hour = ~72K rows for api_request_tokens. Acceptable.

## Implementation Sequence

1. **OTel collector**: add `api_request_tokens` (from `_processLlmSpan`) and `api_request_cost` (from `_processApiRequestLog`) raw metrics; bind active session_id from StateEngine at ingest time
2. **Store + Index**: add composite index `(metric_name, session_id, timestamp)`, add aggregation query methods + `dayBoundariesUTC(tz, daysBack)` helper; validate query plans with EXPLAIN QUERY PLAN against real data
3. **API**: add `/api/metrics/aggregate` and `/api/metrics/series` endpoints
4. **Resolver**: fix session_cost and cache_hit_rate to use aggregated values, with statusline fallback
5. **Frontend**: update overview panel to show 3 time dimensions

Verify after each step — the aggregation queries can be validated against raw data before the frontend change.
