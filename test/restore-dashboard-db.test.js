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

/**
 * The on-disk state a killed service leaves behind: a main file plus a populated
 * -wal and -shm, with no process holding them. Produced by copying all three
 * sidecar-and-all out of a live database whose WAL has not been checkpointed,
 * which is what SIGKILL leaves on disk.
 *
 * This is the shape in which the difference between a byte copy and a SQLite copy
 * becomes visible at all — with a checkpointed WAL both look identical, which is
 * why a test built on a cleanly-closed database cannot see the bug.
 */
function killedServiceState() {
  const src = scenario();
  const backupPath = src.backupPath;
  return {
    async build() {
      await src.db.backup(backupPath);
      src.insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
      assert.ok(fs.statSync(`${src.dbPath}-wal`).size > 0,
        'the WAL must be non-empty, otherwise this is not the killed-service case');

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'killed-svc-'));
      const dbPath = path.join(dir, 'dashboard.db');
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(`${src.dbPath}${suffix}`)) {
          fs.copyFileSync(`${src.dbPath}${suffix}`, `${dbPath}${suffix}`);
        }
      }
      src.db.close(); // only the source is checkpointed; the copy keeps its WAL

      assert.ok(fs.statSync(`${dbPath}-wal`).size > 0, 'the copied state must still carry its WAL');
      return { dir, dbPath, backupPath };
    }
  };
}

/**
 * Read a database after moving ONLY its main file somewhere else, which is what
 * "self-contained" has to mean: no -wal, no -shm, nothing else alongside.
 *
 * Reading a file in place cannot establish this. A raw copy of a live WAL
 * database reads perfectly well while its sidecars sit beside it, and that is
 * exactly the false reassurance this helper exists to strip away.
 */
function markersOfMainFileAlone(file) {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'alone-'));
  const moved = path.join(fresh, 'alone.db');
  fs.copyFileSync(file, moved);
  return rowMarkers(moved);
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
  assert.match(res.stdout, /the database was built by SQLite from the backup/);
  assert.deepEqual(rowMarkers(dbPath), ['in-backup'], 'only the backup state survives');
  assert.ok(!fs.existsSync(`${dbPath}-wal`) || fs.statSync(`${dbPath}-wal`).size === 0,
    'no stale WAL is left behind to be replayed');
});

test('the pre-restore copy is self-contained, not a torn copy that only reads in place', async () => {
  // The predecessor of this test read the pre-restore copy where the script left
  // it, with its sidecars beside it. That passes for a raw byte copy too, so it
  // could not tell a recoverable copy from an unrecoverable one. Moving the main
  // file away from its sidecars is what makes the distinction observable.
  const { dbPath, backupPath } = await killedServiceState().build();

  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--assume-stopped'
  ], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);

  const aside = res.stdout.match(/pre-restore copy: (\S+)/);
  assert.ok(aside, 'the script must report where it put the pre-restore copy');
  assert.match(res.stdout, /self-contained single file/);

  for (const suffix of ['-wal', '-shm']) {
    assert.ok(!fs.existsSync(`${aside[1]}${suffix}`),
      `a self-contained copy must not need a ${suffix} beside it`);
  }
  assert.deepEqual(
    markersOfMainFileAlone(aside[1]),
    ['in-backup', 'after-backup'],
    'the full pre-restore state must survive the main file being moved on its own'
  );
});

test('ROUND TRIP: a restore can be undone from the copy it left behind, with a non-empty WAL', async () => {
  // The blocker this replaces: the pre-restore copy was a byte copy of a live WAL
  // database, so restoring FROM it dropped everything the -wal held and left the
  // database unreadable. "The restore is itself reversible" was the promise, and
  // only running the reversal proves it.
  const { dbPath, backupPath } = await killedServiceState().build();

  const first = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--assume-stopped'
  ], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(rowMarkers(dbPath), ['in-backup'], 'the first restore rolled back to the backup');

  const aside = first.stdout.match(/pre-restore copy: (\S+)/);
  assert.ok(aside);

  // Undo it from the pre-restore file MOVED ON ITS OWN. Restoring it where the
  // script left it would not settle anything: a torn copy still reads correctly
  // while its sidecars sit beside it, so the reversal would pass for a copy that
  // is not actually recoverable. Relocating the single file is also the real ops
  // case — the pre-restore copy gets moved off the box, or the directory is
  // cleaned up around it.
  const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'relocated-')), 'pre-restore.db');
  fs.copyFileSync(aside[1], elsewhere);

  const second = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', elsewhere, '--assume-stopped'
  ], { encoding: 'utf8' });

  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(
    rowMarkers(dbPath),
    ['in-backup', 'after-backup'],
    'restoring from the pre-restore copy must bring back the full pre-restore state'
  );
  assert.ok(!fs.existsSync(`${dbPath}-wal`) || fs.statSync(`${dbPath}-wal`).size === 0,
    'and must not leave a replayable WAL behind either');
});

test('restores the full state from a backup that carries its own WAL', async () => {
  // Not every file handed to --backup is an online backup with a checkpointed
  // WAL. An operator pointing at a copied-aside dashboard.db, or at the raw
  // fallback copy this script itself makes when the live database is unreadable,
  // supplies a main file whose newest committed rows are in a -wal beside it.
  // Copying such a file byte-wise restores the torn main file and discards those
  // rows; reading it through SQLite restores all of them.
  const source = await killedServiceState().build();

  // Use the killed-service trio itself as the backup: main + populated sidecars.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-backup-'));
  const dbPath = path.join(dir, 'dashboard.db');
  const walBackup = path.join(dir, 'carries-wal.db');
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(`${source.dbPath}${suffix}`)) {
      fs.copyFileSync(`${source.dbPath}${suffix}`, `${walBackup}${suffix}`);
    }
  }
  assert.ok(fs.statSync(`${walBackup}-wal`).size > 0, 'the backup must carry a non-empty WAL');

  // A live database to restore over, distinguishable from the backup's contents.
  const target = new Database(dbPath);
  target.pragma('journal_mode = WAL');
  target.exec('CREATE TABLE metric_points (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, runtime TEXT NOT NULL DEFAULT \'claude\', session_id TEXT, metric_name TEXT NOT NULL, metric_value REAL NOT NULL, dimensions TEXT, source TEXT NOT NULL, confidence TEXT NOT NULL DEFAULT \'actual\')');
  target.prepare('INSERT INTO metric_points (timestamp, metric_name, metric_value, dimensions, source) VALUES (?, \'usage_event\', 1, ?, \'jsonl_usage\')')
    .run('2026-07-01T12:00:00.000Z', JSON.stringify({ marker: 'to-be-replaced', cost: 9 }));
  target.close();

  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', walBackup, '--assume-stopped'
  ], { encoding: 'utf8' });

  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(
    rowMarkers(dbPath),
    ['in-backup', 'after-backup'],
    'the row that lived only in the backup\'s WAL must be restored, not dropped'
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
function fakePm2({ tamperFrom, tamperTo, onStop } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pm2-'));
  const log = path.join(dir, 'pm2-invocations.log');
  const bin = path.join(dir, 'pm2');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    `echo "$@" >> "${log}"`,
    ...(tamperFrom ? [`if [ "$1" = "stop" ]; then cp "${tamperFrom}" "${tamperTo}"; fi`] : []),
    ...(onStop ? [`if [ "$1" = "stop" ]; then ${onStop}; fi`] : []),
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

  assert.notEqual(res.status, 0, 'a swapped-out backup must not exit 0');
  assert.match(res.stderr, /BACKUP CHANGED AFTER INSPECTION/);
  assert.match(res.stderr, /inspected: [0-9a-f]{64}/);

  // The tampered file has the same row count and cost as the approved one, so
  // only comparing against the bytes that were actually inspected catches it.
  // The re-check now happens before the live database is touched, so unlike the
  // previous behaviour nothing is restored first and then found wanting.
  assert.match(res.stderr, /was NOT touched/);
  assert.deepEqual(rowMarkers(dbPath), ['in-backup', 'after-backup'],
    'the live database must be left exactly as it was');

  // Fail-safe: stopped, never started again with a restore that did not complete.
  const calls = pm2Calls(pm2.log);
  assert.deepEqual(calls, ['stop zylos-dashboard'],
    'the service must be stopped and then NOT started while the restore is unresolved');
  assert.match(res.stderr, /still stopped and was deliberately NOT started/);

  // And the way back is named and intact.
  const aside = res.stdout.match(/pre-restore copy: (\S+)/);
  assert.ok(aside, 'the failure path must still name the pre-restore copy');
  assert.deepEqual(markersOfMainFileAlone(aside[1]), ['in-backup', 'after-backup'],
    'the pre-restore copy still holds the full original state, on its own');
});

test('a read-only database file is replaced rather than written through', async () => {
  // This case used to be a failure: the restore wrote into dbPath directly, so a
  // read-only file (a root-owned DB, the script run as someone else) aborted it
  // mid-way with the sidecars already gone. The verified replacement is now
  // swapped in by rename, so the mode of the old file no longer decides whether a
  // restore can complete — the directory's permissions do, which is the honest
  // dependency. Kept as a test because "the swap does not write through the old
  // inode" is a statement about behaviour, not about the source.
  const { dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  fs.chmodSync(dbPath, 0o444);
  const pm2 = fakePm2();
  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--service', 'zylos-dashboard'
  ], { encoding: 'utf8', env: pm2.env });

  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(rowMarkers(dbPath), ['in-backup'], 'the restore completed');
  assert.deepEqual(pm2Calls(pm2.log), ['stop zylos-dashboard', 'start zylos-dashboard'],
    'a completed restore stops and then starts the service');
});

test('NEGATIVE CONTROL: a backup whose WAL changed is caught even though its main file bytes did not', async () => {
  // The limit of the SHA-256 check, made explicit. The hash covers the main file
  // only, so a backup whose newest rows arrive in its -wal has the same hash and
  // different contents. Nothing about comparing bytes can see that, which is why
  // the replacement is also compared logically against the survey taken at the
  // start — and why that comparison happens before anything is swapped in.
  const { dir, dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  const pristineMainBytes = fs.readFileSync(backupPath);

  // Build a -wal for the backup that adds a row, while leaving the backup's own
  // main file byte-for-byte unchanged.
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-probe-'));
  const probe = path.join(probeDir, 'probe.db');
  fs.copyFileSync(backupPath, probe);
  const p = new Database(probe);
  p.pragma('journal_mode = WAL');
  p.prepare(`INSERT INTO metric_points (timestamp, metric_name, metric_value, dimensions, source)
             VALUES (?, 'usage_event', 1, ?, 'jsonl_usage')`)
    .run('2026-07-01T13:00:00.000Z', JSON.stringify({ marker: 'wal-injected', cost: 5 }));
  const injectedWal = path.join(probeDir, 'injected-wal');
  fs.copyFileSync(`${probe}-wal`, injectedWal); // copied while still open, so uncheckpointed
  assert.deepEqual(fs.readFileSync(probe), pristineMainBytes,
    'the probe must leave the main file untouched, or this is not the case being tested');
  p.close();

  const pm2 = fakePm2({ onStop: `cp "${injectedWal}" "${backupPath}-wal"` });
  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--service', 'zylos-dashboard'
  ], { encoding: 'utf8', env: pm2.env });

  // The hash check must NOT be what catches this — the bytes it compares match.
  assert.doesNotMatch(res.stderr, /BACKUP CHANGED AFTER INSPECTION/,
    'the main-file hash cannot see a WAL-only change; it must not be credited with catching this');
  assert.notEqual(res.status, 0, 'a backup whose contents changed must not be restored silently');
  assert.match(res.stderr, /RESTORE VERIFICATION FAILED/);
  assert.match(res.stderr, /backup     : 1 usage rows/);
  assert.match(res.stderr, /replacement: 2 usage rows/);

  assert.match(res.stderr, /was NOT touched/);
  assert.deepEqual(rowMarkers(dbPath), ['in-backup', 'after-backup'],
    'the live database must be untouched, since nothing was swapped in');
  assert.deepEqual(pm2Calls(pm2.log), ['stop zylos-dashboard'],
    'and the service must be left down rather than started on an unverified restore');

  fs.rmSync(`${backupPath}-wal`, { force: true });
  assert.ok(dir);
});

test('NEGATIVE CONTROL: an unusable backup leaves the live database untouched and the service down', async () => {
  // The replacement is built and checked before anything is swapped, so a backup
  // that cannot produce a usable database must cost the live one nothing at all.
  const { dir, dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  // A file that passes the opening survey and then loses its table, so building
  // the replacement is what fails rather than the initial inspection. Swapped in
  // on `stop`, like the tamper case, and truncated so it is no longer a database.
  const broken = path.join(dir, 'broken.db');
  fs.writeFileSync(broken, fs.readFileSync(backupPath).subarray(0, 512));

  const pm2 = fakePm2({ tamperFrom: broken, tamperTo: backupPath });
  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--service', 'zylos-dashboard'
  ], { encoding: 'utf8', env: pm2.env });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /was NOT touched/);
  assert.deepEqual(rowMarkers(dbPath), ['in-backup', 'after-backup'],
    'the live database must be exactly as it was before the attempt');
  assert.deepEqual(pm2Calls(pm2.log), ['stop zylos-dashboard'],
    'an incomplete restore must not be followed by a start');

  const aside = res.stdout.match(/pre-restore copy: (\S+)/);
  assert.ok(aside, 'the failure path must still name the pre-restore copy');
  assert.match(res.stderr, /A copy of it is also at:/);
  assert.deepEqual(markersOfMainFileAlone(aside[1]), ['in-backup', 'after-backup']);

  // No half-built replacement is left lying beside the database.
  const leftovers = fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes('.incoming-'));
  assert.deepEqual(leftovers, [], 'a failed attempt must not leave an .incoming- file behind');
});
