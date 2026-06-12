# Dev Plan: API Key Rotation, Name Reuse, Hard Delete (#273)

## Summary

Give API keys a full lifecycle: revoked names become reusable (uniqueness scoped to active keys), an atomic rotate endpoint preserves key identity while replacing the secret, and revoked keys can be hard-deleted (single + bulk) to keep the key list clean.

## Scope

**In** (all decisions settled in issue #273 discussion):
1. Schema migration v11: name uniqueness applies to active keys only (partial unique index).
2. `POST /api/keys/<name>/rotate`: atomic secret replacement, plaintext returned once, outstanding session tokens invalidated.
3. Hard delete, revoked-only: `DELETE /api/keys/<name>?permanent=1` (single) + `POST /api/keys/purge-revoked` (bulk). Active keys must be revoked first.
4. Conflict semantics fix: duplicate active name → 400 `duplicate_name` (pre-check, active-only) / 409 `name_taken` (insert race), never a generic 500.
5. UI: Rotate button (active rows), Delete button (revoked rows), Purge-all-revoked button.

**Out**: hard delete of active keys (two-step safety), key renaming, expiry/auto-rotation policies, changes to `DELETE /api/keys/<name>` default semantics (stays soft revoke).

## Design Notes

- **Migration v11 (table rebuild)**: SQLite can't drop a table-level UNIQUE; rebuild `api_keys` without it (`CREATE api_keys_new` → `INSERT ... SELECT` preserving `id` explicitly → drop → rename), then `CREATE UNIQUE INDEX idx_api_keys_active_name ON api_keys(name) WHERE revoked_at IS NULL`. `id` preservation is mandatory — `api_sessions.api_key_id` references it. `PRAGMA foreign_keys` is not enabled in this codebase (verified), so the rebuild won't trip FK enforcement, but ids must still match for the join in `_getApiSession`.
- **`getApiKeyByName` semantics change**: with name reuse there can be one active + N revoked rows per name. The store method must return the **active** row (`WHERE name = ? AND revoked_at IS NULL`). Audit all call sites (`validateApiKeyName`, create-response fetch).
- **Rotate** (`rotateApiKey(name, newHash)`): single transaction — `UPDATE api_keys SET key_hash = @hash WHERE name = @name AND revoked_at IS NULL` + `DELETE FROM api_sessions WHERE api_key_id = @id`. Same row/id/scope/created_at; response shape mirrors create (`plaintext_key` + key payload). 404 for unknown-or-revoked name. Session invalidation rationale: session TTL is 24h; rotation that leaves old-secret-minted tokens alive is cosmetic.
- **Hard delete** (`hardDeleteApiKey(name)` / `purgeRevokedApiKeys()`): deletes `api_sessions` rows then `api_keys` rows, one transaction. Single-name form targets **all revoked rows of that name** (multiple can exist after reuse); active row untouched. `?permanent=1` on an **active** key → 409 `must_revoke_first`. No revoked rows → 404.
- **Routing**: `/api/keys/<name>/rotate` is parseable because the name charset is `[\w.-]{1,64}` (no `/`, verified in `validateApiKeyName`). Route order: check `/rotate` suffix and `purge-revoked` before treating the tail as a bare name.
- **Auth**: `needsAdminApiAccess()` already matches the `/api/keys` prefix → rotate/purge/permanent-delete are admin-gated with no auth changes. Web-session users (password login) retain full access, unchanged.
- **UI**: Settings → API Keys. Active rows: Rotate (confirm → plaintext-once display, reuse create UX). Revoked rows: Delete (confirm). List header: "Purge all revoked" (rendered only when revoked rows exist). Bump `style.css`/`app.js` cache-bust versions AND update both pinning test files (`frontend-behavior.test.js`, `memory-markdown.test.js`).

## Development Checklist

- [ ] Migration v11: rebuild `api_keys` (drop table-level UNIQUE, preserve ids), add partial unique index
- [ ] Store: `getApiKeyByName` → active-only; audit/adjust all call sites
- [ ] Store: `rotateApiKey(name, newHash)` (transaction: update hash + delete sessions)
- [ ] Store: `hardDeleteApiKey(name)` (revoked rows only, + their sessions, transaction)
- [ ] Store: `purgeRevokedApiKeys()` (all revoked rows + their sessions, transaction)
- [ ] Route: `POST /api/keys/<name>/rotate` (admin-gated, 404 unknown/revoked, create-shaped response)
- [ ] Route: `DELETE /api/keys/<name>?permanent=1` (409 `must_revoke_first` on active; 404 none)
- [ ] Route: `POST /api/keys/purge-revoked` (returns purged count + key list payload)
- [ ] Route: create-conflict semantics — `validateApiKeyName` duplicate check active-only; insert race → 409 `name_taken`
- [ ] UI: Rotate / Delete / Purge-all-revoked buttons + plaintext-once display for rotate
- [ ] Cache-bust versions + both pinning tests updated

## Test Checklist

- [ ] Migration: v10 DB with active + revoked keys migrates; ids preserved; `api_sessions` join still resolves; partial index enforced (duplicate active name rejected, revoked-name reuse allowed)
- [ ] Lifecycle: create → revoke → recreate same name succeeds; `getApiKeyByName` returns the active row; list shows both rows with correct status
- [ ] Create conflict: duplicate active name → 400 `duplicate_name`; insert race path → 409 `name_taken` (no 500)
- [ ] Rotate: old plaintext key fails `/api/auth/token`, new one succeeds; outstanding session token 401s immediately; id/scope/created_at unchanged; unknown + revoked name → 404
- [ ] Hard delete: revoked-only guard (active + `permanent=1` → 409); sessions rows removed; multi-revoked-rows-same-name all purged; active same-name row survives
- [ ] Bulk purge: removes all revoked rows + sessions, count correct, active keys untouched
- [ ] Scope guard: read-scope API token → 403 on rotate / permanent delete / purge
- [ ] Frontend behavior tests: buttons render per row status, plaintext-once display on rotate
- [ ] Full suite green (`npm test`), `npm run check` clean

## Assumptions

- [ ] `api_keys.id` values survive the table rebuild byte-identically — **guaranteed** by explicit-id `INSERT ... SELECT`; asserted in migration test.
- [ ] API key name charset excludes `/` — **guaranteed** by existing `validateApiKeyName` regex `[\w.-]{1,64}`; makes `/rotate` sub-path routing unambiguous.
- [ ] No code path relies on `getApiKeyByName` returning revoked rows — **needs validation** during implementation (audit every call site).
- [ ] `PRAGMA foreign_keys` is off (better-sqlite3 default, nothing enables it) — **verified**; session cleanup on delete must be explicit, not cascade.
- [ ] Fleet consumers hold our keys' plaintext in their config — rotating a fleet-used key breaks that link until the consumer updates config. **Operational caveat, not code**: note in CHANGELOG.

## Acceptance Checklist

- [ ] Sandbox instance (ephemeral ZYLOS_DIR + free port — NEVER the production dashboard, per #269): full lifecycle walk — create → revoke → recreate same name → rotate (old key + old session die, new key works) → hard delete single → purge revoked
- [ ] UI verification with browser screenshots: Rotate plaintext-once display, revoked-row Delete, Purge-all button, list states before/after
- [ ] Scope guard verified live: read-scope token 403 on all three new mutations
- [ ] No regressions: existing create/revoke/token-exchange flows, fleet polling unaffected
- [ ] `npm test` full suite green; `npm run check` clean
- [ ] Production DB untouched (zero synthetic rows post-acceptance)
