# Dev Plan: Secure Defaults for post-install + ingestToken Fix (#118)

## Summary

Fresh dashboard installs are unprotected (no auth password) and the ingestToken feature in hook-ingest.cjs is broken (never sends Authorization header). Fix both, and clean up unused config fields from the post-install template.

## Scope

**In scope (from issue decisions):**
- post-install.js: generate random password, hash with scrypt, write `auth.enabled: true`, print plaintext to console
- hook-ingest.cjs: read `ingestToken` from config.json, include `Authorization: Bearer <token>` header when token is set
- post-install.js: remove unused config fields (`theme`, `refreshMs`, `retention.*`)
- config.js: remove unused defaults (`theme`, `refreshMs`) to match
- README.md / SKILL.md: update config table and auth default descriptions to match new behavior

**Out of scope:**
- ingestToken is NOT auto-generated (Decision: Pattern #31 — localhost is the boundary auth, internal token is optional defense-in-depth)
- No changes to auth.js, ingest-handler.js, or the dashboard UI

## Development Checklist

- [ ] **post-install.js**: Import `hashPassword` from `src/lib/auth.js` (post-install.js is already ESM and already imports from src/) to generate password
  - Generate 16-byte random password, encode as hex (32 chars)
  - Hash with `hashPassword()` — ensures compatibility with auth.js verification
  - Write config with `auth.enabled: true` and hashed password
  - Print plaintext password to stdout with clear labeling
  - Remove `theme`, `refreshMs`, and entire `retention` block from the default config template
- [ ] **hook-ingest.cjs**: In `loadComponentConfig()`, extract `ingestToken`. In `postToServer()`, add `authorization: 'Bearer <token>'` header when token is non-null
- [ ] **config.js**: Remove `theme` and `refreshMs` from defaults object. Remove `theme` from the merge logic (line 51)
- [ ] **README.md**: Update config table — remove theme/refreshMs/retention.*, update auth defaults (enabled: true, auto-generated password), add install output description
- [ ] **SKILL.md**: Update config descriptions to match new defaults, remove references to theme

## Test Checklist

- [ ] Unit: post-install generates valid scrypt hash format (`scrypt:<hex-salt>:<hex-hash>`)
- [ ] Unit: post-install config has `auth.enabled: true` and no unused fields (theme, refreshMs, retention absent)
- [ ] Unit: generated password is verifiable — scrypt verify against stored hash matches the plaintext printed to stdout
- [ ] Unit (automated): hook-ingest.cjs Authorization header test
  - Set up temp `ZYLOS_DIR` with `components/dashboard/config.json` containing `ingestToken: "secret123"`
  - Start local HTTP server on test port
  - Spawn `hook-ingest.cjs` with mock hook event on stdin
  - Assert received request header: `authorization: Bearer secret123`
  - Second case: `ingestToken: null` → assert no Authorization header sent
- [ ] Manual: run post-install.js with no existing config.json → verify output contains plaintext password
- [ ] Manual: run post-install.js with existing config.json → verify it does NOT overwrite (existing guard at line 16)
- [ ] `npm test` passes

## Acceptance Checklist

- [ ] Fresh install auth verification (end-to-end):
  1. Run `hooks/post-install.js` with fresh `ZYLOS_DIR` (no existing config.json)
  2. Extract plaintext password from stdout
  3. Start dashboard server against the generated config
  4. Unauthenticated GET to protected page → redirected to /login (or 401 on API)
  5. POST /login with the stdout password → success (session cookie set)
  6. POST /login with wrong password → failure
- [ ] Plaintext password is printed to console during install with clear labeling
- [ ] Config.json contains only meaningful fields (no theme, refreshMs, retention.*)
- [ ] hook-ingest.cjs sends Authorization header when ingestToken is configured (automated test)
- [ ] hook-ingest.cjs does NOT send Authorization header when ingestToken is null (automated test)
- [ ] Existing installs with config.json are not affected (no overwrite)
- [ ] README.md and SKILL.md reflect new defaults accurately
- [ ] No regressions: `npm test` passes
