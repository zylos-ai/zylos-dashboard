# Zylos Dashboard

Read-only observability dashboard for a local Zylos agent.

## Run Locally

```bash
npm start
```

Open `http://127.0.0.1:3470/`.

## Data Sources

- `~/zylos/activity-monitor/*.json`
- `~/zylos/activity-monitor/*.jsonl`
- `~/zylos/comm-bridge/c4.db`
- `~/zylos/scheduler/scheduler.db`
- `pm2 jlist`

The dashboard reads these sources only. It does not mutate upstream databases,
configuration, or runtime services.
