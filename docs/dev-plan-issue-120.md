# Dev Plan: CPU gauge shows '--' during startup warm-up window (#120)

## Summary

CPU gauge displays '--' for the first ~30s after dashboard startup because CPU percentage needs two samples (delta). Add a warmup method that collects two samples at startup, and add a frontend fallback to retain the last valid CPU value.

## Scope

**In scope:**
- Backend: `SystemCollector.warmup()` — two quick CPU samples with ~200ms gap at startup
- Frontend: retain last valid CPU value, don't overwrite with '--' on transient missing data

**Out of scope:**
- SSE `system_update` broadcast (separate enhancement noted in issue)

## Development Checklist

- [ ] **system-collector.js**: Add `async warmup()` method — calls `collect()`, waits 200ms, calls `collect()` again. Second call produces `cpu_pct` since `_prevCpuTimes` is now set.
- [ ] **index.js**: Replace `systemCollector.collect()` in startup with `systemCollector.warmup()`
- [ ] **public/js/app.js**: Track `state.lastCpuPct`. On CPU render, only update display when value is finite; keep previous value otherwise. Show '--' only when no historical value exists.

## Test Checklist

- [ ] Unit: `SystemCollector.warmup()` produces `cpu_pct` in cache after completion
- [ ] Unit: `SystemCollector.collect()` single call still has no `cpu_pct` (existing behavior, regression guard)
- [ ] Manual: restart dashboard, load page immediately — CPU gauge shows a number, not '--'
- [ ] `npm test` passes

## Acceptance Checklist

- [ ] CPU gauge shows a valid percentage immediately after dashboard restart (browser screenshot)
- [ ] Memory and Disk gauges still work correctly (no regression)
- [ ] No regressions: `npm test` passes
