# Dev Plan: Multi-Agent Pulse Wall — real-time fleet view (#156)

## Summary

Build a cross-instance fleet view ("Pulse Wall") on top of the existing read-scoped API token auth (#140/#146). One dashboard acts as an embedded **hub** that polls the read API of every agent in a static registry and renders a live grid of agent tiles — each an expressive Zylos mascot whose state (busy/thinking/idle/stuck/offline) and name-hashed color show fleet health at a glance. Click a tile → drill into that agent's full single-agent dashboard, served by the hub and proxied to the remote agent (no key ever reaches the browser).

## Terminology (fixed — use these exact terms everywhere)

| Term | Meaning | Lifetime | Visibility |
|------|---------|----------|-----------|
| `read_api_key` | long-lived read-scoped API key for a remote agent, stored in the hub registry | long-lived | **hub-only secret** — never sent to the browser, never in any client response |
| `read_session_token` | short-lived session token the poller obtains by exchanging `read_api_key` at the agent's `POST /api/auth/token` | ~24h, refreshed | **hub-only** — never client-visible |

`/api/fleet` and any drill-down response MUST contain neither `read_api_key` nor `read_session_token`.

## Scope

**In scope (MVP, from #156 decisions):**
- Stable agent-identity field on `/api/state`
- Static fleet registry (`{ name, base_url, read_api_key }` per agent) + secret storage + validation
- Hub poll loop: `read_api_key` → `read_session_token` exchange (per #140) + periodic `/api/state` fetch → combined `/api/fleet`
- Pulse Wall UI: tile grid (mascot avatar + heartbeat dot + context ring + now-playing + cost + sparkline), fleet heartbeat bar, offline/stale as first-class state
- Drill-down: hub-served full single-agent dashboard, API/SSE proxied to the remote agent with `read_session_token` injected (observation-only)
- Transparent-bg mascot art (5 states) + name-hash color (FNV-1a → palette/hue) applied via CSS (Option A: uniform dark wall, only creature tints)

**Explicitly out of scope (deferred, per #156):**
- SSE streaming for the *grid* (poll only for MVP; SSE used only inside drill-down, which reuses the existing stream)
- Cross-fleet trends/history/alerting
- `admin` scope / remote actions (fleet view + drill-down stay observation-only; action controls hidden/disabled in drill-down)
- Standalone aggregator deployment (hub logic written as self-contained modules so it can graduate later with no rewrite)
- Agent self-registration / discovery

## Development Checklist

### Phase 0 — Prerequisites (foundational, no UI)
- [ ] Add a stable instance identity field to `/api/state` (e.g. `agent.name` / `agent.id`), sourced from config; default sensibly if unset. NB: existing `agent_id` is per-subagent — do **not** overload it.
- [ ] Fleet registry config schema: list of `{ name, base_url, read_api_key }`. Decide storage (config file vs `store.js` table) and document; keep `read_api_key` out of any client-served path.
- [ ] **Static registry validation only (Phase 0 makes NO remote requests):** validate each entry's schema — name non-empty/unique, base_url well-formed, `read_api_key` present. The runtime capability/reachability probe (actually calling `/api/auth/token`, deciding `unreachable`/`version_unsupported`) and `health_reason` assignment live in the Phase 1 poller — Phase 0 must not stand up a half-formed poller.
- [ ] Unit tests: identity field present/typed in `/api/state`; static registry parse/validation (missing fields, dup names, empty list, malformed URL).

### Phase 1 — Hub aggregation backend (headless, testable)
- [ ] New module `src/lib/fleet-poller.js` (self-contained, can later run standalone): per registry entry, exchange `read_api_key` → `read_session_token` via `POST /api/auth/token` (reuse `auth.js` client patterns); cache token; refresh on expiry and on 401.
- [ ] Poll loop: GET each agent's `/api/state` on an interval (config, default ~3s) with per-agent timeout, jitter, and **failure isolation** — one agent's error/timeout/401/404 never stalls or fails the others.
- [ ] Per-agent derived fleet record: `{ name, color, state (busy|thinking|idle|stuck|offline|unreachable|version_unsupported), activity (tool glyph + verb), context_pct, cost, last_seen, pulse_rate, health_reason }`. Compute `state`/`pulse_rate` from polled data + staleness.
- [ ] Staleness/liveness + **runtime capability/reachability probe lives here (moved from Phase 0):** assign per-agent `health_reason` — failed poll → `unreachable`; missing token endpoint (`/api/auth/token` 404) → `version_unsupported`; auth_failed on 401; stale `last_seen` → `offline`; distinguish all from `idle`. TTL on cached records.
- [ ] New endpoint `GET /api/fleet` returning combined records (read-cookie or read-token auth). **Assert in code + test: no `read_api_key` / `read_session_token` in the payload.**
- [ ] Name-hash helper `src/lib/agent-color.js`: FNV-1a(name) → palette index / hue. Pure, deterministic, order-independent. Expose resolved `color` in `/api/fleet` (and/or shared with frontend).
- [ ] **Drill-down proxy** `src/lib/fleet-proxy.js`: routes `/fleet/:agent/api/*` and `/fleet/:agent/api/stream` → proxy to `${base_url}/api/*` with `Authorization: Bearer <read_session_token>` injected server-side; SSE passed through; serve the existing static frontend (`public/`) under base path `/fleet/:agent/` (via X-Forwarded-Prefix) so it reuses 100% of the single-agent UI pointed at the proxied API. The key/token is injected only on the hub→agent hop and never reaches the browser. `POST /api/actions/*` is read-scope-forbidden upstream (403) → drill-down hides/disables action controls (observation-only).
- [ ] Unit tests: token exchange + refresh-on-expiry + refresh-on-401; **token endpoint 404 → `version_unsupported`**, **invalid key 401 isolated to that agent**; poll failure isolation; staleness state machine transitions; `agent-color` determinism + order-independence; `/api/fleet` contains neither secret. Proxy tests: API proxy returns remote data with token injected; static assets resolve under the prefix; SSE passes through; key/token absent from all client-visible responses; action POST blocked (403) handled gracefully.

### Phase 2 — Pulse Wall UI
- [ ] Produce 5 transparent-bg mascot PNGs (busy/thinking/idle/stuck/offline) — chroma-key/rembg from existing art, glow removed (glow is CSS). Place under `public/img/mascot/`.
- [ ] New route/page `Pulse Wall`: grid of tiles consuming `/api/fleet` via poll (~3s).
- [ ] Tile: mascot avatar (state PNG) + CSS `--agent-accent` (from hash) driving heartbeat dot (color + pulse-rate animation), context-fuel ring, glow, nameplate; "now playing" line (tool glyph + verb); cost + tiny sparkline; last-seen.
- [ ] Offline/stale/unreachable/version_unsupported tile states: greyed mascot, no pulse, reason label.
- [ ] Fleet heartbeat bar: aggregate pulse + total $/min + `N busy · N idle · N stuck`.
- [ ] Drill-down: click tile → `/fleet/:agent/` (hub-served dashboard over the proxy).
- [ ] i18n entries (`en.json`/`zh.json`) for new labels.

## Test Checklist
- [ ] `npm test` (node --test) green across new + existing suites
- [ ] Phase 0: `/api/state` identity field; static registry validation edge cases (no remote calls)
- [ ] Phase 1: token refresh (expiry + 401); **token endpoint 404 → version_unsupported**; **invalid key 401 isolated to that agent**; one unreachable agent doesn't block others; staleness state machine; `agent-color` determinism & order-independence; **no secret in `/api/fleet`**; proxy API/static/SSE + token-never-client-visible + action-403 handling
- [ ] Phase 2 — **fixture-driven DOM/behavior assertions (primary correctness proof; extend `frontend-behavior.test.js`):** mock `/api/fleet` with multiple agents across busy/idle/thinking/stuck/offline → assert aggregate counts, total $/min burn, per-tile state class, last-seen/offline reason label, and the name→color map; reorder registry / response order → assert color mapping is byte-identical.
- [ ] Phase 2 — **browser screenshots (supplementary visual verification, not the correctness proof):** wall with ≥2 agents in different states + different name-hash colors; offline tile; drill-down opens the agent's dashboard
- [ ] No regression: existing single-agent dashboard, `/api/state`, `/api/stream`, auth all unchanged

## Assumptions
- [ ] **`read_api_key` provisioned out-of-band** per agent and placed in the hub registry by an operator (no auto-provisioning in MVP).
- [ ] **Agent names are stable identifiers** for color hashing; renaming changes color (acceptable, documented).
- [ ] **Fleet size is small** (handful → ~tens); poll fan-out is fine, no pagination/sharding.
- [ ] **Name-hash color collisions are acceptable** (not deduped — dedup would break order-independence); mitigated by always-visible name labels.
- [ ] NB: the previously-assumed ">= #146 token endpoint exists" and "hub→agent reachability" are **no longer mere assumptions** — they are enforced in registry validation + surfaced as per-agent `health_reason` (`version_unsupported` / `unreachable`) and covered by tests above.

## Acceptance Checklist
- [ ] Phase 0: `/api/state` exposes stable agent identity; registry loads and passes static schema validation (no remote calls; `health_reason` is Phase 1)
- [ ] Phase 1: `/api/fleet` returns live combined records for all registered agents; an unreachable / version_unsupported / bad-key agent shows the correct state without stalling others; **no `read_api_key`/`read_session_token` in any client response**; drill-down proxy serves the remote dashboard via the hub with the token injected server-side and action controls disabled
- [ ] Phase 2 — **fixture/DOM assertions pass**: aggregate counts, total burn, tile state classes, reason labels, and name→color map are correct; reordering the registry yields identical colors
- [ ] Phase 2 — **browser screenshots** confirm the visual wall (states, colors, offline tile, drill-down) matches expectations
- [ ] No regressions in existing features; `npm test` green; lint clean
