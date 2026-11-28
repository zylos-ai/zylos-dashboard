# zylos-dashboard Development Guide

This document guides AI assistants working on the zylos-dashboard component.

## Project Conventions

- **ESM only** — `import`/`export`, never `require()`. `"type": "module"` in package.json. Exception: `ecosystem.config.cjs` (PM2 requires CJS) and `src/lib/hook-ingest.cjs` (standalone Claude Code hook — must use only Node built-ins, no ESM setup, 500ms deadline)
- **Node.js 20+** — Minimum runtime version
- **Conventional commits** — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- **All config in `config.json`** — Runtime config lives in `~/zylos/components/dashboard/config.json` (data directory, never committed)
- **English for code** — Comments, commit messages, PR descriptions, documentation

## Architecture

### Backend (`src/`)

| File | Purpose |
|------|---------|
| `index.js` | Entry point — wires collectors, HTTP, SSE, spool drainer |
| `lib/store.js` | SQLite DB with incremental migrations (`schema_migrations` table) |
| `lib/state-engine.js` | Infers agent state (idle/busy/stuck/waiting) from events |
| `lib/http.js` | HTTP server — API routes, static files, auth middleware |
| `lib/sse.js` | Server-Sent Events for live dashboard updates |
| `lib/auth.js` | Cookie-based auth with scrypt hashing, rate limiting, lockout |
| `lib/config.js` | Loads and validates `config.json` |
| `lib/actions.js` | Actions modal endpoints (runtime switch, model change, etc.) |
| `lib/hook-ingest.cjs` | CJS hook for Claude Code — posts tool/event data to dashboard (500ms deadline, Node built-ins only) |
| `lib/hook-installer.js` | Injects/removes dashboard hooks into Claude Code `settings.json` |
| `lib/ingest-handler.js` | HTTP handler for hook event ingestion with security gates |
| `lib/spool-drainer.js` | Replays spooled events when dashboard restarts |
| `lib/metric-resolver.js` | Resolves metrics from multiple sources with confidence levels |
| `lib/c4-reader.js` | Reads C4 communication bridge data |
| `lib/sanitizer.js` | Strips sensitive data from tool output before storage |

### Collectors (`src/lib/collectors/`)

| Collector | Data source | Runtime |
|-----------|-------------|---------|
| `statusline-collector.js` | `activity-monitor/statusline.json` (fs.watch) | All |
| `system-collector.js` | `os.cpus()`, `os.totalmem()`, `vm_stat` (macOS), `fs.statfsSync` | All |
| `pm2-collector.js` | PM2 programmatic API | All |
| `conversation-collector.js` | Hook events (assistant text messages) | Claude |

### Frontend (`public/`)

| File | Purpose |
|------|---------|
| `index.html` | Single-page app shell |
| `js/app.js` | Main UI — SSE, DOM updates, modals, charts (vanilla JS, no framework) |
| `js/i18n.js` | Bilingual strings (EN/ZH), locale toggle |
| `js/gauge-utils.js` | Shared gauge display logic (production + test) |
| `css/style.css` | Main stylesheet |
| `themes/light.css` | Light theme overrides |

### Lifecycle Hooks (`hooks/`)

| Hook | When | Purpose |
|------|------|---------|
| `post-install.js` | After `zylos add` | Create data dir, generate auth password, inject Claude hooks |
| `pre-upgrade.js` | Before `zylos upgrade` | Backup config |
| `post-upgrade.js` | After `zylos upgrade` | Migrate config schema |
| `pre-uninstall.js` | Before `zylos remove` | Remove Claude hooks from settings.json |
| `configure.js` | `zylos configure dashboard` | Set password, toggle auth |

## Key Constraints

- **hook-ingest.cjs** must use only Node built-ins (no imports from node_modules). It runs as a Claude Code hook with a 500ms deadline. Must be CJS, not ESM.
- **Frontend is vanilla JS** — no build step, no framework, no bundler. `app.js` uses cache-busting via query string (`?v=N`). Bump the version after any frontend change.
- **DB migrations are incremental** — each migration checks `currentVersion < N` and is idempotent. Never modify existing migrations; only append new ones.
- **macOS vs Linux** — `system-collector.js` uses `vm_stat` on macOS for accurate memory reporting. Test on both platforms when changing system metrics.
- **Agent runtime adapters** — Shared code uses adapter interfaces and
  capabilities. Keep runtime tool names, file locations, event formats, and
  prompts inside the relevant adapter. Use server-derived capabilities to
  decide which features to show in the frontend.

## Testing

```bash
npm run check      # Syntax check all JS/CJS files
npm test           # Unit tests (node --test)
npm run smoke      # Start server, verify health, exit
npm run smoke:api  # API endpoint smoke test
```

Tests live in `test/`. Use `node:test` and `node:assert/strict`. Shared logic (like `gauge-utils.js`) must be imported by both production code and tests — never duplicate logic.

Run integration tests and their services under a dedicated system user with
isolated `HOME`, `ZYLOS_DIR`, `PM2_HOME`, and a short `TMPDIR`. Use a private
tmux socket and a dedicated test database. Before running, verify the resolved
paths and actual targets, and set a time limit. Default to `TZ=Asia/Singapore`.
Tests specifically covering timezones may select the timezone they need. Stop
test services and verify that their processes have exited before cleanup.

## Release Process

When releasing a new version, **all four files** must be updated in the same commit:

1. **`package.json`** — Bump `version` field
2. **`package-lock.json`** — Run `npm install` after bumping package.json to sync the lock file
3. **`SKILL.md`** — Update `version` in YAML frontmatter to match package.json
4. **`CHANGELOG.md`** — Add new version entry following [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format

Version bump commit message: `chore: bump version to X.Y.Z`

After merge, create a GitHub Release with tag `vX.Y.Z` from the merge commit.

## Directory Convention

```
Code:    ~/zylos/.claude/skills/dashboard/    # Overwritten on upgrade
Data:    ~/zylos/components/dashboard/         # Preserved across upgrades
```

**Code is disposable, data is permanent.** Never store user data in the skills directory.
