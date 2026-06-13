---
name: dashboard
version: 0.5.1
description: Read-only Zylos observability dashboard for agent state, costs, tools, communication, scheduler, and PM2 service health. Full features on Claude runtime. PM2, system health, communication, and scheduler monitoring on all runtimes.
type: capability

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-dashboard
    entry: src/index.js
  data_dir: ~/zylos/components/dashboard
  hooks:
    configure: hooks/configure.js
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
    pre-uninstall: hooks/pre-uninstall.js
  preserve:
    - config.json
    - dashboard.db
    - spool/
    - backups/
  next-steps: "Restart agent session to activate dashboard hooks. After uninstall, restart again to remove stale hooks."

http_routes:
  - path: /dashboard/*
    type: reverse_proxy
    target: 127.0.0.1:3470
    strip_prefix: /dashboard

config:
  required: []
  optional:
    - name: DASHBOARD_PORT
      description: Dashboard server port
      default: "3470"
    - name: DASHBOARD_HOST
      description: Dashboard bind address
      default: "127.0.0.1"
    - name: DASHBOARD_INGEST_TOKEN
      description: Optional bearer token for /api/ingest endpoint (defense-in-depth, not required — localhost restriction is the primary guard)
      sensitive: true
    - name: DASHBOARD_AUTH_PASSWORD
      description: Dashboard login password (auto-generated on first install, printed to console)
      sensitive: true
    - name: DASHBOARD_SPOOL_MAX_BYTES
      description: Maximum spool file size before dropping events
      default: "10485760"

upgrade:
  repo: zylos-ai/zylos-dashboard
  branch: main

dependencies: []
---

# Zylos Dashboard

Read-only observability dashboard for a local Zylos agent.

```bash
npm start
```

Default URL: `http://127.0.0.1:3470/`
