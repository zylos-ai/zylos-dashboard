# Dev Plan: Secure Defaults for post-install + ingestToken Fix (#118)

## Summary

Fresh dashboard installs are unprotected (no auth password) and the ingestToken feature in hook-ingest.cjs is broken (never sends Authorization header). Fix both, and clean up unused config fields from the post-install template.

## Scope

**In scope (from issue decisions):**
- post-install.js: generate random password, hash with scrypt, write `auth.enabled: true`, print plaintext to console
- hook-ingest.cjs: read `ingestToken` from config.json, include `Authorization: Bearer <token>` header when token is set
- post-install.js: remove unused config fields (`theme`, `refreshMs`, `retention.*`)
- config.js: remove unused defaults (`theme`, `refreshMs`) to match

**Out of scope:**
- ingestToken is NOT auto-generated (Decision: Pattern #31 — localhost is the boundary auth, internal token is optional defense-in-depth)
- No changes to auth.js, ingest-handler.js, or the dashboard UI

## Development Checklist

- [ ] **post-install.js**: Inline scrypt password generation (can't import ESM auth.js in a hook script that runs during `npm install` — replicate the `crypto.randomBytes` + `crypto.scryptSync` logic directly)
  - Generate 16-byte random password, encode as hex (32 chars)
  - Hash with scrypt using same parameters as auth.js (`SCRYPT_KEYLEN = 64`, 32-byte salt)
  - Write config with `auth.enabled: true` and hashed password
  - Print plaintext password to stdout with clear labeling
  - Remove `theme`, `refreshMs`, and entire `retention` block from the default config template
- [ ] **hook-ingest.cjs**: In `loadComponentConfig()`, extract `ingestToken`. In `postToServer()`, add `authorization: 'Bearer <token>'` header when token is non-null
- [ ] **config.js**: Remove `theme` and `refreshMs` from defaults object. Remove `theme` from the merge logic (line 51)

## Test Checklist

- [ ] Unit: post-install generates valid scrypt hash format (`scrypt:<hex-salt>:<hex-hash>`)
- [ ] Unit: post-install config has `auth.enabled: true` and no unused fields
- [ ] Unit: generated password is verifiable with auth.js `verifyPassword` (or equivalent check)
- [ ] Manual: run post-install.js with no existing config.json → verify output contains plaintext password, config.json has correct structure
- [ ] Manual: run post-install.js with existing config.json → verify it does NOT overwrite (existing guard at line 16)
- [ ] Manual: set `ingestToken` in config.json, send a test POST to `/api/ingest` without header → 403; with correct header → 200
- [ ] `npm test` passes

## Acceptance Checklist

- [ ] Fresh install produces a working, password-protected dashboard
- [ ] Plaintext password is printed to console during install
- [ ] Config.json contains only meaningful fields (no theme, refreshMs, retention.*)
- [ ] hook-ingest.cjs sends Authorization header when ingestToken is configured
- [ ] Existing installs with config.json are not affected (no overwrite)
- [ ] No regressions: `npm test` passes
