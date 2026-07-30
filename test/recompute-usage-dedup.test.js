import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

// Not import.meta.dirname: that needs Node 20.11, while this package declares >=20.
const HERE = path.dirname(fileURLToPath(import.meta.url));

const SCRIPT = path.join(HERE, '..', 'scripts', 'recompute-usage-dedup.js');

/** Minimal metric_points table — the script only reads and writes this one. */
function makeDb(dir) {
  const dbPath = path.join(dir, 'dashboard.db');
  const db = new Database(dbPath);
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
  return { db, dbPath };
}

function insertUsage(db, { ts, runtime = 'claude', session, dims, value = 0 }) {
  return db.prepare(`
    INSERT INTO metric_points (timestamp, runtime, session_id, metric_name, metric_value, dimensions, source)
    VALUES (?, ?, ?, 'usage_event', ?, ?, 'jsonl_usage')
  `).run(ts, runtime, session, value, JSON.stringify(dims)).lastInsertRowid;
}

/** Write a transcript so the script can map these uuids to a requestId. */
function writeTranscript(dir, sessionId, records) {
  const projDir = path.join(dir, 'projects', '-test');
  fs.mkdirSync(projDir, { recursive: true });
  const lines = records.map((r) => JSON.stringify({
    type: 'assistant',
    uuid: r.uuid,
    requestId: r.requestId,
    sessionId,
    message: { id: r.messageId || 'msg_x', usage: {} }
  }));
  fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

function run(dbPath, transcripts, extraArgs = []) {
  return spawnSync(process.execPath, [SCRIPT, '--db', dbPath, '--transcripts', transcripts, ...extraArgs], {
    encoding: 'utf8'
  });
}

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-test-'));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  return dir;
}

// Negative control, and which half of it actually discriminates.
//
// Fixture: one session, one model, two rows with identical input / output /
// cache_read / cache_creation, five minutes apart, no surviving transcript — so
// nothing can tell them apart. Measured against the reviewed head b5b9e7d:
//
//   b5b9e7d + --fallback-token-identity --apply  -> 2 rows become 1  (a real
//                                                   request and its cost gone)
//   b5b9e7d + --apply                            -> 2 rows kept
//   this   + --fallback-token-identity --apply    -> exit 2, 2 rows kept
//   this   + --apply                             -> 2 rows kept
//
// So the test below is a REGRESSION GUARD, not the proof: the old code also
// kept both rows in plain --apply. The discriminating test is the next one —
// the merging capability is gone and asking for it fails. Both are kept
// deliberately, because a future change could reintroduce merging in either
// place.
test('two distinct requests sharing a token tuple are both kept (regression guard)', () => {
  const dir = tmp();
  const { db, dbPath } = makeDb(dir);
  const shape = { model: 'claude-sonnet-5', input: 4, output: 120, cache_read: 9000, cache_creation: 2200, cost: 0.5 };
  const a = insertUsage(db, { ts: '2026-07-01T10:00:00.000Z', session: 's1', dims: { ...shape, uuid: 'uuid-a' } });
  const b = insertUsage(db, { ts: '2026-07-01T10:05:00.000Z', session: 's1', dims: { ...shape, uuid: 'uuid-b' } });
  db.close();

  const res = run(dbPath, path.join(dir, 'projects'), ['--apply']);
  assert.equal(res.status, 0, res.stderr);

  const after = new Database(dbPath, { readonly: true });
  const ids = after.prepare('SELECT id FROM metric_points ORDER BY id').all().map((r) => r.id);
  after.close();
  assert.deepEqual(ids, [a, b], 'both rows must survive: token shape is not a request identity');
});

// The discriminating half: on b5b9e7d this same fixture and flag collapsed the
// two rows into one and exited 0.
test('NEGATIVE CONTROL: the removed --fallback-token-identity flag fails loudly and writes nothing', () => {
  const dir = tmp();
  const { db, dbPath } = makeDb(dir);
  const shape = { model: 'claude-sonnet-5', input: 4, output: 120, cache_read: 9000, cache_creation: 2200, cost: 0.5 };
  insertUsage(db, { ts: '2026-07-01T10:00:00.000Z', session: 's1', dims: { ...shape, uuid: 'uuid-a' } });
  insertUsage(db, { ts: '2026-07-01T10:05:00.000Z', session: 's1', dims: { ...shape, uuid: 'uuid-b' } });
  db.close();

  const res = run(dbPath, path.join(dir, 'projects'), ['--fallback-token-identity', '--apply']);
  assert.notEqual(res.status, 0, 'a stale runbook passing the old flag must fail, not silently change meaning');
  assert.match(res.stderr, /has been removed/);

  const after = new Database(dbPath, { readonly: true });
  assert.equal(after.prepare('SELECT COUNT(*) n FROM metric_points').get().n, 2);
  after.close();
});

test('exact mapping still collapses one request ingested as several rows', () => {
  const dir = tmp();
  const { db, dbPath } = makeDb(dir);
  const base = { model: 'claude-sonnet-5', input: 4, output: 120, cache_read: 9000, cache_creation: 2200, cost: 0.5 };
  // Same request, three content-block lines. The last carries the fullest usage.
  insertUsage(db, { ts: '2026-07-01T10:00:00.000Z', session: 's1', dims: { ...base, uuid: 'u1' } });
  insertUsage(db, { ts: '2026-07-01T10:00:01.000Z', session: 's1', dims: { ...base, uuid: 'u2' } });
  const fullest = insertUsage(db, {
    ts: '2026-07-01T10:00:02.000Z', session: 's1',
    dims: { ...base, uuid: 'u3', output: 300 }
  });
  db.close();
  writeTranscript(dir, 's1', [
    { uuid: 'u1', requestId: 'req_1' },
    { uuid: 'u2', requestId: 'req_1' },
    { uuid: 'u3', requestId: 'req_1' }
  ]);

  const res = run(dbPath, path.join(dir, 'projects'), ['--apply']);
  assert.equal(res.status, 0, res.stderr);

  const after = new Database(dbPath, { readonly: true });
  const rows = after.prepare('SELECT id, dimensions FROM metric_points').all();
  after.close();
  assert.equal(rows.length, 1, 'three rows of one request collapse to one');
  assert.equal(rows[0].id, fullest, 'the most complete reading is the one kept');
  assert.equal(JSON.parse(rows[0].dimensions).request_id, 'req_1');
});

test('non-claude runtime rows are out of scope even when they carry a uuid', () => {
  const dir = tmp();
  const { db, dbPath } = makeDb(dir);
  const shape = { model: 'gpt-x', input: 4, output: 120, cache_read: 0, cache_creation: 0, cost: 0.1, uuid: 'cx-1' };
  const codex = insertUsage(db, { ts: '2026-07-01T10:00:00.000Z', runtime: 'codex', session: 's9', dims: shape });
  const codex2 = insertUsage(db, { ts: '2026-07-01T10:00:01.000Z', runtime: 'codex', session: 's9', dims: { ...shape, uuid: 'cx-2' } });
  db.close();
  // A transcript that would map both codex uuids onto one request, to prove the
  // runtime scope is what excludes them rather than the absence of a mapping.
  writeTranscript(dir, 's9', [
    { uuid: 'cx-1', requestId: 'req_codex' },
    { uuid: 'cx-2', requestId: 'req_codex' }
  ]);

  const res = run(dbPath, path.join(dir, 'projects'), ['--apply']);
  assert.equal(res.status, 0, res.stderr);

  const after = new Database(dbPath, { readonly: true });
  const ids = after.prepare('SELECT id FROM metric_points ORDER BY id').all().map((r) => r.id);
  after.close();
  assert.deepEqual(ids, [codex, codex2], 'codex rows must not be merged by the claude repair path');
});

test('--annotate-legacy-keys marks legacy fallback rows without rewriting their cost', () => {
  const dir = tmp();
  const { db, dbPath } = makeDb(dir);
  const dims = {
    model: 'claude-opus-5', input: 3, output: 90, cache_read: 100, cache_creation: 50, cost: 0.25,
    dedup_basis: 'token_identity', dedup_key: 'tis1claude-opus-539010050'
  };
  const id = insertUsage(db, { ts: '2026-07-01T10:00:00.000Z', session: 's1', dims, value: 143 });
  db.close();

  const res = run(dbPath, path.join(dir, 'projects'), ['--annotate-legacy-keys', '--apply']);
  assert.equal(res.status, 0, res.stderr);

  const after = new Database(dbPath, { readonly: true });
  const row = after.prepare('SELECT id, metric_value, dimensions FROM metric_points').get();
  after.close();
  const d = JSON.parse(row.dimensions);
  assert.equal(row.id, id, 'legacy rows are retained, never deleted');
  assert.equal(row.metric_value, 143, 'annotating a boundary must not restate a value');
  assert.equal(d.cost, 0.25, 'cost is untouched');
  assert.equal(d.dedup_key_version, 1);
  assert.equal(d.precisely_repairable, false);
  assert.equal(d.dedup_key, dims.dedup_key, 'the v1 key itself is preserved verbatim');
});

test('the script never advertises a bare cp as the rollback, and documents no phantom guard', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  // The reviewed head printed `cp "<backup>" "<db>"`, which cannot restore a
  // WAL-mode database and fails silently while looking like it worked.
  assert.doesNotMatch(source, /cp "\$\{backupPath\}"/, 'no bare-cp restore instruction');
  assert.match(source, /restore-dashboard-db\.js/, 'points at the restore script instead');
  // The header once claimed a "backup exists or --no-backup-check" guard that
  // was never implemented. Either implement it or stop claiming it. The flag is
  // still named in the header, but only to record that it never existed, so
  // assert on the promise rather than on the mention.
  assert.doesNotMatch(source, /refuses to run unless a backup exists/, 'no phantom guard promised');
  assert.doesNotMatch(source, /has\('--no-backup-check'\)/, 'and none implemented either');
  assert.match(source, /never implemented/, 'the removal is recorded rather than left ambiguous');
});

test('an unannotated legacy row is reported as a required follow-up, not an optional extra', () => {
  const dir = tmp();
  const { db, dbPath } = makeDb(dir);
  insertUsage(db, {
    ts: '2026-07-01T10:00:00.000Z', session: 's1',
    dims: { model: 'claude-opus-5', cost: 1.5, dedup_basis: 'token_identity', dedup_key: 'k' }
  });
  db.close();

  const res = run(dbPath, path.join(dir, 'projects'));
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /REQUIRED step, not an optional extra/);
  // The survivor count must not be presented as the whole story: it equals the
  // group count, so quoting it alone hides the deleted rows.
  assert.match(res.stdout, /surviving rows here/);
  assert.match(res.stdout, /rows originally touched/);
});

test('legacy rows are reported as retained and not precisely repairable in a dry run', () => {
  const dir = tmp();
  const { db, dbPath } = makeDb(dir);
  insertUsage(db, {
    ts: '2026-07-01T10:00:00.000Z', session: 's1',
    dims: { model: 'claude-opus-5', cost: 1.5, dedup_basis: 'token_identity', dedup_key: 'k' }
  });
  db.close();

  const res = run(dbPath, path.join(dir, 'projects'));
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /RETAINED as-is/);
  assert.match(res.stdout, /DRY RUN/);
});
