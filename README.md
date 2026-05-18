<p align="center">
  <img src="https://zylos.ai/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-dashboard</h1>

<p align="center">
  Read-only observability dashboard for Zylos AI agents.
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node.js"></a>
  <a href="https://discord.gg/GS2J39EGff"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://x.com/ZylosAI"><img src="https://img.shields.io/badge/X-follow-000000?logo=x&logoColor=white" alt="X"></a>
  <a href="https://zylos.ai"><img src="https://img.shields.io/badge/website-zylos.ai-blue" alt="Website"></a>
  <a href="https://coco.xyz"><img src="https://img.shields.io/badge/Built%20by-Coco-orange" alt="Built by Coco"></a>
</p>

---

- **Real-time agent state** — idle, busy, stuck, waiting detection with tool activity feed
- **Capacity & cost tracking** — context usage, rate limits, session/daily/weekly cost
- **Actions modal** — runtime switch, model/effort change, threshold, zylos/CC upgrade
- **Full i18n** — English + Chinese with locale toggle
- **Codex compatible** — PM2, system health, communication, scheduler on all runtimes

## Install

```bash
zylos add dashboard
```

Or manually:

```bash
cd ~/zylos/.claude/skills
git clone https://github.com/zylos-ai/zylos-dashboard.git dashboard
cd dashboard && npm install
```

After install, restart the agent session to activate hooks.

## Configuration

All config lives in `~/zylos/components/dashboard/config.json`.

| Field | Default | Description |
|-------|---------|-------------|
| `port` | `3470` | Server port |
| `host` | `127.0.0.1` | Bind address |
| `ingestToken` | `null` | Bearer token for ingest API (optional defense-in-depth) |
| `auth.enabled` | `true` | Password authentication (enabled by default) |
| `auth.password` | auto-generated | Scrypt-hashed password |

On first install, a random password is generated and printed to the console:

```
Dashboard password: <hex string>
Save this — it won't be shown again.
```

## Access

The dashboard is served at `/dashboard/` through the Caddy reverse proxy:

```
https://<your-host>/dashboard/
```

## Architecture

```
Claude Code hooks --> hook-ingest.cjs --> /api/ingest --> SQLite DB
                                                             |
statusline.json (core) --> StatuslineCollector ---------------+
                                                             |
PM2 / System collectors ------------------------------------- +
                                                             v
                                                    State Engine --> SSE --> Browser
```

Data flows:
- **Hook events**: Claude Code hook scripts POST to `/api/ingest` (with offline spool fallback)
- **Metrics**: StatuslineCollector reads core's `statusline.json` via file polling
- **System**: PM2 and system collectors poll at intervals
- **Frontend**: SSE stream with polling fallback; i18n via JSON locale files

## Development

```bash
npm start          # Start server
npm test           # Run tests
npm run check      # Syntax check all files
npm run smoke      # Smoke test (start + verify)
```

## License

[MIT](./LICENSE)
