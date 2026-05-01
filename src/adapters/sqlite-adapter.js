import fs from 'node:fs';
import path from 'node:path';
import { querySqlite } from '../lib/sqlite-cli.js';
import { ok, unavailable } from '../lib/result.js';

const SUPPORTED = new Set(['messages', 'scheduled_tasks']);

export class SQLiteAdapter {
  constructor(config) {
    this.name = 'sqlite';
    this.config = config;
    this.c4Db = path.join(config.zylosDir, 'comm-bridge', 'c4.db');
    this.schedulerDb = path.join(config.zylosDir, 'scheduler', 'scheduler.db');
  }

  supports(metric) {
    return SUPPORTED.has(metric);
  }

  async resolve(metric) {
    if (metric === 'messages') return this.messages(metric);
    if (metric === 'scheduled_tasks') return this.scheduledTasks(metric);
    return unavailable({ metric, source: this.name, reason: 'unsupported_metric' });
  }

  async messages(metric) {
    if (!fs.existsSync(this.c4Db)) return unavailable({ metric, source: this.name, reason: 'missing_c4_db' });
    const totals = await querySqlite(this.c4Db, `
      SELECT direction, channel, status, COUNT(*) AS count
      FROM conversations
      WHERE timestamp >= datetime('now', '-7 days')
      GROUP BY direction, channel, status
      ORDER BY count DESC
    `);
    const recent = await querySqlite(this.c4Db, `
      SELECT id, timestamp, direction, channel, status, priority
      FROM conversations
      ORDER BY id DESC
      LIMIT 25
    `);
    if (!totals.ok) return unavailable({ metric, source: this.name, availability: 'error', reason: totals.error });
    return ok({
      metric,
      source: this.name,
      updatedAt: new Date().toISOString(),
      value: {
        totals: totals.rows,
        recent: recent.rows || []
      }
    });
  }

  async scheduledTasks(metric) {
    if (!fs.existsSync(this.schedulerDb)) return unavailable({ metric, source: this.name, reason: 'missing_scheduler_db' });
    const totals = await querySqlite(this.schedulerDb, `
      SELECT status, type, COUNT(*) AS count
      FROM tasks
      GROUP BY status, type
      ORDER BY status, type
    `);
    const upcoming = await querySqlite(this.schedulerDb, `
      SELECT id, name, type, status, next_run_at, last_run_at, priority
      FROM tasks
      ORDER BY next_run_at ASC
      LIMIT 25
    `);
    const history = await querySqlite(this.schedulerDb, `
      SELECT status, COUNT(*) AS count
      FROM task_history
      WHERE executed_at >= strftime('%s','now','-7 days')
      GROUP BY status
      ORDER BY status
    `);
    if (!totals.ok) return unavailable({ metric, source: this.name, availability: 'error', reason: totals.error });
    return ok({
      metric,
      source: this.name,
      updatedAt: new Date().toISOString(),
      value: {
        totals: totals.rows,
        upcoming: upcoming.rows || [],
        history: history.rows || []
      }
    });
  }

  async health() {
    return {
      source: this.name,
      ok: fs.existsSync(this.c4Db) || fs.existsSync(this.schedulerDb),
      detail: {
        c4Db: fs.existsSync(this.c4Db),
        schedulerDb: fs.existsSync(this.schedulerDb)
      }
    };
  }
}
