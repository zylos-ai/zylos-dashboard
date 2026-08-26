#!/usr/bin/env node
/**
 * Collapse pre-fix duplicate Claude usage rows to one row per API request.
 *
 * Before the requestId fix, one API response was ingested once per transcript
 * content-block line, so its tokens and cost were counted 2-5 times. This
 * script repairs rows already in the database.
 *
 * Mapping is exact, and only exact: a row's uuid is looked up in the Claude
 * transcripts to recover the requestId it belonged to. Rows whose transcript
 * has since been deleted CANNOT be mapped this way and are left untouched —
 * the script reports how many and how much cost they represent rather than
 * quietly guessing.
 *
 * There is deliberately NO token-identity fallback. Grouping unmappable rows
 * by (session_id, model, input, output, cache_read, cache_creation) describes
 * the SHAPE of a request, not its identity: two genuinely distinct requests in
 * one session can agree on the model and on all four token counts, and
 * collapsing them deletes a real request and its cost irreversibly, with no
 * way to detect or undo it once the transcript is gone. A low collision rate
 * measured over the rows where ground truth still exists says nothing about
 * the rows where it does not. --fallback-token-identity is therefore rejected
 * rather than ignored, so an old runbook or cron entry fails loudly instead of
 * silently changing meaning.
 *
 * Rows that an earlier run already collapsed by that fallback are RETAINED
 * exactly as they are: they are neither re-merged nor split, because their true
 * requestIds are permanently unknowable. --annotate-legacy-keys stamps them
 * with dedup_key_version and precisely_repairable:false, so later code cannot
 * silently reinterpret a v1 key under new key rules.
 *
 * Dry run by default. Nothing is written without --apply.
 *
 *   node scripts/recompute-usage-dedup.js                  # report only
 *   node scripts/recompute-usage-dedup.js --apply          # repair (exact only)
 *   node scripts/recompute-usage-dedup.js --annotate-legacy-keys --apply
 *   node scripts/recompute-usage-dedup.js --db /path/to/dashboard.db
 *
 * With --apply the script takes its own online backup immediately before the
 * write and aborts without changing anything if that backup fails. It does NOT
 * additionally require a pre-existing backup: an earlier header claimed a
 * "backup exists or --no-backup-check" guard that was never implemented, and
 * documenting a safety check that does not exist is worse than not having one.
 * The flag is gone rather than added, because the script's own pre-write backup
 * is what a rollback actually needs.
 *
 * Rolling back is NOT `cp backup dashboard.db`. The database runs in WAL mode,
 * so a bare copy leaves the stale -wal on disk to be replayed and the rollback
 * silently does not happen. Use scripts/restore-dashboard-db.js, and see
 * docs/usage-repair-runbook.md for the full procedure.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f, dflt) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const APPLY = has('--apply');
const ANNOTATE_LEGACY = has('--annotate-legacy-keys');
const HOME = process.env.HOME;

// Version of the token-identity key written by the removed fallback. Any future
// change to key construction must bump this rather than reinterpret v1 keys.
const LEGACY_KEY_VERSION = 1;

// Refuse the removed flag instead of ignoring it: a stale runbook that still
// passes it must fail, not quietly run with different semantics.
if (has('--fallback-token-identity')) {
  console.error('--fallback-token-identity has been removed.');
  console.error('');
  console.error('It grouped rows by (session_id, model, input, output, cache_read,');
  console.error('cache_creation), which is the shape of a request and not its identity.');
  console.error('Two distinct real requests can share that tuple, and collapsing them');
  console.error('deletes a real request and its cost with no way to detect or undo it.');
  console.error('Only requestId / message.id recovered from a transcript may merge rows.');
  console.error('');
  console.error('Rows an earlier run already collapsed this way are retained as-is; see');
  console.error('--annotate-legacy-keys to mark them not precisely repairable.');
  process.exit(2);
}
const dbPath = valueOf('--db', path.join(HOME, 'zylos', 'components', 'dashboard', 'dashboard.db'));
const projectsDir = valueOf('--transcripts', path.join(HOME, '.claude', 'projects'));

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

/** uuid -> requestId, across every transcript on disk. */
function buildUuidToRequest(root) {
  const map = new Map();
  let files = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      files++;
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec.type !== 'assistant' || !rec.message || !rec.uuid) continue;
        map.set(rec.uuid, rec.requestId || rec.message.id || rec.uuid);
      }
    }
  };
  walk(root);
  return { map, files };
}

console.log(`database    : ${dbPath}`);
console.log(`transcripts : ${projectsDir}`);
const { map, files } = buildUuidToRequest(projectsDir);
console.log(`scanned ${files} transcript files -> ${map.size} uuid->request mappings\n`);

const db = new Database(dbPath, { readonly: !APPLY });

// Claude JSONL usage rows only. runtime is scoped explicitly: Codex rollout
// rows share source='jsonl_usage' and dedupe on their own event_id dimension,
// and relying on them merely happening to carry no uuid is too loose a boundary
// for a script that deletes rows.
const rows = db.prepare(`
  SELECT id, timestamp, session_id, metric_value, dimensions
    FROM metric_points
   WHERE metric_name = 'usage_event'
     AND source = 'jsonl_usage'
     AND runtime = 'claude'
     AND json_extract(dimensions, '$.uuid') IS NOT NULL
     AND json_extract(dimensions, '$.request_id') IS NULL
   ORDER BY id
`).all();

const groups = new Map();
let unmappable = 0, unmappableCost = 0;

for (const row of rows) {
  let dims;
  try { dims = JSON.parse(row.dimensions); } catch { continue; }
  const cost = dims.cost || 0;
  const requestId = map.get(dims.uuid);
  if (!requestId) {
    // No surviving transcript means no request identity, so this row is not
    // repairable. Left alone on purpose, never grouped by token shape.
    unmappable++;
    unmappableCost += cost;
    continue;
  }
  if (!groups.has(requestId)) groups.set(requestId, []);
  groups.get(requestId).push({ ...row, dims, cost });
}

const weight = (d) => (d.input || 0) + (d.output || 0) + (d.cache_read || 0) + (d.cache_creation || 0);

let mappedRows = 0, mappedCost = 0, keptCost = 0, deleteIds = [], updates = [], divergent = 0;

for (const [requestId, group] of groups) {
  mappedRows += group.length;
  mappedCost += group.reduce((s, r) => s + r.cost, 0);

  // Keep the most complete reading; among equals keep the earliest row.
  const best = group.reduce((a, b) => (weight(b.dims) > weight(a.dims) ? b : a), group[0]);
  keptCost += best.cost;
  if (new Set(group.map(r => weight(r.dims))).size > 1) divergent++;

  const projects = [...new Set(group.flatMap(r => r.dims.projects || []))];
  const dims = { ...best.dims, request_id: requestId };
  if (projects.length > 0) dims.projects = projects;

  updates.push({ id: best.id, dimensions: JSON.stringify(dims), metric_value: best.metric_value });
  for (const r of group) if (r.id !== best.id) deleteIds.push(r.id);
}

// Rows an earlier run collapsed by the removed token-identity fallback. They are
// reported, never rewritten by the repair path: without a transcript there is no
// request identity to re-derive, so re-merging or splitting them could only be a
// guess. --annotate-legacy-keys records that boundary in the row itself.
const legacyRows = db.prepare(`
  SELECT id, dimensions
    FROM metric_points
   WHERE metric_name = 'usage_event'
     AND source = 'jsonl_usage'
     AND runtime = 'claude'
     AND json_extract(dimensions, '$.dedup_basis') = 'token_identity'
   ORDER BY id
`).all();

let legacyCost = 0, legacyUnversioned = 0;
const legacyUpdates = [];
for (const row of legacyRows) {
  let dims;
  try { dims = JSON.parse(row.dimensions); } catch { continue; }
  legacyCost += dims.cost || 0;
  if (dims.dedup_key_version === undefined) legacyUnversioned++;
  if (ANNOTATE_LEGACY && (dims.dedup_key_version !== LEGACY_KEY_VERSION || dims.precisely_repairable !== false)) {
    // Only dimensions change here. metric_value is deliberately left alone:
    // annotating a boundary must not restate a cost.
    legacyUpdates.push({
      id: row.id,
      dimensions: JSON.stringify({ ...dims, dedup_key_version: LEGACY_KEY_VERSION, precisely_repairable: false })
    });
  }
}

const pct = (a, b) => (b === 0 ? '0' : (100 * a / b).toFixed(1));
console.log('--- pre-fix Claude usage rows ---');
console.log(`  total                  : ${rows.length}`);
console.log(`  mappable to a request  : ${mappedRows} (${pct(mappedRows, rows.length)}%)  cost $${mappedCost.toFixed(2)}`);
console.log(`  unmappable (no transcript): ${unmappable} (${pct(unmappable, rows.length)}%)  cost $${unmappableCost.toFixed(2)}`);
console.log(`  distinct requests among mappable: ${groups.size}`);
if (groups.size > 0) {
  console.log(`  inflation on mappable rows: ${(mappedRows / groups.size).toFixed(4)}x`);
}
console.log(`  groups whose copies disagree on token totals: ${divergent}`);
console.log('');
console.log('--- effect of repair ---');
console.log(`  rows to delete : ${deleteIds.length}`);
console.log(`  rows to update : ${updates.length} (tagged with request_id, projects merged)`);
console.log(`  mappable cost  : $${mappedCost.toFixed(2)} -> $${keptCost.toFixed(2)}  (removes $${(mappedCost - keptCost).toFixed(2)})`);
console.log(`  untouched cost : $${unmappableCost.toFixed(2)} (transcripts gone, so NOT precisely repairable)`);
console.log('  those rows are left as they are on purpose: no transcript means no');
console.log('  request identity, and token shape is not an identity.');

if (legacyRows.length > 0) {
  console.log('');
  console.log(`--- rows collapsed by the removed token-identity fallback (key v${LEGACY_KEY_VERSION}) ---`);
  // Two different quantities get confused easily, so both are printed. The
  // surviving count equals the group count (one row kept per group), which is
  // exactly why quoting it alone reads as if the deleted rows never existed.
  console.log(`  surviving rows here    : ${legacyRows.length}  (one per token-identity group)  cost $${legacyCost.toFixed(2)}`);
  console.log('  rows originally touched: not derivable from this database — the deleted');
  console.log('                           rows are gone. Read it from the pre-fallback');
  console.log('                           backup if the disposition needs the real figure.');
  console.log(`  without a version marker: ${legacyUnversioned}`);
  console.log('  disposition    : RETAINED as-is. Their true requestIds are permanently');
  console.log('                   unknowable, so they are neither re-merged nor split.');
  console.log('                   A cost figure derived from them can be too low by however');
  console.log('                   many distinct requests happened to share a token tuple.');
  if (ANNOTATE_LEGACY) {
    console.log(`  to annotate    : ${legacyUpdates.length} row(s) will get dedup_key_version=${LEGACY_KEY_VERSION}, precisely_repairable=false`);
  } else if (legacyUnversioned > 0) {
    console.log('');
    console.log(`  ** ${legacyUnversioned} row(s) carry a v${LEGACY_KEY_VERSION} key with no version marker. **`);
    console.log('  Annotating them is a REQUIRED step, not an optional extra: unmarked v1');
    console.log('  keys will be silently reinterpreted by any later code that changes the');
    console.log('  key rules. Re-run with --annotate-legacy-keys --apply.');
    console.log('  See docs/usage-repair-runbook.md.');
  }
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to repair.');
  db.close();
  process.exit(0);
}

if (deleteIds.length === 0 && updates.length === 0 && legacyUpdates.length === 0) {
  console.log('\nNothing to change. No backup taken, no write performed.');
  db.close();
  process.exit(0);
}

// --- write path ---
const backupDir = path.dirname(dbPath);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `${path.basename(dbPath)}.pre-dedup-${stamp}.bak`);
console.log(`\ntaking backup -> ${backupPath}`);
db.backup(backupPath).then(() => {
  const sizeMb = (fs.statSync(backupPath).size / 1e6).toFixed(1);
  console.log(`backup written (${sizeMb} MB)`);

  const updateStmt = db.prepare('UPDATE metric_points SET dimensions = @dimensions, metric_value = @metric_value WHERE id = @id');
  const annotateStmt = db.prepare('UPDATE metric_points SET dimensions = @dimensions WHERE id = @id');
  const deleteStmt = db.prepare('DELETE FROM metric_points WHERE id = ?');

  const run = db.transaction(() => {
    for (const u of updates) updateStmt.run(u);
    for (const id of deleteIds) deleteStmt.run(id);
    for (const u of legacyUpdates) annotateStmt.run(u);
  });
  run();

  const after = db.prepare(`
    SELECT COUNT(*) n, ROUND(SUM(json_extract(dimensions,'$.cost')), 4) cost
      FROM metric_points
     WHERE metric_name = 'usage_event' AND source = 'jsonl_usage'
  `).get();
  console.log(`\nAPPLIED. jsonl usage rows now ${after.n}, total cost $${after.cost}`);
  if (legacyUpdates.length > 0) {
    console.log(`Annotated ${legacyUpdates.length} legacy token-identity row(s) as key v${LEGACY_KEY_VERSION}, precisely_repairable=false.`);
  }
  // NOT `cp backup dashboard.db`. This database is in WAL mode, so a bare copy
  // leaves the stale -wal to be replayed and the rollback silently does not
  // take effect while appearing to succeed.
  console.log('\nTo roll this back:');
  console.log(`  node scripts/restore-dashboard-db.js --backup "${backupPath}" --service zylos-dashboard`);
  console.log('That stops the service, clears the stale -wal/-shm, restores, and verifies');
  console.log('the result against the backup. A bare cp does NOT work under WAL mode.');
  console.log('Full procedure: docs/usage-repair-runbook.md');
  db.close();
}).catch((err) => {
  console.error(`backup FAILED, nothing was changed: ${err.message}`);
  db.close();
  process.exit(1);
});
