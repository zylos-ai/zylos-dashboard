# Dev Plan: Track latest Codex CLI version in dashboard (#150)

## Summary

Add latest-available Codex CLI version tracking so the dashboard can show when an update is available, matching the existing Claude Code upgrade badge pattern.

## Scope

**In scope:**
- Fetch latest Codex CLI version from npm registry
- Compare installed vs latest, expose `codex_update` field in runtime info
- Show upgrade indicator in info bar and actions modal for Codex runtime
- Timeout/error handling — never block dashboard startup

**Out of scope:**
- Codex installed vs running version distinction (Issue #151)
- Homebrew/GitHub fallback sources (npm is the canonical install path via `codex update`)

## Development Checklist

- [ ] **VersionChecker: add npm registry fetch** — Add `fetchNpmLatest(pkg)` function that fetches `https://registry.npmjs.org/@openai/codex/latest` and extracts the `version` field. Use Node `https` module (same pattern as existing `fetchLatestTag`). 15s timeout.
- [ ] **VersionChecker: store codex latest** — Add `codex` field to `this._latest`. Call `fetchNpmLatest` in `check()` alongside existing GitHub fetches via `Promise.allSettled`.
- [ ] **buildRuntimeInfo: add codex_update** — In `src/index.js`, after the zylos_update block, add: if `latest.codex` and `codexInstalledVersion` and `isNewerVersion(latest.codex, codexInstalledVersion)`, set `info.codex_update = latest.codex`.
- [ ] **Frontend info bar: codex upgrade badge** — In `public/js/app.js` line ~231, when rendering `Codex vX.Y.Z`, append the `↑newVersion` span when `ri.codex_update` is set (same markup as `cc_update`).
- [ ] **Frontend actions modal: codex version dot** — In line ~1952, enable the `action-ver-dot` class for Codex runtime when `ri.codex_update` is set. Show the version and title tooltip.
- [ ] **Cache bust** — Bump `app.js?v=16` → `?v=17`.

## Test Checklist

- [ ] **VersionChecker unit test**: mock npm registry response, verify `getLatest().codex` is populated
- [ ] **VersionChecker timeout/error**: verify graceful handling when npm registry is unreachable
- [ ] **buildRuntimeInfo test**: verify `codex_update` is set when latest > installed, absent when equal/unavailable
- [ ] **Existing tests**: `npm test` still passes (no regressions)

## Assumptions

- npm registry `https://registry.npmjs.org/@openai/codex/latest` returns JSON with a `version` field (string) — this is the standard npm registry API, guaranteed by npm.
- `codexInstalledVersion` is already parsed and available from `codex --version` output — confirmed in existing code (`src/index.js:53-54`).
- `isNewerVersion()` works with npm semver strings — confirmed, it's already used for Claude Code versions which follow the same format.

## Acceptance Checklist

- [ ] `npm run check` passes
- [ ] `npm test` passes with new tests
- [ ] `npm run smoke:api` passes
- [ ] No regressions in Claude runtime version checking
- [ ] `codex_update` field appears in runtime_info when latest > installed
- [ ] Frontend shows upgrade badge for Codex version (info bar + actions modal dot)
