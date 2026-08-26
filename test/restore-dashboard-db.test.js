import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
// The observer needs different flags on different Node versions — `module.register`
// from 20.6, `--experimental-loader` below it — and only the spawner can pass them,
// because a preload runs after the loader chain is already fixed.
import { observerArgv } from '../scripts/test-support/source-access-observer-argv.mjs';

// Not import.meta.dirname: that needs Node 20.11, while this package declares >=20.
const HERE = path.dirname(fileURLToPath(import.meta.url));

const SCRIPT = path.join(HERE, '..', 'scripts', 'restore-dashboard-db.js');
/**
 * Stand-alone script that reports what the `fs` API looks like from the inside, so
 * the observer's wrappers can be compared against an uninstrumented run of the
 * same code rather than against expectations. See its header.
 */
const SEMANTICS_PROBE = path.join(
  HERE, '..', 'scripts', 'test-support', 'source-access-observer-semantics-probe.cjs'
);

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
    -- A non-usage table, because the usage rows are not the only thing a restore
    -- carries. The checks this script performs on contents look at usage rows and
    -- their cost total, so anything living outside that view is exactly what can
    -- ride in unnoticed: auth sessions, API keys, runtime state. Tests that only
    -- ever inject usage rows cannot see that class of failure at all.
    CREATE TABLE auth_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL
    );
    INSERT INTO auth_sessions (token_hash) VALUES ('original-session-token');
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

/** The non-usage content: invisible to the row-count and cost checks. */
function tokenHashes(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const hashes = db.prepare('SELECT token_hash FROM auth_sessions ORDER BY id').all().map((r) => r.token_hash);
  db.close();
  return hashes;
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The frozen artifact's hash, as the script reported it before stopping anything. */
function reportedArtifactHash(stdout) {
  const m = stdout.match(/artifact sha256\s*: ([0-9a-f]{64})/);
  assert.ok(m, 'the script must report the hash of the artifact it froze');
  return m[1];
}

/**
 * A real SQLite -wal that would add `marker` to `source`'s table if it were ever
 * replayed, built without touching `source`'s own main file. Returned as a path to
 * the sidecar, ready to be dropped beside some other copy of that database.
 */
function walThatAddsARow(source, marker) {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-probe-'));
  const probe = path.join(probeDir, 'probe.db');
  fs.copyFileSync(source, probe);
  const pristine = fs.readFileSync(source);

  const p = new Database(probe);
  p.pragma('journal_mode = WAL');
  p.prepare(`INSERT INTO metric_points (timestamp, metric_name, metric_value, dimensions, source)
             VALUES (?, 'usage_event', 1, ?, 'jsonl_usage')`)
    .run('2026-07-01T13:00:00.000Z', JSON.stringify({ marker, cost: 5 }));
  const injected = path.join(probeDir, 'injected-wal');
  fs.copyFileSync(`${probe}-wal`, injected); // copied while still open, so uncheckpointed
  assert.deepEqual(fs.readFileSync(source), pristine,
    'building the probe must leave the source main file untouched, or this is not the case being tested');
  p.close();
  return injected;
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

  // A dry run does build the artifact — that is most of what it is checking — so it
  // has to clean it up. Leaving one behind would deposit a full copy of the
  // database beside the live one on every preview.
  const leftovers = fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes('.incoming-'));
  assert.deepEqual(leftovers, [], 'a dry run must not leave its artifact behind');
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
function fakePm2({ tamperFrom, tamperTo, onStop, stopExit } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pm2-'));
  const log = path.join(dir, 'pm2-invocations.log');
  const bin = path.join(dir, 'pm2');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    `echo "$@" >> "${log}"`,
    ...(tamperFrom ? [`if [ "$1" = "stop" ]; then cp "${tamperFrom}" "${tamperTo}"; fi`] : []),
    ...(onStop ? [`if [ "$1" = "stop" ]; then ${onStop}; fi`] : []),
    ...(stopExit ? [`if [ "$1" = "stop" ]; then exit ${stopExit}; fi`] : []),
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

// --- Provenance: inspection and use are the same logical moment ---------------
// The mechanism under test is that the backup is opened through SQLite exactly
// once, before the
// stop, and frozen into a self-contained artifact that is what later gets renamed
// into place. The three controls below each mutate the source backup during the
// stop window — main file, its -wal, and a table the content checks do not look at
// — and assert the same thing every time: it makes no difference to the result.
//
// That is a stronger claim than "the change is detected", and a different one. A
// detection can be evaded; these say the mutation cannot reach the live database
// at all, because nothing reads the source again after it has been frozen.

test('POSITIVE CONTROL: replacing the source backup during the stop window changes nothing', async () => {
  const { dir, dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  // A different database with the SAME usage row count and the SAME cost total, so
  // no content check could tell it from the approved one. Under the previous
  // ordering this was caught by re-hashing the source; now it is not caught,
  // because it is not a threat: the source is never used as restore content again.
  const tampered = path.join(dir, 'tampered.db');
  const t = new Database(tampered);
  t.exec(`
    CREATE TABLE metric_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
      runtime TEXT NOT NULL DEFAULT 'claude', session_id TEXT, metric_name TEXT NOT NULL,
      metric_value REAL NOT NULL, dimensions TEXT, source TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'actual'
    );
    CREATE TABLE auth_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL);
    INSERT INTO auth_sessions (token_hash) VALUES ('attacker-session-token');
  `);
  t.prepare(`INSERT INTO metric_points (timestamp, metric_name, metric_value, dimensions, source)
             VALUES (?, 'usage_event', 1, ?, 'jsonl_usage')`)
    .run('2026-07-01T10:00:00.000Z', JSON.stringify({ marker: 'tampered', cost: 1 }));
  t.close();

  const pm2 = fakePm2({ tamperFrom: tampered, tamperTo: backupPath });
  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--service', 'zylos-dashboard'
  ], { encoding: 'utf8', env: pm2.env });

  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(rowMarkers(dbPath), ['in-backup'],
    'the restored state must be the inspected one, not whatever replaced the source');
  assert.deepEqual(tokenHashes(dbPath), ['original-session-token'],
    'and not the replacement content in a table the checks never look at');
  assert.equal(sha256(dbPath), reportedArtifactHash(res.stdout),
    'the file on disk must be byte-identical to the artifact that was verified');
  assert.deepEqual(pm2Calls(pm2.log), ['stop zylos-dashboard', 'start zylos-dashboard'],
    'a restore that was never in doubt completes normally');
});

test('POSITIVE CONTROL: a -wal appearing beside the source backup during the stop window changes nothing', async () => {
  // Main-file bytes identical, contents different — the case a hash can never see.
  // The previous ordering had to catch this with a logical comparison after
  // reopening the source. Now the source is not reopened, so there is nothing to
  // catch: the injected sidecar is never in the path of anything.
  const { dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  const injectedWal = walThatAddsARow(backupPath, 'wal-injected');
  const pm2 = fakePm2({ onStop: `cp "${injectedWal}" "${backupPath}-wal"` });
  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--service', 'zylos-dashboard'
  ], { encoding: 'utf8', env: pm2.env });

  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(rowMarkers(dbPath), ['in-backup'],
    'the row that only ever existed in the injected -wal must not appear');
  assert.equal(sha256(dbPath), reportedArtifactHash(res.stdout));
  assert.deepEqual(pm2Calls(pm2.log), ['stop zylos-dashboard', 'start zylos-dashboard']);

  fs.rmSync(`${backupPath}-wal`, { force: true });
});

test('POSITIVE CONTROL: a WAL-only change to a NON-USAGE table during the stop window changes nothing', async () => {
  // This is the exploit the previous ordering actually admitted, and the only one
  // of the three that no check in the script would have flagged. The injected
  // commit lands in the backup's -wal, so the main file's bytes are unchanged and
  // the hash matches; it touches auth_sessions rather than metric_points, so the
  // usage row count and cost total are unchanged too. Both checks pass and
  // never-inspected content is restored.
  //
  // Note what makes this control discriminating rather than decorative: the
  // injection site is deliberately outside everything the script compares. A
  // control that injects a usage row proves nothing about this class — it would be
  // caught by the row count for reasons that have nothing to do with provenance.
  const { dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  const pristineMainBytes = fs.readFileSync(backupPath);

  // A -wal that rewrites the session token in place: same table, same row count,
  // same everything the script looks at.
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-probe-'));
  const probe = path.join(probeDir, 'probe.db');
  fs.copyFileSync(backupPath, probe);
  const p = new Database(probe);
  p.pragma('journal_mode = WAL');
  p.prepare('UPDATE auth_sessions SET token_hash = ?').run('attacker-session-token');
  const injectedWal = path.join(probeDir, 'injected-wal');
  fs.copyFileSync(`${probe}-wal`, injectedWal);
  assert.deepEqual(fs.readFileSync(probe), pristineMainBytes,
    'the probe must leave the main file untouched, or this is not the case being tested');
  p.close();

  const pm2 = fakePm2({ onStop: `cp "${injectedWal}" "${backupPath}-wal"` });
  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--service', 'zylos-dashboard'
  ], { encoding: 'utf8', env: pm2.env });

  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(tokenHashes(dbPath), ['original-session-token'],
    'the rewritten token must NOT be what the restore installed — this is the exploit itself');
  assert.deepEqual(rowMarkers(dbPath), ['in-backup'],
    'and the usage rows are the inspected ones, as they were in the exploit too');
  assert.equal(sha256(dbPath), reportedArtifactHash(res.stdout),
    'the swapped-in bytes are the verified artifact, so no injection site exists at all');

  fs.rmSync(`${backupPath}-wal`, { force: true });
});

test('a -wal appearing beside the FROZEN ARTIFACT is discarded unread rather than consumed', async () => {
  // The artifact is the one file the restore does consume, so it is worth asserting
  // that it is consumed as a single file and nothing else travels with it. The
  // script removes any sidecar that turns up beside it, unread, and says so.
  //
  // Honest about the strength of this: an artifact written by VACUUM INTO is not in
  // WAL mode, so SQLite would ignore such a sidecar anyway. What is asserted here
  // is that the code does not carry it along and does not reopen the artifact to
  // find out — which is what keeps that from becoming load-bearing later.
  const { dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  const injectedWal = walThatAddsARow(backupPath, 'artifact-wal-injected');
  const pm2 = fakePm2({
    onStop: `for f in "${dbPath}".incoming-*; do [ -e "$f" ] && cp "${injectedWal}" "$f-wal"; done`
  });
  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--service', 'zylos-dashboard'
  ], { encoding: 'utf8', env: pm2.env });

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /discarded unread -wal that appeared beside the frozen artifact/,
    'the sidecar must be reported, so its existence is never silent');
  assert.deepEqual(rowMarkers(dbPath), ['in-backup'], 'and its row must not appear');
  assert.equal(sha256(dbPath), reportedArtifactHash(res.stdout));
  assert.ok(!fs.existsSync(`${dbPath}-wal`) || fs.statSync(`${dbPath}-wal`).size === 0,
    'nor may it arrive beside the live database under its new name');
});

test('NEGATIVE CONTROL: the frozen artifact being altered after inspection is caught, and the service is left down', async () => {
  // The re-hash before the swap covers the one file that is actually used. Nothing
  // legitimate writes to it, so this asserts the check is live rather than dead
  // code — and that failing it costs the live database nothing.
  const { dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  const pm2 = fakePm2({
    onStop: `for f in "${dbPath}".incoming-*; do [ -e "$f" ] && printf 'tampered' >> "$f"; done`
  });
  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--service', 'zylos-dashboard'
  ], { encoding: 'utf8', env: pm2.env });

  assert.notEqual(res.status, 0, 'an altered artifact must not be restored');
  assert.match(res.stderr, /FROZEN ARTIFACT CHANGED AFTER INSPECTION/);
  assert.match(res.stderr, /inspected: [0-9a-f]{64}/);
  assert.match(res.stderr, /was NOT touched/);
  assert.deepEqual(rowMarkers(dbPath), ['in-backup', 'after-backup'],
    'the live database must be left exactly as it was');

  assert.deepEqual(pm2Calls(pm2.log), ['stop zylos-dashboard'],
    'the service must be stopped and then NOT started while the restore is unresolved');
  assert.match(res.stderr, /still stopped and was deliberately NOT started/);

  const aside = res.stdout.match(/pre-restore copy: (\S+)/);
  assert.ok(aside, 'the failure path must still name the pre-restore copy');
  assert.deepEqual(markersOfMainFileAlone(aside[1]), ['in-backup', 'after-backup'],
    'the pre-restore copy still holds the full original state, on its own');

  const leftovers = fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes('.incoming-'));
  assert.deepEqual(leftovers, [], 'the untrustworthy artifact must not be left lying around');
});

test('NEGATIVE CONTROL: a failed service stop leaves no artifact behind, and says so truthfully', async () => {
  // The artifact is built before the stop, so every stop-failure exit has to clean
  // it up. Without that, the most ordinary failure there is — a service name that
  // does not exist, pm2 missing — silently deposits a complete, integrity-clean
  // copy of the database on disk while stderr claims nothing was changed. Repeated
  // attempts accumulate more of them, each holding whatever the backup holds.
  //
  // So this asserts the message and the disk agree: "Nothing was changed" has to be
  // true, not merely reassuring.
  const { dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  const before = fs.readFileSync(dbPath);
  const pm2 = fakePm2({ stopExit: 1 });
  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--service', 'zylos-dashboard'
  ], { encoding: 'utf8', env: pm2.env });

  assert.notEqual(res.status, 0, 'a failed stop must not be treated as success');
  assert.match(res.stderr, /Failed to stop zylos-dashboard/);
  assert.match(res.stderr, /Nothing was changed/);

  const leftovers = fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes('.incoming-'));
  assert.deepEqual(leftovers, [],
    'the artifact built before the stop must be discarded, not left on disk contradicting the message');
  assert.deepEqual(fs.readFileSync(dbPath), before, 'and the live database must be untouched');
  assert.deepEqual(pm2Calls(pm2.log), ['stop zylos-dashboard'],
    'a stop that failed must not be followed by a start');
});

test('POSITIVE CONTROL: deleting the source backup during the stop window changes nothing', async () => {
  // The contract is that the source is opened once, to build the artifact, and not
  // read again — for any purpose, including recording its hash. So it may vanish
  // entirely once the artifact exists and the restore must still complete, with the
  // same bytes it would have produced otherwise.
  const { dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  const pm2 = fakePm2({ onStop: `rm -f "${backupPath}"` });
  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--service', 'zylos-dashboard'
  ], { encoding: 'utf8', env: pm2.env });

  assert.equal(res.status, 0, res.stderr);
  assert.ok(!fs.existsSync(backupPath), 'the source really is gone by the end of the run');
  assert.deepEqual(rowMarkers(dbPath), ['in-backup'], 'and the restore still produced the frozen state');
  assert.equal(sha256(dbPath), reportedArtifactHash(res.stdout),
    'byte-identical to the artifact, so nothing was re-derived from the vanished source');
  assert.deepEqual(pm2Calls(pm2.log), ['stop zylos-dashboard', 'start zylos-dashboard']);
});

test('no hash of the source backup is reported', async () => {
  // Scope, deliberately narrow: this is an assertion about the script's OUTPUT, and
  // nothing more. A weaker "audit" hash of a mutable WAL-mode main file was dropped
  // rather than kept as a second, failure-prone trust semantics, so the artifact is
  // the only hash there is to report.
  //
  // It used to be named for a claim it could not support — that the source "is not
  // read again after the artifact is built" — which a silent access would have
  // passed unchallenged. The test below is the one that observes accesses.
  const { dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', backupPath, '--assume-stopped'
  ], { encoding: 'utf8' });

  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /source sha256/,
    'no hash of the source may be reported');
  assert.match(res.stdout, /artifact sha256\s*: [0-9a-f]{64}/,
    'the artifact is the verifiable object, and it is still reported');
});

/** Parsed observer log: the `observer-ready` header, plus the accesses it saw. */
function readObserved(logPath) {
  const lines = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return {
    ready: lines.find((e) => e.kind === 'observer-ready') || null,
    entries: lines.filter((e) => e.kind !== 'observer-ready')
  };
}

test('the script opens one SQLite connection on the source and does not reach for it again after that call returns', async () => {
  // The claim this test can support, stated exactly:
  //
  //   the script's own JavaScript opens ONE better-sqlite3 connection on the source
  //   backup, to build the artifact, and after that constructor returns it does not
  //   reach for the source again through any function of fs / fs.promises, through
  //   the better-sqlite3 constructor, or through a subprocess it launches.
  //
  // What it is NOT, in three specific ways:
  //   - not a syscall-level claim that the source is "read once". One SQLite
  //     connection performs as many low-level reads of the main file and its -wal as
  //     SQLite needs, inside native code, where this cannot see them;
  //   - not a claim about what a child process reads. The subprocess check records
  //     which commands this script launched, nothing more;
  //   - not a claim about reads that bypass the fs module entirely.
  // The fs coverage is the module's own function surface, enumerated at load time
  // rather than hand-listed — an earlier hand-list version missed fs.openAsBlob, and
  // the test below pins that hole shut.
  //
  // FAIL-CLOSED: every absence assertion here is worthless unless interposition is
  // actually live — "nothing was recorded" is also what a broken observer produces.
  // Two real failures of exactly that kind happened while building this: overwriting
  // require.cache silently reached neither Node 20 nor 22, and module.registerHooks
  // does not exist before Node 22.15 while this repo supports >=20. So the header
  // line is checked first, the must-happen accesses second, absences last.
  const { dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  const pm2 = fakePm2();
  const logPath = path.join(path.dirname(dbPath), 'source-access.log');
  const { mechanism: expectedMechanism, argv } = observerArgv();
  const res = spawnSync(process.execPath, [
    ...argv, SCRIPT,
    '--db', dbPath, '--backup', backupPath, '--service', 'zylos-dashboard'
  ], {
    encoding: 'utf8',
    env: { ...pm2.env, SOURCE_OBSERVER_TARGET: backupPath, SOURCE_OBSERVER_LOG: logPath }
  });

  assert.equal(res.status, 0, res.stderr);

  const { ready, entries } = readObserved(logPath);
  const of = (kind, phase) => entries.filter((e) => e.kind === kind && (!phase || e.phase === phase));

  // 0. Is there an observer at all, and is it the one this Node was supposed to get?
  // There is deliberately no skip: below 20.6 the spawner passes
  // `--experimental-loader` instead of relying on `module.register`, so every version
  // in the supported range has a mechanism. `none` would mean the observer never
  // installed itself, and that produces exactly the same empty log as a clean run —
  // so it has to fail here rather than pass quietly.
  assert.ok(ready, 'the observer must report itself before anything else is trusted');
  assert.equal(ready.node, process.versions.node, 'the log must come from this Node');
  assert.equal(ready.mechanism, expectedMechanism,
    `Node ${process.versions.node} must interpose via ${expectedMechanism}, got ${ready.mechanism}`);
  assert.ok(ready.wrappedFsFunctions > 50,
    `the fs surface must actually be wrapped, got ${ready.wrappedFsFunctions} functions`);

  // Coverage is pinned rather than merely counted. Everything the observer declines
  // to instrument is named in its header, so the sets below are the complete list of
  // what it is allowed to miss; a new hole turns this red instead of silently
  // widening the gap between what the test asserts and what the observer can see.
  // All four values were measured identical on 20.0.0, 20.5.1, 20.20.2, 22 and 24.
  assert.deepEqual(ready.wrappedAttached, [
    'fs.exists.Symbol(nodejs.util.promisify.custom)',
    'fs.promises.opendir.Symbol(nodejs.util.promisify.custom)',
    'fs.realpath.native',
    'fs.realpathSync.native'
  ], 'callables hanging off fs functions must be instrumented, not copied across');
  assert.deepEqual(ready.excludedAttached, [
    'fs.promises.opendir.Symbol(nodejs.util.promisify.custom).Symbol(nodejs.util.promisify.custom):depth'
  ], 'the only declined callable is the self-referential promisify.custom past the wrapped depth');
  assert.deepEqual(ready.unwrappable, [],
    'every plain fs function must be replaceable — a read-only one would be an unwatched hole');

  // 1. The observer is live — asserted through accesses that must happen.
  assert.deepEqual(of('sqlite-open').map((e) => e.phase), ['before-source-connection-open'],
    'exactly one observed SQLite connection on the source, and it precedes the phase flip');
  assert.ok(of('metadata', 'before-source-connection-open').some((e) => e.fn === 'fs.existsSync'),
    'the fs interposition must be live: the script probes the source with existsSync before opening it');
  assert.deepEqual(of('spawn').map((e) => `${e.command} ${e.args.join(' ')}`),
    ['pm2 stop zylos-dashboard', 'pm2 start zylos-dashboard'],
    'the child_process interposition must be live, and the subprocess contract is exactly these two pm2 calls');

  // 2. Only now, the absences.
  const after = entries.filter((e) => e.phase === 'after-source-connection-open');
  assert.deepEqual(after.filter((e) => e.kind !== 'spawn'), [],
    'once the materialize connection returned, the source is not opened or read again');
  assert.deepEqual(of('access'), [],
    'the source is never reached through an fs function at all — only through SQLite, to build the artifact');
});

test('INSTRUMENT CONTROL: the observer sees the reads that have escaped it before', async () => {
  // The test above can only be trusted as far as the observer's coverage goes, and
  // coverage is where every previous version was wrong — three times, each found by
  // review reaching the watched file rather than by argument:
  //
  //   - a hand-written list of "the obvious read functions" missed `fs.openAsBlob`,
  //     whose `.arrayBuffer()` read 8,192 real bytes while the log stayed empty;
  //   - `isTarget` understood only strings and Buffers, so
  //     `fs.readFileSync(pathToFileURL(src))` read the file unrecorded;
  //   - `Object.assign(wrapper, real)` republished the original, uninstrumented
  //     `fs.realpathSync.native`, which then reached the file unrecorded.
  //
  // So each of those is a permanent control here, and each is discriminating: delete
  // the URL branch of the observer's path matching and the URL line disappears;
  // delete the attached-property wrapping and the `.native` line disappears; narrow
  // the fs enumeration back to a hand list and openAsBlob disappears. The url-like
  // plain object is here for the same reason — `fs` duck-types it and really does read
  // through it, so recognising only `instanceof URL` would leave the same hole again.
  //
  // The sequence is asserted in full, including the argument form each access arrived
  // as, and it was measured identical on 20.0.0, 20.5.1, 20.20.2, 22.22.2 and 24.17.0.
  const { dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  const dir = path.dirname(dbPath);
  const standIn = path.join(dir, 'second-read.mjs');
  fs.writeFileSync(standIn, [
    "import fs from 'node:fs';",
    "import { pathToFileURL } from 'node:url';",
    "import Database from 'better-sqlite3';",
    'const src = process.argv[2];',
    // Positive control for the loader redirect itself, independent of the log: without
    // it this prints the real class name, so the log being empty would have a second,
    // visible explanation instead of looking like a clean run.
    'process.stdout.write(`DatabaseClass=${Database.name}\\n`);',
    'new Database(src, { readonly: true }).close();',
    'const blob = await fs.openAsBlob(src);',
    'if ((await blob.arrayBuffer()).byteLength === 0) throw new Error("expected bytes");',
    'if (fs.readFileSync(pathToFileURL(src)).byteLength === 0) throw new Error("expected bytes via URL");',
    'const u = pathToFileURL(src);',
    'const like = { protocol: u.protocol, pathname: u.pathname, href: u.href,',
    '  hostname: u.hostname, search: u.search, hash: u.hash };',
    'if (fs.readFileSync(like).byteLength === 0) throw new Error("expected bytes via url-like");',
    'if (fs.realpathSync.native(src) !== fs.realpathSync(src)) throw new Error("native mismatch");'
  ].join('\n'));

  const logPath = path.join(dir, 'instrument.log');
  const { mechanism: expectedMechanism, argv } = observerArgv();
  const res = spawnSync(process.execPath, [...argv, standIn, backupPath], {
    encoding: 'utf8',
    cwd: path.join(HERE, '..'),
    env: { ...process.env, SOURCE_OBSERVER_TARGET: backupPath, SOURCE_OBSERVER_LOG: logPath }
  });

  assert.equal(res.status, 0, res.stderr);
  // The redirect happened, witnessed from inside the observed process.
  assert.match(res.stdout, /DatabaseClass=ObservedDatabase/,
    'the loader must redirect `better-sqlite3` to the observed subclass');

  const { ready, entries } = readObserved(logPath);
  assert.ok(ready, 'the observer must report itself');
  assert.equal(ready.mechanism, expectedMechanism,
    `Node ${process.versions.node} must interpose via ${expectedMechanism}, got ${ready.mechanism}`);

  assert.deepEqual(entries.map((e) => `${e.phase}|${e.kind}|${e.fn || 'sqlite'}|${e.form}`), [
    'before-source-connection-open|sqlite-open|sqlite|string',
    'after-source-connection-open|access|fs.openAsBlob|string',
    'after-source-connection-open|access|fs.readFileSync|URL',
    'after-source-connection-open|access|fs.openSync|URL',
    'after-source-connection-open|access|fs.readFileSync|url-like',
    'after-source-connection-open|access|fs.openSync|url-like',
    'after-source-connection-open|metadata|fs.realpathSync.native|string',
    'after-source-connection-open|metadata|fs.realpathSync|string'
  ], 'every read the stand-in performs must be recorded, with the path form it used');
});

test('INSTRUMENT CONTROL: wrapping fs does not change how fs behaves', async () => {
  // The absence assertions rest on wrappers that replace most of the `fs` module in
  // the observed process. That is only sound if the replacements are transparent, and
  // "transparent" is not something to establish by reading the wrapper and finding it
  // reasonable — `Object.assign` looked reasonable and silently dropped every
  // symbol-keyed property, which changed what `util.promisify(fs.exists)` does.
  //
  // So the same probe script runs twice on the same file, once observed and once not,
  // and the two reports must be identical. It exercises descriptors, own-key sets
  // including symbols, arity and name, the intrinsic kind of every callable on both
  // holders, callback/promise/sync forms of the same operation, the callable attached
  // properties actually being called, and the error each rejected path form produces —
  // all by running them, not by inspecting them.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-semantics-'));
  const file = path.join(dir, 'watched.bin');
  fs.writeFileSync(file, crypto.randomBytes(4096));

  const { argv } = observerArgv();
  const run = (prefix, logName) => spawnSync(process.execPath, [...prefix, SEMANTICS_PROBE, file], {
    encoding: 'utf8',
    cwd: path.join(HERE, '..'),
    env: {
      ...process.env,
      SOURCE_OBSERVER_TARGET: file,
      SOURCE_OBSERVER_LOG: path.join(dir, logName)
    }
  });

  const pristine = run([], 'unused.log');
  const observed = run(argv, 'observed.log');

  assert.equal(pristine.status, 0, pristine.stderr);
  assert.equal(observed.status, 0, observed.stderr);
  assert.ok(pristine.stdout.length > 0, 'the probe must produce a report');

  assert.deepEqual(JSON.parse(observed.stdout), JSON.parse(pristine.stdout),
    'the observed fs surface must behave exactly like the uninstrumented one');

  // And the observed run really was observed — otherwise "identical" is trivially
  // true, which is the same vacuous pass the header line exists to rule out.
  const { ready, entries } = readObserved(path.join(dir, 'observed.log'));
  assert.ok(ready, 'the observed run must have installed the observer');
  assert.ok(entries.some((e) => e.kind === 'access' && e.form === 'URL'),
    'the probe reads the watched file through a URL, so the observer must have seen it');
  assert.ok(entries.some((e) => e.fn === 'fs.realpathSync.native'),
    'the probe calls the attached native function, so the observer must have seen it');
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

test('NEGATIVE CONTROL: an unusable backup is refused before the service is even stopped', async () => {
  // What this covers, precisely: the failure of the step that builds the
  // replacement — not the initial read, and not a later comparison. Its
  // predecessor claimed that branch and never reached it, because a re-hash of the
  // source intercepted the tampered file first and the run died with a different
  // message. Asserting the specific failure point is what keeps a test honest
  // about which branch it exercises.
  //
  // The stop hook that test used to rely on is gone with the re-hash: since the
  // backup is now read before anything is stopped, a broken file must be handed
  // over directly to reach this branch at all.
  const { dir, dbPath, backupPath, db, insert } = scenario();
  await db.backup(backupPath);
  insert.run('2026-07-01T11:00:00.000Z', JSON.stringify({ marker: 'after-backup', cost: 2 }));
  db.close();

  // Truncated: a SQLite header, then nothing. Opening it succeeds; reading it out
  // does not, so VACUUM INTO is what fails.
  const broken = path.join(dir, 'broken.db');
  fs.writeFileSync(broken, fs.readFileSync(backupPath).subarray(0, 512));

  const pm2 = fakePm2();
  const res = spawnSync(process.execPath, [
    SCRIPT, '--db', dbPath, '--backup', broken, '--service', 'zylos-dashboard'
  ], { encoding: 'utf8', env: pm2.env });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Could not build a replacement database from the backup/,
    'the failure must be the materialize step, which is the branch this test is for');
  assert.match(res.stderr, /was NOT touched/);
  assert.deepEqual(rowMarkers(dbPath), ['in-backup', 'after-backup'],
    'the live database must be exactly as it was before the attempt');

  // Stronger than the fail-safe it replaces: the backup is checked before the stop,
  // so an unusable one does not even cost downtime.
  assert.deepEqual(pm2Calls(pm2.log), [],
    'an unusable backup must be refused without stopping the service at all');
  assert.match(res.stderr, /Nothing was stopped/);

  // No half-built artifact is left lying beside the database.
  const leftovers = fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes('.incoming-'));
  assert.deepEqual(leftovers, [], 'a failed attempt must not leave an .incoming- file behind');
});
