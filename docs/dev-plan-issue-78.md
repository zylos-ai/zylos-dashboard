# Dev Plan: JSONL Usage Extraction + OTEL Retirement (#78)

## Summary

Replace OTEL as the primary token/cost data source with JSONL parsing in the conversation collector. Add a model price table to config.json for cost calculation. Retire the OTEL collector entirely.

## Scope

**In scope (from issue decisions):**
- Extract 5 fields from JSONL: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `model`
- Add model price table to config.json
- Calculate cost per API request using price table
- Write `api_request_tokens` and `api_request_cost` metric points (same format OTEL used)
- Retire OTEL collector (remove code, endpoint, references)
- Update metric-resolver chains to reference new source
- Only collect from main session (no multi-session)

**Out of scope:**
- Task 1 (Cost card layout changes — cancelled)
- Task 3 (Directory-level monitoring / multi-session — deferred)
- Subagent JSONL collection (future)
- Ephemeral cache breakdown, service_tier, thinking blocks, conversation tree

## Architecture

```
JSONL file (session)
   │ poll every 5s (conversation-collector.js)
   ▼
Parse assistant messages → extract usage + model
   │
   ├─► metric_points: api_request_tokens (input, output, cache_read, cache_creation)
   ├─► metric_points: api_request_cost (USD, calculated from price table)
   └─► metric_points: cache_hit_rate (derived from tokens)

config.json
   └─► modelPrices: { "claude-opus-4-6": { input: X, output: Y, cacheRead: Z, cacheCreation: W }, ... }
```

## Development Checklist

- [ ] 1. Add model price table to config defaults (config.js) with current Claude pricing
- [ ] 2. Extend ConversationCollector to extract usage fields from assistant messages
- [ ] 3. Calculate cost per request: (input_tokens * price.input + output * price.output + cache_read * price.cacheRead + cache_creation * price.cacheCreation)
- [ ] 4. Write metric_points: `api_request_tokens` with dimensions {input, output, cache_read, cache_creation}
- [ ] 5. Write metric_points: `api_request_cost` with dimensions {model}
- [ ] 6. Write metric_points: `cache_hit_rate` derived from token counts
- [ ] 7. Update metric-resolver METRIC_CHAINS: replace `otel_cost_sum` and `otel_token_usage` sources with new `jsonl_usage` source
- [ ] 8. Remove OTEL collector: delete otel-collector.js, remove from index.js imports/wiring, remove /v1/traces|logs|metrics endpoints
- [ ] 9. Update source_health reporting: conversation collector reports for usage metrics
- [ ] 10. Update store.aggregateCost/aggregateCacheRate/aggregateTokens — they query by metric_name which stays the same, so these should work as-is (verify)

## Test Checklist

- [ ] Unit test: price calculation correctness for each model
- [ ] Unit test: JSONL parsing extracts correct fields from real sample data
- [ ] Unit test: handles missing usage fields gracefully (no crash)
- [ ] Unit test: deduplication — same uuid not double-counted for tokens
- [ ] Integration test: conversation collector writes metric_points to store
- [ ] Integration test: metric-resolver returns cost/tokens from new source
- [ ] Regression: existing assistant_message events still collected (text content)
- [ ] Regression: hook-ingest still works (unrelated to this change)
- [ ] Regression: statusline collector still works
- [ ] Manual: start dashboard, verify Cost card shows data from JSONL
- [ ] Manual: verify Trends chart populates with token/cost series
- [ ] Manual: verify no errors in dashboard logs about OTEL

## Acceptance Checklist

- [ ] Cost card (session/today/7d) shows real data from JSONL source
- [ ] Cache hit rate displays correctly
- [ ] Trends chart shows token and cost time series
- [ ] No OTEL-related code remains in codebase
- [ ] No /v1/traces, /v1/logs, /v1/metrics endpoints respond
- [ ] `npm test` passes
- [ ] No lint errors
- [ ] Dashboard starts cleanly with no OTEL warnings
- [ ] Browser screenshot: Cost card with live data
- [ ] Browser screenshot: Trends chart with data points
