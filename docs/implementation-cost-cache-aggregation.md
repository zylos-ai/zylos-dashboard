# Cost & Cache Metrics Aggregation

## Problem

OTel emits per-request metrics (cost per API call, cache hit rate per request). The current resolver picks the latest value regardless of granularity, so a single $0.07 request shows as "Cost" and a single uncached request shows 0% cache hit rate — overriding meaningful session-level data.

## Requirements

### Overview Panel — Three Time Dimensions

| Metric | Session | Today | 7 Day |
|--------|---------|-------|-------|
| Cost | Current session cumulative | Today UTC-day sum | Last 7 UTC-days sum |
| Cache Hit Rate | Current session weighted avg | Today weighted avg | 7-day weighted avg |

"Weighted avg" for cache = total cache_read_tokens / total input_tokens across the period, not average of per-request percentages.

### Analytics Tab (Data Layer Only — UI Deferred)

- Time-series query for cost and cache over selectable ranges (1d, 7d, 30d, custom)
- Minimum granularity: 1 hour
- Returns: series of data points + period total/average
- DB stores UTC; API accepts `tz` parameter (default from `TZ` in .env) for day-boundary alignment

## Current Data Sources

### OTel (per-request)

| Metric | metric_name | Source | Value | session_id |
|--------|------------|--------|-------|------------|
| Per-request cost | `session_cost` | `otel_cost_sum` | Single request USD (e.g. $0.07) | NULL |
| Cumulative cost counter | `daily_cost` | `otel_cost_sum` | OTel sum metric, multiple data points per export | NULL |
| Per-request cache rate | `cache_hit_rate` | `otel_token_usage` | cache_read / total_input for one request | NULL |

Problem: OTel data has `session_id = NULL` — cannot aggregate per-session from OTel alone.

### Statusline (session-level cumulative)

| Metric | metric_name | Source | Value | session_id |
|--------|------------|--------|-------|------------|
| Session total cost | `session_cost` | `statusline` | Cumulative USD (e.g. $124.23) | Set |
| Session cache rate | `cache_hit_rate` | `statusline_current_usage` | Cumulative ratio | Set |

Problem: Statusline `session_cost` is cumulative across ALL sessions (total spend), not per-session delta.

### OTel Token Counts (for accurate cache aggregation)

The OTel `_processLlmSpan` extracts `input_tokens`, `cache_read_tokens`, `cache_creation_tokens` per request. Currently only the derived ratio is stored. To compute weighted averages over time periods, we need the raw token counts.

## Design

### 1. Store Raw Token Counts from OTel

Add to `_processLlmSpan`: store `input_tokens`, `cache_read_tokens`, `cache_creation_tokens` as separate metric_points (or a single metric with dimensions). This enables accurate weighted-average cache hit rate over any time window.

New metrics from OTel LLM spans:

```
metric_name: 'api_request_tokens'
metric_value: <total_input_tokens>
dimensions: { cache_read: N, cache_creation: N, output: N, cost_usd: N }
source: 'otel_llm_span'
```

One row per API request, carrying all token counts + cost. Enables both cost summation and cache ratio computation over any time window.

### 2. Aggregation Queries in Store

New `Store` methods:

```js
aggregateCost(since, until)
// Returns: SUM of cost_usd from api_request_tokens dimensions
// Params: ISO timestamps (UTC)

aggregateCacheRate(since, until)
// Returns: SUM(cache_read) / SUM(total_input) from api_request_tokens
// Params: ISO timestamps (UTC)

aggregateCostSeries(since, until, bucketSeconds)
// Returns: [{bucket_start, cost_sum}] for time-series chart
// bucketSeconds: 3600 for hourly, 86400 for daily

aggregateCacheRateSeries(since, until, bucketSeconds)
// Returns: [{bucket_start, cache_read_sum, total_input_sum, rate}]
```

Session-level aggregation: filter by `session_id` (from current statusline session). For "today" and "7d", filter by timestamp range.

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
  1. aggregateCost(session_start, now)  — sum of per-request costs for current session
  2. statusline session_cost (fallback) — but note: this is total lifetime, not per-session

cache_hit_rate:
  1. aggregateCacheRate(session_start, now) — weighted average for current session
  2. statusline cache_hit_rate (fallback)
```

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

No schema migration needed — `metric_points` table is unchanged. The new `api_request_tokens` metric uses the existing table with new `metric_name` and `dimensions` values.

Consider adding an index for time-range aggregation:

```sql
CREATE INDEX IF NOT EXISTS idx_metric_points_name_ts 
ON metric_points (metric_name, timestamp);
```

### 8. Data Retention

Current retention config applies. With hourly granularity and per-request storage, a 30-day window at ~100 requests/hour = ~72K rows for api_request_tokens. Acceptable.

## Implementation Sequence

1. **OTel collector**: add `api_request_tokens` metric with token counts + cost per LLM span
2. **Store**: add aggregation query methods + time-boundary helper
3. **API**: add `/api/metrics/aggregate` and `/api/metrics/series` endpoints
4. **Resolver**: fix session_cost and cache_hit_rate to use aggregated values
5. **Frontend**: update overview panel to show 3 time dimensions
6. **Index**: add composite index for query performance

Verify after each step — the aggregation queries can be validated against raw data before the frontend change.
