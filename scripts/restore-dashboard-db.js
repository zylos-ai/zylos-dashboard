#!/usr/bin/env node
/**
 * Restore the dashboard database from a backup, safely, under WAL mode.
 *
 * Why this script exists instead of a printed `cp`:
 *
 * The database runs with journal_mode = WAL (src/lib/store.js). A SQLite
 * database in WAL mode is not one file — it is a main file plus a -wal sidecar
 * that may hold committed state the main file does not. Copying such a database
 * with `cp` (or copying a backup over it while a stale sidecar is still on disk)
 * therefore copies a torn fragment: SQLite replays or discards the sidecar on the
 * next open, and rows appear or vanish. The copy reports success, which makes the
 * failure silent, and silent is worse than an error: the operator believes the
 * rollback happened.
 *
 * So every file this script produces or consumes goes through SQLite itself
 * (`VACUUM INTO`), never through a byte copy. VACUUM INTO writes a fresh,
 * single-file database with any WAL content already materialized into it, so the
 * result cannot be torn and carries no sidecar of its own.
 *
 * A correct restore then has to do all of this, in order:
 *
 *   1. stop every process holding the database (the dashboard service)
 *   2. set the current database aside, as a self-contained file
 *   3. materialize the backup into a replacement, and verify it
 *   4. swap the replacement in, discarding the stale sidecars
 *   5. start the service again
 *
 * Steps 2-4 are what this script guarantees. Step 1 is not something a script
 * can safely assume, so it must be either performed here (--service) or
 * explicitly asserted by the caller (--assume-stopped). There is deliberately
 * no default: silence must never be read as "the service was stopped".
 *
 * Note the ordering of 3 and 4: the replacement is verified while the live
 * database is still untouched, so a backup that turns out to be unusable costs
 * nothing at all. Only a replacement that already passed its checks is swapped
 * in, and the swap itself is a rename.
 *
 *   node scripts/restore-dashboard-db.js --backup <file> --service zylos-dashboard
 *   node scripts/restore-dashboard-db.js --backup <file> --assume-stopped
 *   node scripts/restore-dashboard-db.js --backup <file> --assume-stopped --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f, dflt) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const HOME = process.env.HOME;
const dbPath = valueOf('--db', path.join(HOME, 'zylos', 'components', 'dashboard', 'dashboard.db'));
const backupPath = valueOf('--backup', null);
const service = valueOf('--service', null);
const assumeStopped = has('--assume-stopped');
const dryRun = has('--dry-run');

const die = (msg, code = 1) => { console.error(msg); process.exit(code); };

if (!backupPath) die('--backup <file> is required.');
if (!fs.existsSync(backupPath)) die(`Backup not found: ${backupPath}`);
if (!fs.existsSync(dbPath)) die(`Database not found: ${dbPath}`);
if (!service && !assumeStopped) {
  die([
    'Refusing to restore without knowing the database is closed.',
    '',
    'Pass --service <pm2-name> to have this script stop and restart it, or',
    '--assume-stopped if you have already stopped every process holding the DB.',
    '',
    'This is not a formality. Under WAL mode a restore performed while the',
    'service is running can appear to succeed and silently not take effect.'
  ].join('\n'), 2);
}

const wal = `${dbPath}-wal`;
const shm = `${dbPath}-shm`;
const sizeOf = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);

/**
 * SHA-256 of the file's bytes. Taken of the backup BEFORE anything is stopped or
 * moved, and taken again immediately before the backup is used, so that anything
 * altering it mid-run (another operator, a sync job, a stop hook) is caught while
 * the live database is still untouched.
 *
 * Note what this does NOT do: it says nothing about whether a file is a complete
 * database. Two databases can have identical main-file bytes and differ entirely
 * in their -wal sidecars, so a matching hash is evidence about provenance only.
 * Completeness is what `materialize` establishes, and logical state is what
 * `survey` checks.
 */
function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Copy `src` into a NEW self-contained database at `dest`, using SQLite's own
 * VACUUM INTO rather than a byte copy.
 *
 * This is the difference between a restore that works and one that only looks
 * like it worked. Opening `src` through SQLite reads main file and -wal together,
 * and VACUUM INTO writes that combined logical state out as a single file with no
 * sidecar. A file produced this way can be moved, archived, or restored from on
 * its own — which is exactly what a byte copy of a WAL database cannot promise.
 *
 * `dest` must not exist; VACUUM INTO refuses to overwrite.
 */
function materialize(src, dest) {
  const db = new Database(src, { readonly: true });
  try {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

/** Row counts and cost total, used to compare before/after. */
function survey(file) {
  const db = new Database(file, { readonly: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    const usage = db.prepare(`
      SELECT COUNT(*) AS rows, ROUND(COALESCE(SUM(json_extract(dimensions,'$.cost')), 0), 4) AS cost
        FROM metric_points
       WHERE metric_name = 'usage_event'
    `).get();
    return { integrity, rows: usage.rows, cost: usage.cost };
  } finally {
    db.close();
  }
}

console.log(`database : ${dbPath}`);
console.log(`backup   : ${backupPath}`);
console.log(`wal      : ${sizeOf(wal)} bytes${sizeOf(wal) > 0 ? '  <-- holds state the main file does not' : ''}`);
console.log(`shm      : ${sizeOf(shm)} bytes`);

const backupSurvey = survey(backupPath);
const backupHash = fileHash(backupPath);
console.log(`\nbackup contents  : ${backupSurvey.rows} usage rows, cost $${backupSurvey.cost}, integrity ${backupSurvey.integrity}`);
console.log(`backup sha256    : ${backupHash}`);
if (backupSurvey.integrity !== 'ok') die('Backup fails integrity_check. Refusing to restore from it.');

let liveSurvey = null;
try {
  liveSurvey = survey(dbPath);
  console.log(`current contents : ${liveSurvey.rows} usage rows, cost $${liveSurvey.cost}, integrity ${liveSurvey.integrity}`);
} catch (err) {
  console.log(`current contents : unreadable (${err.message})`);
}

if (dryRun) {
  console.log('\nDRY RUN — nothing stopped, moved, or written.');
  process.exit(0);
}

// 1. stop whatever holds the database
if (service) {
  console.log(`\nstopping ${service} ...`);
  const stop = spawnSync('pm2', ['stop', service], { encoding: 'utf8' });
  if (stop.status !== 0) {
    die(`Failed to stop ${service} (exit ${stop.status}). Nothing was changed.\n${stop.stderr || stop.stdout || ''}`);
  }
  console.log(`${service} stopped`);
} else {
  console.log('\n--assume-stopped: trusting the caller that nothing holds the database');
}

const leftStopped = () => (service ? `${service} is still stopped and was deliberately NOT started.` : '');

// 2. Keep the pre-restore state recoverable: a failed restore must not be a
// one-way door either.
//
// This copy goes through SQLite, so it is a single self-contained file. That
// matters more than it looks: a raw copy of a live WAL database plus its sidecars
// *reads* correctly while the sidecars sit beside it, which makes it appear
// recoverable, and then loses everything in the -wal the moment it is restored
// from as a single file. The pre-restore copy is the one file that must never
// have that property.
const aside = `${dbPath}.pre-restore-${Date.now()}`;
let asideIsRawCopy = false;
try {
  materialize(dbPath, aside);
} catch (err) {
  // The live database could not be read through SQLite — which is itself a
  // reason someone is running a restore. Fall back to a raw copy WITH sidecars so
  // that something is still set aside, and say plainly that this one is only
  // usable with those sidecars kept beside it.
  try {
    fs.copyFileSync(dbPath, aside);
    for (const [src, suffix] of [[wal, '-wal'], [shm, '-shm']]) {
      if (fs.existsSync(src)) fs.copyFileSync(src, `${aside}${suffix}`);
    }
    asideIsRawCopy = true;
  } catch (copyErr) {
    die([
      `Could not set aside the current database: ${copyErr.message}`,
      `(reading it through SQLite also failed: ${err.message})`,
      'Nothing was changed.',
      leftStopped()
    ].filter(Boolean).join('\n'));
  }
}
console.log(asideIsRawCopy
  ? `pre-restore copy: ${aside} (RAW copy — the live database was unreadable through SQLite, so its -wal/-shm were copied too and must be kept beside it)`
  : `pre-restore copy: ${aside} (self-contained single file, so restoring from it needs nothing else)`);

// The backup is about to be used. Re-check it against the bytes that were
// inspected and approved above, while the live database is still intact.
const backupHashNow = fileHash(backupPath);
if (backupHashNow !== backupHash) {
  die([
    'BACKUP CHANGED AFTER INSPECTION — refusing to restore from it.',
    `inspected: ${backupHash}`,
    `now      : ${backupHashNow}`,
    'The database was NOT touched; the file on disk is still the pre-restore one.',
    `A copy of it is also at: ${aside}`,
    leftStopped()
  ].filter(Boolean).join('\n'));
}

// 3. Materialize the backup into a replacement and verify it BEFORE the live
// database is disturbed, so an unusable backup costs nothing.
const incoming = `${dbPath}.incoming-${process.pid}`;
const discardIncoming = () => { try { fs.rmSync(incoming, { force: true }); } catch { /* nothing to add */ } };
try {
  if (fs.existsSync(incoming)) fs.rmSync(incoming, { force: true, recursive: true });
  materialize(backupPath, incoming);
} catch (err) {
  discardIncoming();
  die([
    `Could not build a replacement database from the backup: ${err.message}`,
    `${dbPath} was NOT touched and is still the pre-restore database.`,
    `A copy of it is also at: ${aside}`,
    leftStopped()
  ].filter(Boolean).join('\n'));
}

let candidate;
try {
  candidate = survey(incoming);
} catch (err) {
  // Guarded deliberately: an unreadable replacement must produce the fail-safe
  // message below, not an uncaught stack trace that skips it.
  discardIncoming();
  die([
    `The replacement built from the backup could not be read: ${err.message}`,
    `${dbPath} was NOT touched and is still the pre-restore database.`,
    `A copy of it is also at: ${aside}`,
    leftStopped()
  ].filter(Boolean).join('\n'));
}

const matches = candidate.integrity === 'ok' &&
  candidate.rows === backupSurvey.rows &&
  candidate.cost === backupSurvey.cost;
if (!matches) {
  discardIncoming();
  die([
    'RESTORE VERIFICATION FAILED — the replacement does not match the backup.',
    `backup     : ${backupSurvey.rows} usage rows, cost $${backupSurvey.cost}, integrity ${backupSurvey.integrity}`,
    `replacement: ${candidate.rows} usage rows, cost $${candidate.cost}, integrity ${candidate.integrity}`,
    `${dbPath} was NOT touched and is still the pre-restore database.`,
    `A copy of it is also at: ${aside}`,
    leftStopped()
  ].filter(Boolean).join('\n'));
}
console.log(`replacement built: ${candidate.rows} usage rows, cost $${candidate.cost}, integrity ${candidate.integrity}`);

// 4. Swap it in. The stale sidecars go with the database they belonged to —
// leaving either of them beside the new file is the silent-failure case.
try {
  for (const [p, label] of [[wal, 'wal'], [shm, 'shm']]) {
    if (fs.existsSync(p)) {
      fs.rmSync(p);
      console.log(`removed stale ${label}`);
    }
  }
  fs.renameSync(incoming, dbPath);
} catch (err) {
  die([
    `Could not swap the verified replacement into place: ${err.message}`,
    `The stale sidecars may already be gone, so ${dbPath} must not be served as-is.`,
    `Restore the pre-restore copy from: ${aside}`,
    `The verified replacement, if it still exists, is at: ${incoming}`,
    leftStopped()
  ].filter(Boolean).join('\n'));
}
console.log('replacement swapped into place');

let after;
try {
  after = survey(dbPath);
} catch (err) {
  die([
    `The restored database could not be read back: ${err.message}`,
    `Restore the pre-restore copy from: ${aside}`,
    leftStopped()
  ].filter(Boolean).join('\n'));
}

const staleWal = sizeOf(wal) > 0;
if (after.integrity !== 'ok' || after.rows !== candidate.rows || after.cost !== candidate.cost || staleWal) {
  die([
    'RESTORE VERIFICATION FAILED after the swap — the database on disk is not what was verified.',
    `expected: ${candidate.rows} usage rows, cost $${candidate.cost}`,
    `found   : ${after.rows} usage rows, cost $${after.cost}, integrity ${after.integrity}`,
    staleWal ? `and a non-empty ${wal} is beside it, which will be replayed on the next open` : '',
    `Restore the pre-restore copy from: ${aside}`,
    leftStopped()
  ].filter(Boolean).join('\n'));
}

// State the scope of the claim rather than a bare "verified": be precise about
// what this proves so nobody reads more into it than it earns.
console.log([
  '\nverified:',
  '  - the database was built by SQLite from the backup, so any state that was in',
  `    the backup's -wal is materialized into the single file now on disk`,
  '  - the backup was byte-identical (sha256) to the one inspected at the start,',
  '    checked again immediately before it was used',
  '  - it opens cleanly and passes integrity_check',
  `  - it reports the same ${after.rows} usage rows and cost $${after.cost} as that backup`,
  '  - no replayable -wal remains beside it',
  `  - the pre-restore database is at ${aside}${asideIsRawCopy ? ' (raw copy — keep its sidecars beside it)' : ' as a self-contained file'}`,
  'not proven: that the backup itself held the state you wanted, or that nothing',
  'writes to the database after this moment.'
].join('\n'));

// 5. bring the service back
if (service) {
  const start = spawnSync('pm2', ['start', service], { encoding: 'utf8' });
  if (start.status !== 0) {
    console.error(`\nRestore succeeded but ${service} failed to start (exit ${start.status}).`);
    console.error(start.stderr || start.stdout || '');
    process.exit(1);
  }
  console.log(`${service} started`);
} else {
  console.log('\nStart the dashboard service again when you are ready.');
}
