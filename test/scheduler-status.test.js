import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { readSchedulerStatus } from '../src/lib/scheduler-status.js';

function withSchedulerDb(fn, { migrationApplied = true } = {}) {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-scheduler-'));
  const schedulerDir = path.join(zylosDir, 'scheduler');
  fs.mkdirSync(schedulerDir);
  const db = new Database(path.join(schedulerDir, 'scheduler.db'));
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      next_run_at INTEGER NOT NULL,
      miss_threshold INTEGER,
      failed_at INTEGER,
      last_error TEXT
    );
    CREATE TABLE system_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER
    );
  `);
  if (migrationApplied) {
    db.prepare(`
      INSERT INTO system_state (key, value, updated_at)
      VALUES ('scheduler_run_outcome_v1', '{}', 1)
    `).run();
  }
  try {
    return fn({ zylosDir, db });
  } finally {
    db.close();
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
}

test('scheduler status degrades for a retryable task with an uncleared failure outcome', () => {
  withSchedulerDb(({ zylosDir, db }) => {
    const currentTime = 1_800_000_000;
    db.prepare(`
      INSERT INTO tasks (
        id, name, prompt, status, next_run_at, miss_threshold, failed_at, last_error
      ) VALUES (?, ?, ?, 'pending', ?, 300, ?, ?)
    `).run(
      'task-visible-failure',
      'private task name',
      'private task prompt',
      currentTime + 600,
      currentTime - 60,
      'private raw error'
    );

    const status = readSchedulerStatus(zylosDir, { currentTime });

    assert.deepEqual(status, {
      pending: 1,
      paused: 0,
      running: 0,
      outcome_failed: 1,
      latest_failure_at: currentTime - 60,
      overdue: 0,
      health: 'degraded',
      upcoming: [{
        id: 'task-visible-failure',
        run_at: new Date((currentTime + 600) * 1000).toISOString()
      }]
    });
    assert.doesNotMatch(JSON.stringify(status), /private task name|private task prompt|private raw error/);
  });
});

test('scheduler status is healthy after the failure outcome is cleared', () => {
  withSchedulerDb(({ zylosDir, db }) => {
    const currentTime = 1_800_000_000;
    db.prepare(`
      INSERT INTO tasks (
        id, name, prompt, status, next_run_at, miss_threshold, failed_at, last_error
      ) VALUES ('task-recovered', 'private', 'private', 'pending', ?, 300, NULL, NULL)
    `).run(currentTime + 600);

    const status = readSchedulerStatus(zylosDir, { currentTime });

    assert.equal(status.health, 'healthy');
    assert.equal(status.outcome_failed, 0);
    assert.equal(status.latest_failure_at, null);
    assert.equal(status.overdue, 0);
  });
});

test('scheduler health ignores historical outcomes on paused and terminal tasks', () => {
  withSchedulerDb(({ zylosDir, db }) => {
    const currentTime = 1_800_000_000;
    const insert = db.prepare(`
      INSERT INTO tasks (
        id, name, prompt, status, next_run_at, miss_threshold, failed_at, last_error
      ) VALUES (?, 'private', 'private', ?, ?, 300, ?, 'historical error')
    `);
    insert.run('task-paused-history', 'paused', currentTime + 600, currentTime - 60);
    insert.run('task-completed-history', 'completed', currentTime + 600, currentTime - 50);
    insert.run('task-failed-history', 'failed', currentTime + 600, currentTime - 40);

    const status = readSchedulerStatus(zylosDir, { currentTime });

    assert.equal(status.paused, 1);
    assert.equal(status.outcome_failed, 0);
    assert.equal(status.latest_failure_at, null);
    assert.equal(status.overdue, 0);
    assert.equal(status.health, 'healthy');
  });
});

test('scheduler status degrades for an overdue pending task without inventing a failed outcome', () => {
  withSchedulerDb(({ zylosDir, db }) => {
    const currentTime = 1_800_000_000;
    db.prepare(`
      INSERT INTO tasks (
        id, name, prompt, status, next_run_at, miss_threshold, failed_at, last_error
      ) VALUES ('task-overdue', 'private', 'private', 'pending', ?, 300, NULL, NULL)
    `).run(currentTime - 301);

    const status = readSchedulerStatus(zylosDir, { currentTime });

    assert.equal(status.health, 'degraded');
    assert.equal(status.overdue, 1);
    assert.equal(status.outcome_failed, 0);
    assert.equal(status.latest_failure_at, null);
  });
});

test('scheduler status honors a zero missed-run window', () => {
  withSchedulerDb(({ zylosDir, db }) => {
    const currentTime = 1_800_000_000;
    db.prepare(`
      INSERT INTO tasks (
        id, name, prompt, status, next_run_at, miss_threshold, failed_at, last_error
      ) VALUES ('task-zero-window', 'private', 'private', 'pending', ?, 0, NULL, NULL)
    `).run(currentTime - 1);

    const status = readSchedulerStatus(zylosDir, { currentTime });

    assert.equal(status.health, 'degraded');
    assert.equal(status.overdue, 1);
    assert.equal(status.outcome_failed, 0);
  });
});

test('scheduler status reports unknown when its source is unavailable', () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-scheduler-missing-'));
  try {
    assert.deepEqual(readSchedulerStatus(zylosDir), {
      pending: null,
      paused: null,
      running: null,
      outcome_failed: null,
      latest_failure_at: null,
      overdue: null,
      health: 'unknown',
      upcoming: []
    });
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('scheduler status reports unknown until legacy outcomes are migrated', () => {
  withSchedulerDb(({ zylosDir, db }) => {
    const currentTime = 1_800_000_000;
    db.prepare(`
      INSERT INTO tasks (
        id, name, prompt, status, next_run_at, miss_threshold, failed_at, last_error
      ) VALUES ('task-legacy-timeout', 'private', 'private', 'pending', ?, 300, NULL, 'Task timed out')
    `).run(currentTime + 600);

    assert.deepEqual(readSchedulerStatus(zylosDir, { currentTime }), {
      pending: null,
      paused: null,
      running: null,
      outcome_failed: null,
      latest_failure_at: null,
      overdue: null,
      health: 'unknown',
      upcoming: []
    });
  }, { migrationApplied: false });
});
