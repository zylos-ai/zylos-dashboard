---
name: dashboard
version: 0.1.0
description: Read-only Zylos observability dashboard for agent state, costs, tools, communication, scheduler, and PM2 service health.
type: capability

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-dashboard
    entry: src/index.js
  data_dir: ~/zylos/components/dashboard
  hooks:
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - dashboard.db

http_routes:
  - path: /dashboard/*
    type: reverse_proxy
    target: localhost:3470
    strip_prefix: /dashboard

config:
  required: []
  optional:
    - name: DASHBOARD_PORT
      description: Dashboard server port
      default: "3470"
    - name: DASHBOARD_THEME
      description: Default theme name
      default: "default"

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
