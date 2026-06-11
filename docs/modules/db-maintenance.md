# Dashboard DB Maintenance

`dashboard.db` uses SQLite. Retention deletes old metric rows, but SQLite does not shrink the database file until `VACUUM` rewrites it.

## Automatic Maintenance

The dashboard runs hourly retention cleanup:

- `usage_event`: 90 days
- `ttft%` and `turn_duration%`: 90 days
- `statusline_summary`: 30 days
- `system_summary`: 14 days
- `pm2_summary` and legacy `pm2_%`: 7 days
- `otel_*` sources: preserved (sample data for future use)
- other legacy metrics: 90 days

Automatic `VACUUM` is guarded. It runs only when the database file is smaller than 2 GB. Larger databases are skipped and require manual compaction during a maintenance window.

## Manual Compaction For Large Databases

Use this for already-bloated databases after retention has removed old rows.

1. Check free disk. `VACUUM` rewrites the database and can temporarily need free space roughly equal to the database size.

   ```bash
   df -h ~/zylos
   ls -lh ~/zylos/components/dashboard/dashboard.db
   ```

2. Stop the dashboard so no live writes compete with the exclusive SQLite lock.

   ```bash
   pm2 stop zylos-dashboard
   ```

3. Take a rollback backup before rewriting the file.

   ```bash
   cp ~/zylos/components/dashboard/dashboard.db ~/zylos/components/dashboard/dashboard.db.bak
   cp ~/zylos/components/dashboard/dashboard.db-wal ~/zylos/components/dashboard/dashboard.db-wal.bak 2>/dev/null || true
   cp ~/zylos/components/dashboard/dashboard.db-shm ~/zylos/components/dashboard/dashboard.db-shm.bak 2>/dev/null || true
   ```

4. Compact the database.

   ```bash
   sqlite3 ~/zylos/components/dashboard/dashboard.db "VACUUM; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;"
   ```

5. Restart and validate.

   ```bash
   pm2 start zylos-dashboard
   npm run smoke:api
   ```

6. If validation fails, stop the dashboard, restore the `.bak` files, then start it again.

   ```bash
   pm2 stop zylos-dashboard
   cp ~/zylos/components/dashboard/dashboard.db.bak ~/zylos/components/dashboard/dashboard.db
   cp ~/zylos/components/dashboard/dashboard.db-wal.bak ~/zylos/components/dashboard/dashboard.db-wal 2>/dev/null || true
   cp ~/zylos/components/dashboard/dashboard.db-shm.bak ~/zylos/components/dashboard/dashboard.db-shm 2>/dev/null || true
   pm2 start zylos-dashboard
   ```
