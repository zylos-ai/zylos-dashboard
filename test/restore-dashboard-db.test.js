import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const SCRIPT = path.join(import.meta.dirname, '..', 'scripts', 'restore-dashboard-db.js');

/**
 * A WAL-mode database with one usage row, an online backup of that state, and a
 * second row written afterwards that is still sitting in the WAL because a
 * connection is deliberately left open — which is what the running dashboard
 * service does. `db` must be closed by the caller: closing it checkpoints the
 * WAL, and a checkpointed WAL is precisely the situation where the bug does not
 * reproduce.
 */
function scenario() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-test-'));
  const dbPath = path.join(dir, 'dashboard.db');
  const backupPath = path.join(dir, 'dashboard.db.bak');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE metric_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      runtime TEXT NOT NULL DEFAULT 'claude',
      session_id TEXT,
      metric_name TEXT NOT NULL,
      metric_value REAL NOT NULL,
      dimensions TEXT,
      source TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'actual'
    );
  `);
  const insert = db.prepare(`
    INSERT INTO metric_points (timestamp, metric_name, metric_value, dimensions, source)
    VALUES (?, 'usage_event', 1, ?, 'jsonl_usage')
  `);
  insert.run('2026-07-01T10:00:00.000Z', JSON.stringify({ marker: 'in-backup', cost: 1 }));

  return { dir, dbPath, backupPath, db, insert };
}

function rowMarkers(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const markers = db.prepare('SELECT dimensions FROM metric_points ORDER BY id')
    .all()
    .map((r) => JSON.parse(r.dimensions).marker);
  db.close();
  return markers;
}

test('NEGATIVE CONTROL: a bare cp does not roll back a WAL database', async () => {
  // This is the failure the reviewed script's printed restore command produced.
  // Kept as a test so nobody reintroduces a cp-based restore believing it works.
  const { dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));

  assert.ok(fs.statSync(`${dbPath}-wal`).size > 0, 'the WAL must be non-empty for this to be the real scenario');

  fs.copyFileSync(backupPath, dbPath); // the bare cp, with the service still holding the DB
  db.close();

  assert.deepEqual(
    rowMarkers(dbPath),
    ['in-backup', 'after-backup'],
    'the stale WAL is replayed, so the post-backup row is still there: the cp silently did nothing'
  );
});

test('the restore script does roll back a WAL database, and verifies it', async () => {
  const { dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  assert.ok(fs.statSync(`${dbPath}-wal`).size > 0);
  db.close(); // stand in for "the service was stopped", which --assume-stopped asserts

  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--assume-stopped'
  ], { encoding: 'utf8' });

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /verified: the database now matches the backup exactly/);
  assert.deepEqual(rowMarkers(dbPath), ['in-backup'], 'only the backup state survives');
  assert.ok(!fs.existsSync(`${dbPath}-wal`) || fs.statSync(`${dbPath}-wal`).size === 0,
    'no stale WAL is left behind to be replayed');
});

test('the restore leaves the pre-restore state recoverable', async () => {
  const { dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--assume-stopped'
  ], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);

  const aside = res.stdout.match(/pre-restore copy: (\S+)/);
  assert.ok(aside, 'the script must report where it put the pre-restore copy');
  assert.deepEqual(
    rowMarkers(aside[1]),
    ['in-backup', 'after-backup'],
    'the set-aside copy holds the full pre-restore state, so a wrong restore is reversible'
  );
});

test('refuses to restore when neither --service nor --assume-stopped is given', async () => {
  const { dbPath, backupPath, db } = scenario();
  await db.backup(backupPath);
  db.close();

  const res = spawnSync(process.execPath, [SCRIPT, '--db', dbPath, '--backup', backupPath], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Refusing to restore without knowing the database is closed/);
});

test('--dry-run reports the stale WAL and changes nothing', async () => {
  const { dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  const before = fs.readFileSync(dbPath);
  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--assume-stopped', '--dry-run'
  ], { encoding: 'utf8' });

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /DRY RUN/);
  assert.deepEqual(fs.readFileSync(dbPath), before, 'dry run must not touch the database');
});

test('refuses a corrupt backup instead of destroying the live database with it', async () => {
  const { dbPath, backupPath, db } = scenario();
  await db.backup(backupPath);
  db.close();
  fs.writeFileSync(backupPath, Buffer.from('not a sqlite file at all'));

  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--assume-stopped'
  ], { encoding: 'utf8' });

  assert.notEqual(res.status, 0);
  assert.deepEqual(rowMarkers(dbPath), ['in-backup'], 'the live database is left intact');
});
