# Dev Plan: Remote agent detail — Actions/Settings gated by fleet API key scope (#206)

## Summary

Replace #205's blanket hide of Actions/Settings in remote view with scope-based gating: the controls are always visible on a remote agent's detail page; whether they can be invoked depends on the fleet API key's scope (`read` / `admin`). The producer already enforces this (`auth.js`: `/api/actions*` + `PUT /api/settings` → 403 `insufficient_scope` for non-admin) — all work is consumer-side.

## Scope

**In scope**
1. Fleet proxy: forward whitelisted write requests upstream instead of blanket 403.
2. Capability discovery: capture `scope` from the token exchange response, expose it to the frontend (in-page + standalone modes).
3. Frontend: show Actions/Settings in remote view; admin → fully functional via proxy; read → visible but disabled (Settings: viewable, save disabled). All actions/settings/health fetches become remote-aware (`agentPath`), closing the #205 wrong-target class permanently.
4. Remote-aware post-action health probe (`pollAndReload`).

**Out of scope**
- Producer-side changes (none needed; no version coupling — scope comes from the token exchange the consumer already does).
- API key management UI (CLI `scripts/api-key.js generate <name> [read|admin]` already exists).
- Audit logging of remote actions (future work if needed).

## Design decisions (settled in issue / with Howard)

- Authorization stays at the producer. The proxy forwards and passes through `403 insufficient_scope`; UI disabled-state is affordance only, never the security boundary.
- Read scope: buttons **visible but disabled** with a "read-only key" tooltip (Howard: 应该能看到，能否调用取决于 key 权限). Settings under read: openable read-only, save disabled (producer already allows read-scope GET `/api/settings`).
- Default stays read; admin keys explicitly issued.

## Development Checklist

### A. Poller: capture scope (`src/lib/fleet-poller.js`)
- [ ] `_ensureToken`: store `scope` from the exchange response in the token cache (`{ token, expiresAtMs, scope }`). Missing/unknown scope → `'read'` (conservative).
- [ ] New `getAgentAccess(name)` → `'admin' | 'read'` from cache; `'read'` when no token yet (UI upgrades to admin on next render after exchange).
- [ ] `getFleet()` remote agent records gain `access` field from the cache.

### B. Fleet payload (`src/lib/fleet-payload.js` / self record builder)
- [ ] Self record gets `access: 'admin'` (local session has full rights) so frontend logic is uniform.
- [ ] Confirm `assertFleetPayloadSafe` unaffected (the `access` values `read`/`admin` don't match secret patterns).

### C. Proxy write forwarding (`src/lib/fleet-proxy.js`)
- [ ] `proxyApi`: allow exactly `POST /api/actions/<action>` and `PUT /api/settings`; every other non-GET/HEAD stays 403 `read_only_proxy`.
- [ ] `_fetchUpstream`: forward the request body for write methods — buffer raw bytes with a size cap (e.g. 1 MB → 413), preserve `content-type`. Strip the inbound `content-length` and let fetch compute it from the buffered body. (No streaming `duplex` games; bounded buffer is simpler and testable.)
- [ ] Existing 401-retry (token refresh) applies to writes too — safe because 401 means the upstream never executed the action (producer validates bearer in `auth.handle()` before any action/settings handler runs).
- [ ] Upstream status/body passthrough incl. `403 insufficient_scope`; existing secret guard applies to write responses same as reads.

### C2. Consumer boundary gate (`src/lib/auth.js`) — review finding #1
Today the consumer admin gate only matches local paths (`/api/actions`, `PUT /api/settings`); fleet paths admit any valid API session. Once the proxy forwards writes, a **read**-scope API session on the consumer could execute remote **admin** actions via `/fleet/<name>/api/...` — an escalation the proxy must not introduce.
- [ ] Extend `needsAdmin` to also match proxied writes: `POST /fleet/<name>/api/actions/*` and `PUT /fleet/<name>/api/settings` require a browser session or an **admin**-scope consumer API session; a read-scope consumer API session → 403 `insufficient_scope`.
- [ ] This is defense at the consumer boundary only — the producer remains the final authorization authority for the fleet key's scope.

### D. Standalone remote page access discovery (`src/lib/fleet-proxy.js` serveHtml + `src/index.js` local HTML serving + `index.html`)
- [ ] `index.html` gains a `__REMOTE_ACCESS__` placeholder (script global, alongside `__BASE_PATH__`).
- [ ] Fleet-served HTML: **actively resolve** scope before injection — `getSessionToken(agent)` then `getAgentAccess(agent)`; only on exchange failure or missing scope fall back to `'read'`. (Cached-scope-only would pin an admin key's standalone page to read right after a consumer restart, with no upgrade path — review finding #2.)
- [ ] Locally served HTML: replace with `'admin'`.

### E. Frontend (`public/js/app.js`)
- [ ] `remoteAccess()` helper: in-page remote → fleet record `access`; standalone (`REMOTE_AGENT`) → injected `__REMOTE_ACCESS__`; local → `'admin'`.
- [ ] `renderInfoBar`: always render Actions/⚙️; when viewing a remote with access ≠ admin, render `disabled` + tooltip (i18n key, en/zh). `↑update` badge clickable only when access = admin in remote view.
- [ ] `initInfoBarButtons`: replace the blanket `state.remoteAgent` return with access-based gating (Actions/update-badge require admin; Settings opens for both, see next).
- [ ] Settings modal: when access ≠ admin on a remote, save/apply disabled + inline note; GET still loads remote values.
- [ ] Route writes remotely: `fetch(api('/api/actions/…'))` → `agentPath`; settings GET/PUT → `agentPath`; follow the existing fetchJson/SSE pattern from #205.
- [ ] `pollAndReload` / restart countdown: capture the target path **at action time** (so a local action's probe stays local even if the user navigates into a remote view mid-countdown; a remote action probes the remote via proxy). Post-reload on `/fleet/<name>/` lands on the standalone remote page — acceptable, document it.
- [ ] Action confirm dialogs include the agent name when targeting a remote (e.g. "重启 Jinglever？") — cheap wrong-target protection.
- [ ] Keep #205's `resetAgentData()` modal-closing (still needed when switching agents with a modal open).
- [ ] Cache bust: `app.js?v=40` (+ `index.html` changes ship together).

### F. i18n
- [ ] New keys (en/zh): read-only tooltip ("Read-only key — actions unavailable" / "只读密钥，无法操作"), settings save-disabled note.

## Test Checklist

- [ ] Proxy: whitelisted write forwarded with body + content-type; non-whitelisted write (e.g. `POST /api/auth/token`, `DELETE`) → 403 `read_only_proxy`; upstream `403 insufficient_scope` passed through verbatim; oversized body → 413; 401-retry on write proves the upstream executed exactly once (first 401 never hit the action handler, post-refresh attempt runs once); secret guard on write responses. (Updates `test/fleet-proxy.test.js:279` which currently asserts the blanket 403.)
- [ ] Consumer boundary gate: read-scope consumer API session **cannot** write via `/fleet/<name>/api/actions/...` even when the remote fleet key is admin (403 `insufficient_scope`); admin-scope consumer API session and browser session pass through to the remote.
- [ ] Standalone HTML access injection: empty cache + admin exchange → injects `admin`; exchange failure or missing scope → `read`.
- [ ] Poller: scope captured from exchange; missing scope → `'read'`; `getAgentAccess` unknown-agent/no-token behavior; `getFleet` records carry `access`.
- [ ] Payload: self record `access: 'admin'`; leak guard still passes.
- [ ] Frontend: renderInfoBar three states (local / remote+admin / remote+read); handler gating; actions/settings fetches hit `/fleet/<name>/api/...` when in-page remote; pollAndReload target captured at action time.
- [ ] Manual: full `npm test` + `npm run check`; browser verification (below).

## Assumptions

- [ ] Token exchange response includes `scope` on current producers (it does — `exchangeApiKeyForToken` returns it). Absent → treated as `read`; **never** assumed admin.
- [ ] Producer admin gate is authoritative and already deployed on both fleet machines (auth.js `needsAdmin`) — guaranteed by current main.
- [ ] CSRF posture of proxied writes equals existing local `/api/actions` for the **browser-cookie path** (same-origin JSON POST, Strict cookie). The API-token path is a separate concern — covered by the consumer boundary gate (C2), not by CSRF reasoning.
- [ ] Existing fleet configs use read-scope keys (current default). Acceptance requires issuing one admin key on a producer (`scripts/api-key.js generate <name> admin`) and swapping it into the consumer config.
- [ ] Remote actions (restart/upgrade/switch-model) executing on the remote machine is intended behavior, not a side effect.

## Acceptance Checklist

- [ ] **Read key (current config)**: remote detail shows Actions/⚙️ disabled with tooltip; settings opens read-only with remote values, save disabled; browser network tab shows zero writes to local root from remote view. Screenshot.
- [ ] **Defense-in-depth**: with read key, force `curl -X POST <consumer>/fleet/<name>/api/actions/interrupt` (authed) → 403 `insufficient_scope` from the remote (not `read_only_proxy`).
- [ ] **Admin key**: issue a **temporary** admin key on Jinglever's producer (coordinate with him), swap into consumer config; buttons enabled; run one **low-impact** action end-to-end (e.g. settings PUT with unchanged values, or switch-effort to its current value) — verify it executed on the remote, not locally. Screenshot (key never visible in logs, screenshots, or chat).
- [ ] **Admin key lifecycle**: key is created for this acceptance only, transmitted over a Howard-authorized private path, and after acceptance is **revoked** with the consumer config restored to the read key.
- [ ] Local agent detail completely unaffected (buttons enabled, local routing). No regressions: in-page fleet ↔ remote switch, back-nav, SSE reconnect.
- [ ] Standalone `/fleet/<name>/` page shows the same gating.
- [ ] `npm test` green, `npm run check` clean.
