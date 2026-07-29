#!/usr/bin/env node
/**
 * Restore the dashboard database from a backup, safely, under WAL mode.
 *
 * Why this script exists instead of a printed `cp`:
 *
 * The database runs with journal_mode = WAL (src/lib/store.js). Copying the
 * backup file over dashboard.db while a stale dashboard.db-wal is still on disk
 * does NOT restore anything — SQLite replays that WAL on the next open, so the
 * rows the backup was supposed to bring back disappear again. The copy reports
 * success, which makes the failure silent, and silent is worse than an error:
 * the operator believes the rollback happened. Copying over a database that a
 * live writer still holds open is separately unsafe.
 *
 * So a correct restore has to do all of this, in order:
 *
 *   1. stop every process holding the database (the dashboard service)
 *   2. remove the stale -wal and -shm sidecars
 *   3. put the backup in place
 *   4. verify the result before trusting it
 *   5. start the service again
 *
 * Steps 2-4 are what this script guarantees. Step 1 is not something a script
 * can safely assume, so it must be either performed here (--service) or
 * explicitly asserted by the caller (--assume-stopped). There is deliberately
 * no default: silence must never be read as "the service was stopped".
 *
 *   node scripts/restore-dashboard-db.js --backup <file> --service zylos-dashboard
 *   node scripts/restore-dashboard-db.js --backup <file> --assume-stopped
 *   node scripts/restore-dashboard-db.js --backup <file> --assume-stopped --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
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
console.log(`wal      : ${sizeOf(wal)} bytes${sizeOf(wal) > 0 ? '  <-- would be replayed by a bare cp' : ''}`);
console.log(`shm      : ${sizeOf(shm)} bytes`);

const backupSurvey = survey(backupPath);
console.log(`\nbackup contents  : ${backupSurvey.rows} usage rows, cost $${backupSurvey.cost}, integrity ${backupSurvey.integrity}`);
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

// Keep the pre-restore state recoverable: a failed restore must not be a
// one-way door either.
const aside = `${dbPath}.pre-restore-${Date.now()}`;
try {
  fs.copyFileSync(dbPath, aside);
  for (const [src, suffix] of [[wal, '-wal'], [shm, '-shm']]) {
    if (fs.existsSync(src)) fs.copyFileSync(src, `${aside}${suffix}`);
  }
  console.log(`pre-restore copy: ${aside} (with sidecars, so this restore is itself reversible)`);
} catch (err) {
  die(`Could not set aside the current database: ${err.message}. Nothing was changed.`);
}

// 2. remove the stale sidecars — the step a bare cp omits
for (const [p, label] of [[wal, 'wal'], [shm, 'shm']]) {
  if (fs.existsSync(p)) {
    fs.rmSync(p);
    console.log(`removed stale ${label}`);
  }
}

// 3. put the backup in place
fs.copyFileSync(backupPath, dbPath);
console.log('backup copied into place');

// 4. verify before trusting it
const after = survey(dbPath);
console.log(`\nrestored contents: ${after.rows} usage rows, cost $${after.cost}, integrity ${after.integrity}`);

const ok = after.integrity === 'ok' && after.rows === backupSurvey.rows && after.cost === backupSurvey.cost;
if (!ok) {
  console.error('\nRESTORE VERIFICATION FAILED — the database does not match the backup.');
  console.error(`Put the pre-restore copy back from: ${aside}`);
  process.exit(1);
}
console.log('verified: the database now matches the backup exactly');

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
