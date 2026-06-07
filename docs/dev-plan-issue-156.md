# Dev Plan: Multi-Agent Pulse Wall — real-time fleet view (#156)

## Summary

Build a cross-instance fleet view ("Pulse Wall") on top of the existing read-scoped API token auth (#140/#146). One dashboard acts as an embedded **hub** that polls the read API of every agent in a static registry and renders a live grid of agent tiles — each an expressive Zylos mascot whose state (busy/thinking/idle/stuck/offline) and name-hashed color show fleet health at a glance. Click a tile → drill into that agent's existing full dashboard.

## Scope

**In scope (MVP, from #156 decisions):**
- Stable agent-identity field on `/api/state`
- Static fleet registry (`{name, base_url, read_token}` per agent) + key storage
- Hub poll loop: token exchange (per #140) + periodic `/api/state` fetch → combined `/api/fleet`
- Pulse Wall UI: tile grid (mascot avatar + heartbeat dot + context ring + now-playing + cost + sparkline), fleet heartbeat bar, offline/stale as first-class state, drill-down
- Transparent-bg mascot art (5 states) + name-hash color (FNV-1a → palette/hue) applied via CSS (Option A: uniform dark wall, only creature tints)

**Explicitly out of scope (deferred, per #156):**
- SSE streaming for the grid (poll only for MVP; SSE reserved for drill-down which already exists)
- Cross-fleet trends/history/alerting
- `admin` scope / remote actions (fleet view stays observation-only)
- Standalone aggregator deployment (hub logic written as a self-contained module so it can graduate later with no rewrite)
- Agent self-registration / discovery

## Development Checklist

### Phase 0 — Prerequisites (foundational, no UI)
- [ ] Add a stable instance identity field to `/api/state` (e.g. `agent.name` / `agent.id`), sourced from config; default sensibly if unset. NB: existing `agent_id` is per-subagent — do **not** overload it.
- [ ] Define fleet registry config schema: list of `{ name, base_url, api_key }`. Decide storage location (config file vs `store.js` DB table) and document it.
- [ ] Read-key storage: keep API keys out of any client-served path; never expose in `/api/fleet` responses.
- [ ] Unit tests: identity field present/typed in `/api/state`; registry parse/validation (missing fields, empty list, bad URL).

### Phase 1 — Hub aggregation backend (headless, testable)
- [ ] New module `src/lib/fleet-poller.js` (self-contained, so it can later run standalone): for each registry entry, exchange `api_key` → session token via `POST /api/auth/token` (reuse `auth.js` client patterns), cache token + refresh on expiry/401.
- [ ] Poll loop: GET each agent's `/api/state` on an interval (config, default ~3s) with per-agent timeout, jitter, and independent failure isolation (one agent down ≠ whole fleet stalls).
- [ ] Per-agent derived fleet record: `{ name, color_hue, state (busy|thinking|idle|stuck|offline|unreachable), activity (tool glyph + verb), context_pct, cost, last_seen, pulse_rate }`. Compute `state`/`pulse_rate` from polled data + staleness.
- [ ] Staleness/liveness: failed poll → `unreachable`; stale `last_seen` → `offline`; distinguish from `idle`. TTL on cached records.
- [ ] New endpoint `GET /api/fleet` returning the combined records (read-cookie or read-token auth; never leak keys).
- [ ] Name-hash helper `src/lib/agent-color.js`: FNV-1a(name) → palette index / hue. Pure, deterministic, shared with frontend (or expose `color` in `/api/fleet`).
- [ ] Unit tests: token exchange + refresh-on-401; poll failure isolation; staleness→offline/unreachable transitions; color hash determinism + order-independence.

### Phase 2 — Pulse Wall UI
- [ ] Produce 5 transparent-bg mascot PNGs (busy/thinking/idle/stuck/offline) — chroma-key/rembg from existing art, glow removed (glow is CSS). Place under `public/img/mascot/`.
- [ ] New route/page (or section) `Pulse Wall`: grid of agent tiles consuming `/api/fleet` via poll (~3s).
- [ ] Tile: mascot avatar (state PNG) + CSS `--agent-accent` (from hash) driving heartbeat dot (color + pulse-rate animation), context-fuel ring, glow, nameplate; "now playing" line (tool glyph + verb); cost + tiny sparkline; last-seen.
- [ ] Offline/stale tile state: greyed mascot, no pulse, last-seen label.
- [ ] Fleet heartbeat bar: aggregate pulse + total $/min + `N busy · N idle · N stuck` counts.
- [ ] Drill-down: click tile → that agent's full dashboard (open agent `base_url` / proxied read view).
- [ ] i18n entries (`en.json`/`zh.json`) for new labels.
- [ ] Frontend behavior test (extend `frontend-behavior.test.js`): tile renders per state; offline rendering; color is stable per name.

## Test Checklist
- [ ] `npm test` (node --test) green across new + existing suites
- [ ] Phase 0: `/api/state` identity field; registry validation edge cases
- [ ] Phase 1: token refresh on expiry/401; one unreachable agent doesn't block others; staleness state machine; `agent-color` determinism & order-independence; keys never present in `/api/fleet` output
- [ ] Phase 2: browser screenshots of the wall with ≥2 agents showing different states + different name-hash colors; offline tile; drill-down navigation
- [ ] No regression: existing single-agent dashboard, `/api/state`, `/api/stream`, auth all unchanged

## Assumptions
- [ ] **#140 token endpoint is available on every agent** (`POST /api/auth/token`, read scope). Guaranteed for agents already on the post-#146 build; registry agents must be ≥ that version — needs validation per-agent (handle 404/older gracefully → mark `unreachable` with a reason).
- [ ] **Agents are network-reachable from the hub** at their `base_url` (Caddy/HTTPS or LAN). Infra prerequisite — not guaranteed; document required exposure. (Lark→websocket cleanup today closed `/lark/webhook`; the dashboard route `/dashboard/*` remains the reachable surface.)
- [ ] **Agent names are stable identifiers** for color hashing; renaming an agent changes its color (acceptable, documented).
- [ ] **Read API keys are provisioned out-of-band** per agent and placed in the hub registry by an operator (no auto-provisioning in MVP).
- [ ] **Fleet size is small** (handful → ~tens); poll fan-out is fine, no pagination/sharding needed.
- [ ] **Collisions in name-hash colors are acceptable** (not deduped — would break order-independence); mitigated by always-visible name labels.

## Acceptance Checklist
- [ ] Phase 0: `/api/state` exposes stable agent identity; registry loads & validates
- [ ] Phase 1: `/api/fleet` returns live combined records for all registered agents; an unreachable agent shows `unreachable`/`offline` without stalling others; no API keys in any client response
- [ ] Phase 2 (UI verification — browser screenshots required): Pulse Wall renders a tile per agent with correct state mascot, name-hashed color, context ring, now-playing, heartbeat; offline tile greyed; fleet heartbeat bar correct; drill-down opens the agent's dashboard
- [ ] Color is stable per name and unchanged when registry order changes (verify by reordering registry → screenshots identical colors)
- [ ] No regressions in existing features; `npm test` green; lint clean
