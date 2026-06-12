# Dev Plan: Fleet wall — first-class support for slow/high-latency members (#263)

## Summary

The fleet wall currently collapses every link problem into a binary: a member is either fine or `unreachable` (8s timeout cliff). The 2026-06-12 zylos0t investigation showed three distinct situations that all need different operator responses — a slow link (CF detour, 1.7–2.0s), a dead dashboard (event-loop wedge), and a broken payload (Caddy vhost empty-200) — and today the wall renders all of them the same way. This change measures per-member link latency, derives a link-quality level, and surfaces granular failure reasons, so "his machine is struggling", "the link is slow", and "actually unreachable" are visually distinct.

## Scope

**In scope**
1. FleetPoller measures per-member link latency via a dedicated low-frequency health probe (see decision 3a) — uniform across members regardless of SSE state.
2. Fleet payload carries `link`: latency, quality level, failure reason.
3. Tile UI: latency badge + degraded styling for slow/stale links; tooltip with specific failure reason.
4. Failure-reason granularity in the poller: `timeout` / `conn_refused` / `bad_payload` / `auth_failed` / `version_unsupported` / `unreachable` (fallback).

**Out of scope**
- No changes to the remote read API or SSE relay protocol.
- No alerting/notification on degradation (display only).
- No changes to `event_loop` health-field consumption (pairs with this feature but ships separately).
- Detail-page latency history charts (future; this ships current + rolling window only).

## Design decisions (pre-made, do not re-open)

1. **`state` enum is untouched.** `state` reports the *remote agent's* condition (IDLE/BUSY/OFFLINE…). Link quality is a property of *our path to it* and lives in a new additive `link` object on the fleet record. Existing consumers that read `state`/`health_reason` keep working unchanged (additive-only payload, same compat rule zylos0t verified for #262).
2. **Record shape** (additive fields, all nullable, passed through `sanitizeRecord`):
   ```
   link: {
     latency_ms,          // last successful state-fetch duration
     latency_p95_ms,      // p95 over the rolling window (last 20 samples)
     sampled_at,          // ISO time of last sample
     quality,             // 'ok' | 'slow' | 'stale' | 'down'
     reason               // null when ok/slow; specific failure reason otherwise
   }
   ```
   `health_reason` keeps its current values for back-compat but now receives the granular reason on failure.

3a. **Latency sampling = dedicated health probe, NOT state-poll timing.** Plan-review finding (Jinglever P1): the poller's periodic state polls do not run on the healthy-SSE path (`start()` → one `pollOnce()` → SSE takes over; `_scheduleNext()` only runs in fallback), so a "slow but healthy, SSE-pushing" member — exactly the zylos0t case this feature exists for — would never fill the sample window. Additionally, timing mixed endpoints would blend different payload weights (`/api/state` ≈ 0.65s vs `/api/health` ≈ 0.12s on the same link, measured 2026-06-12). Therefore:
   - A dedicated probe GETs `<base_url>/api/health` with the member's read API key every `fleet.latency_probe_interval_ms` (default **30s**), independent of SSE/poll state, per member, with the existing `fleet.timeout_ms`.
   - Latency samples come **only** from this probe — one uniform metric ("health-endpoint RTT") for every member on every path.
   - Probe failures also feed failure classification (a probe timeout on an SSE-healthy member does NOT mark the member `down` — SSE data flow wins for liveness; it only affects `link.quality`/`link.reason`).
   - Detection latency consequence (documented, accepted): 5-sample floor × 30s probe = `slow` appears within ~2.5 min of onset; 20-sample ring ≈ 10 min rolling window.

3. **Quality derivation (server-side, anti-noise by construction):**
   - `down`: current failure path (any `_setFailure`).
   - `stale`: last successful update older than `max(3 × poll_interval_ms, 15s)` while not `down` (covers SSE-active gaps where polls are sparse — staleness is computed from data age, not poll cadence).
   - `slow`: rolling p95 > `fleet.slow_threshold_ms` (default **1500ms**) **and** window has ≥5 samples. p95-over-window plus the sample floor is the hysteresis — single slow samples never flip the badge.
   - `ok`: otherwise.
   - Default 1500ms rationale: ~60% of the 2500ms default timeout; would have correctly flagged the zylos0t CF path (1.7–2.0s) while leaving Jinglever (90–230ms) clean.
4. **Failure classification** in `_pollAgent`/`_ensureToken`/state-fetch/probe:
   - `AbortError` → `timeout`
   - `err.cause?.code` in (ECONNREFUSED, ECONNRESET, EHOSTUNREACH, ENETUNREACH) → `conn_refused`
   - HTTP 2xx but body is not **minimally valid** → `bad_payload`. Minimal valid shape, defined here (plan-review finding): body parses as JSON, is a plain object (not array/null), and `state` is a non-empty string. `stateToFleetRecord()` defaulting missing state to `UNKNOWN` must NOT swallow these — shape validation happens before record construction. Covers: empty body (the Caddy vhost case), non-JSON, `{}`, `[]`, `null`, and structurally-valid-but-semantically-empty objects like `{"ok":true}`.
   - 401/403 → `auth_failed`; 404 on token → `version_unsupported` (both unchanged)
   - anything else → `unreachable`
5. **Tile UI:** small latency chip (e.g. `1.8s`) shown when quality is `slow`/`stale`; subdued/desaturated tile styling for `stale`; existing unreachable rendering for `down` but tooltip now shows the specific reason. No layout reflow for `ok` members (chip hidden). i18n EN/ZH for new labels; unknown reasons fall back to raw text.
6. **Config:** `fleet.slow_threshold_ms` (default 1500), `fleet.latency_probe_interval_ms` (default 30000). No enable/disable switch — one tiny health GET per member per 30s is negligible, same default-on boundary Howard confirmed for #262.

## Development Checklist

- [ ] `FleetPoller`: dedicated latency probe — per-member timer at `fleet.latency_probe_interval_ms` (default 30s) GETting `/api/health` with the read API key; runs from `start()` regardless of SSE state; cleaned up in `stop()`/`removeAgent()` (follow the existing stream-timer cleanup pattern).
- [ ] `FleetPoller`: per-agent latency ring buffer (20 samples) fed only by the probe; record duration + timestamp on success.
- [ ] `FleetPoller`: failure classification helper mapping error/status → granular reason; use it in `_pollAgent`, `_ensureToken`, the state-fetch shape validation, and the probe.
- [ ] State payload shape validation per decision 4 (before `stateToFleetRecord`).
- [ ] **Empirical `err.cause.code` validation (plan-review finding): on Node 20 AND Node 24, run real `fetch()` against a closed port / refused connection / unreachable host; record observed `err.name` / `err.cause?.code` shapes. If unstable across versions, decide fallback classification then. Findings go in the PR description verbatim. Synthetic errors stay fine for unit tests.**
- [ ] `_setSuccess`/`_setFailure`: populate `link` object (quality derived per decision 3); `_setFailure` keeps existing `state`/`pulse_rate` behavior.
- [ ] `sanitizeRecord`: pass `link` through (nullable, default null).
- [ ] Staleness: derive at `getFleet()` read time from record age (so a wedged poll loop can't freeze quality at `ok`).
- [ ] Config plumbing: `fleet.slow_threshold_ms` with default.
- [ ] Frontend `app.js`: latency chip + tooltip (reason via i18n with raw fallback); `stale` styling class.
- [ ] `style.css`: chip + stale styles; bump `?v=N` cache-buster (update BOTH test files that pin it: `frontend-behavior` + `memory-markdown`).
- [ ] i18n EN/ZH strings for: slow, stale, link latency, timeout, conn_refused, bad_payload.

## Test Checklist

- [ ] Latency recording: fake fetch with controlled clock → window fills, p95 computed correctly, ring buffer caps at 20.
- [ ] **Probe-path proof (plan-review finding): with SSE healthy and continuously delivering `fleet_state` (no fallback polling), the probe alone fills ≥5 samples and triggers `slow` for a slow member.**
- [ ] Probe failure on an SSE-healthy member degrades `link.quality` only — member liveness/state untouched.
- [ ] Quality derivation: ok→slow at threshold with ≥5 samples (and NOT before 5 samples); slow→ok recovery; stale from data age with fake `now`; down on failure.
- [ ] Failure classification: one test per reason (AbortError, ECONNREFUSED via `cause`, 401, 404-token, 500).
- [ ] `bad_payload` matrix: 200 + empty body (Caddy vhost regression — must be `bad_payload`, not generic `unreachable`), 200 + non-JSON, 200 + `{}`, 200 + `[]`, 200 + `null`, 200 + `{"ok":true}` (structurally valid JSON, semantically empty).
- [ ] `sanitizeRecord` passthrough + secret-pattern check still green (`fleet-payload` tests).
- [ ] Existing fleet-poller/fleet-proxy suites unmodified and green (additive-only proof).
- [ ] Manual: browser screenshot of wall with one `ok`, one artificially `slow` member (point a test agent entry at a delay proxy or lower threshold to 50ms).

## Assumptions

- [ ] Fleet wall frontend tolerates additive fields on fleet records — **verified** in #262 review (no closed-shape consumers); re-verify nothing destructures records exhaustively.
- [ ] ~~Poll cadence~~ **RESOLVED by plan review (Jinglever P1)**: healthy-SSE members do NOT run periodic state polls (`start()` → single `pollOnce()` → SSE `_setSuccess` stops fallback polling). Latency sampling therefore uses the dedicated probe (decision 3a) and never depends on poll cadence.
- [ ] `/api/health` on remote members accepts the read API key as Bearer directly (no session-token exchange) — observed working against both live members on 2026-06-12; confirm in implementation and fall back to the token path if any member rejects it.
- [ ] `err.cause?.code` is populated by undici for connection-level failures on Node 20/24 — **moved to an explicit empirical-validation checklist item** (Development Checklist); not assumed.
- [ ] No persistence needed: latency window is in-memory; restart resets it (acceptable — wall is a live view).

## Acceptance Checklist

- [ ] Slow member shows latency chip + `slow` tooltip **under the real healthy-SSE path** (member connected via SSE, probe doing the sampling; simulate slowness via a delay proxy in front of a member or a lowered threshold); fast member shows no chip.
- [ ] Wedged upstream (200-accepting but hanging > timeout) shows `down` with reason `timeout`.
- [ ] Empty-200 upstream shows `down` with reason `bad_payload` (regression: was generic `unreachable`).
- [ ] Auth failure still renders as before (`auth_failed`).
- [ ] Browser screenshots: wall with mixed ok/slow/down members — sent to Howard.
- [ ] No regressions: full `npm test` green, `npm run check` green, existing tile rendering identical for `ok` members.
- [ ] `/api/fleet` payload contains `link` for all members; secrets scan unaffected.
