import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

function unknownStatus() {
  return {
    pending: null,
    paused: null,
    running: null,
    outcome_failed: null,
    latest_failure_at: null,
    overdue: null,
    health: 'unknown',
    upcoming: []
  };
}

/**
 * Read scheduler lifecycle and outcome health without exposing task content.
 */
export function readSchedulerStatus(
  zylosDir,
  { currentTime = Math.floor(Date.now() / 1000) } = {}
) {
  const dbFile = path.join(zylosDir, 'scheduler', 'scheduler.db');
  if (!fs.existsSync(dbFile)) return unknownStatus();

  let db;
  try {
    db = new Database(dbFile, { readonly: true });
    db.pragma('busy_timeout = 3000');

    const migration = db.prepare(`
      SELECT 1 FROM system_state
      WHERE key = 'scheduler_run_outcome_v1'
    `).get();
    if (!migration) return unknownStatus();

    const counts = db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM tasks
      WHERE status IN ('pending', 'paused', 'running')
      GROUP BY status
    `).all();
    const outcomes = db.prepare(`
      SELECT
        COUNT(*) FILTER (
          WHERE status IN ('pending', 'running') AND failed_at IS NOT NULL
        ) AS outcome_failed,
        MAX(failed_at) FILTER (
          WHERE status IN ('pending', 'running')
        ) AS latest_failure_at,
        COUNT(*) FILTER (
          WHERE status = 'pending'
            AND next_run_at + COALESCE(miss_threshold, 300) < ?
        ) AS overdue
      FROM tasks
    `).get(currentTime);
    const upcoming = db.prepare(`
      SELECT id, next_run_at
      FROM tasks
      WHERE status = 'pending'
      ORDER BY next_run_at ASC
      LIMIT 5
    `).all();

    const result = {
      pending: 0,
      paused: 0,
      running: 0,
      outcome_failed: outcomes.outcome_failed,
      latest_failure_at: outcomes.latest_failure_at,
      overdue: outcomes.overdue,
      health: outcomes.outcome_failed > 0 || outcomes.overdue > 0 ? 'degraded' : 'healthy',
      upcoming: upcoming.map((task) => ({
        id: task.id,
        run_at: new Date(task.next_run_at * 1000).toISOString()
      }))
    };
    for (const row of counts) result[row.status] = row.count;
    return result;
  } catch {
    return unknownStatus();
  } finally {
    db?.close();
  }
}
