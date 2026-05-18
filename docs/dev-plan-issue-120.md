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
- [ ] **index.js**: Replace `systemCollector.collect()` in startup with `await systemCollector.warmup()`
- [ ] **public/js/app.js**: Extract CPU display resolution to pure function `resolveCpuDisplay(rawVal, lastGood)` — returns `{ display, lastGood }`. Use `state.lastCpuPct` to track. Only update display when value is finite; keep previous value otherwise. Show '--' only when no historical value exists.

## Test Checklist

- [ ] Unit: `SystemCollector.warmup()` produces `cpu_pct` in cache after completion
- [ ] Unit: `SystemCollector.collect()` single call still has no `cpu_pct` (regression guard)
- [ ] Unit: `resolveCpuDisplay(42, null)` → `{ display: '42%', lastGood: 42 }`
- [ ] Unit: `resolveCpuDisplay(undefined, 42)` → `{ display: '42%', lastGood: 42 }` (keeps last-good)
- [ ] Unit: `resolveCpuDisplay(NaN, 42)` → `{ display: '42%', lastGood: 42 }` (keeps last-good)
- [ ] Unit: `resolveCpuDisplay(undefined, null)` → `{ display: '--', lastGood: null }` (no history)
- [ ] Manual: restart dashboard, immediately `curl /api/system` — response contains finite `cpu_pct`
- [ ] Manual: restart dashboard, load page immediately — CPU gauge shows `N%` not '--'
- [ ] `npm test` passes

## Acceptance Checklist

- [ ] Dashboard restart → immediately open page: CPU text matches `[0-9]+%`, not '--'
- [ ] `/api/system` initial response contains finite numeric `cpu_pct`
- [ ] Memory and Disk gauges still work correctly (no regression)
- [ ] When a subsequent system payload lacks `cpu_pct`, CPU gauge retains last valid percentage
- [ ] No regressions: `npm test` passes
