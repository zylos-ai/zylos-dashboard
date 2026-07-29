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
  assert.match(res.stdout, /the file is byte-identical \(sha256\) to the backup as inspected at the start/);
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

// --- Service-manager boundary and fail-safe behaviour ------------------------
// These three cases exist because the corresponding claims cannot be settled by
// reading the script: "it does not touch pm2", "it will not serve an unverified
// database", and "the verification actually compares the approved bytes" are
// statements about behaviour under failure, so they are exercised rather than
// asserted in prose.

/**
 * A stand-in `pm2` placed first on PATH. Every invocation is appended to a log,
 * so a test can prove not only what the script did to the service manager but
 * also what it never did. Optionally swaps the backup out from under the script
 * on `stop`, to simulate the backup changing after it was inspected.
 */
function fakePm2({ tamperFrom, tamperTo } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pm2-'));
  const log = path.join(dir, 'pm2-invocations.log');
  const bin = path.join(dir, 'pm2');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    `echo "$@" >> "${log}"`,
    ...(tamperFrom ? [`if [ "$1" = "stop" ]; then cp "${tamperFrom}" "${tamperTo}"; fi`] : []),
    'exit 0'
  ].join('\n') + '\n');
  fs.chmodSync(bin, 0o755);
  return { dir, log, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } };
}

const pm2Calls = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);

test('--assume-stopped does not touch the service manager at all', async () => {
  const { dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  const pm2 = fakePm2();
  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--assume-stopped'
  ], { encoding: 'utf8', env: pm2.env });

  assert.equal(res.status, 0, res.stderr);
  // The assertion that matters: --assume-stopped means the caller owns the
  // service lifecycle, so the script must neither stop nor start anything. A
  // fake pm2 that was never called leaves no log file behind.
  assert.deepEqual(pm2Calls(pm2.log), [],
    '--assume-stopped must not invoke pm2 — not to stop, and not to restart');
});

test('NEGATIVE CONTROL: verification fails when the backup changed after it was inspected, and the service is left down', async () => {
  const { dir, dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  // A different backup with the SAME usage row count and the SAME cost total, so
  // the row/cost comparison alone cannot tell it apart — only comparing against
  // the bytes that were actually inspected catches this.
  const tampered = path.join(dir, 'tampered.db');
  const t = new Database(tampered);
  t.exec(`
    CREATE TABLE metric_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
      runtime TEXT NOT NULL DEFAULT 'claude', session_id TEXT, metric_name TEXT NOT NULL,
      metric_value REAL NOT NULL, dimensions TEXT, source TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'actual'
    );
  `);
  t.prepare(`INSERT INTO metric_points (timestamp, metric_name, metric_value, dimensions, source)
             VALUES (?, 'usage_event', 1, ?, 'jsonl_usage')`)
    .run('2026-07-01T10:00:00.000Z', JSON.stringify({ marker: 'tampered', cost: 1 }));
  t.close();

  const pm2 = fakePm2({ tamperFrom: tampered, tamperTo: backupPath });
  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--service', 'zylos-dashboard'
  ], { encoding: 'utf8', env: pm2.env });

  assert.notEqual(res.status, 0, 'a failed verification must not exit 0');
  assert.match(res.stderr, /RESTORE VERIFICATION FAILED/);
  assert.match(res.stderr, /bytes on disk differ from the backup that was inspected at the start/);

  // Row count and cost matched, so this is exactly the case the previous
  // comparison would have waved through.
  assert.match(res.stdout, /restored contents: 1 usage rows, cost \$1/);

  // Fail-safe: stopped, never started again with a database that did not verify.
  const calls = pm2Calls(pm2.log);
  assert.deepEqual(calls, ['stop zylos-dashboard'],
    'the service must be stopped and then NOT started while the DB is unverified');
  assert.match(res.stderr, /still stopped and was deliberately NOT started/);

  // And the way back is named and intact.
  const aside = res.stdout.match(/pre-restore copy: (\S+)/);
  assert.ok(aside, 'the failure path must still name the pre-restore copy');
  assert.match(res.stderr, new RegExp(`Put the pre-restore copy back from: ${aside[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.deepEqual(rowMarkers(aside[1]), ['in-backup', 'after-backup'],
    'the pre-restore copy still holds the full original state');
});

test('NEGATIVE CONTROL: a failed copy leaves the service down and points at the pre-restore copy', async () => {
  const { dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  // The sidecars are removed before the copy, so a copy that fails leaves a
  // database that must not be served. Read-only target = a real ops case (a
  // root-owned DB file, the script run as someone else).
  fs.chmodSync(dbPath, 0o444);
  const pm2 = fakePm2();
  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--service', 'zylos-dashboard'
  ], { encoding: 'utf8', env: pm2.env });
  fs.chmodSync(dbPath, 0o644);

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Could not copy the backup into place/);
  assert.match(res.stderr, /must not be served as-is/);
  assert.match(res.stderr, /Restore the pre-restore copy from:/);
  assert.deepEqual(pm2Calls(pm2.log), ['stop zylos-dashboard'],
    'a failed copy must not be followed by a start');

  const aside = res.stdout.match(/pre-restore copy: (\S+)/);
  assert.ok(aside);
  assert.deepEqual(rowMarkers(aside[1]), ['in-backup', 'after-backup']);
});
