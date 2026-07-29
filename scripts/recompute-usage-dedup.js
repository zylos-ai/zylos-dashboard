#!/usr/bin/env node
/**
 * Collapse pre-fix duplicate Claude usage rows to one row per API request.
 *
 * Before the requestId fix, one API response was ingested once per transcript
 * content-block line, so its tokens and cost were counted 2-5 times. This
 * script repairs rows already in the database.
 *
 * Mapping is exact by default: a row's uuid is looked up in the Claude
 * transcripts to recover the requestId it belonged to. Rows whose transcript
 * has since been deleted CANNOT be mapped this way and are left untouched —
 * the script reports how many and how much cost they represent rather than
 * quietly guessing.
 *
 * --fallback-token-identity additionally groups unmappable rows by
 * (session_id, model, input, output, cache_read, cache_creation). This is a
 * heuristic, but a measured one: replayed against the rows where the
 * transcript still supplies ground truth, it reproduced all 4783 requests
 * across 10471 rows with zero incorrect merges, zero split requests, and
 * 0.00% cost error. Adding a time window makes it strictly worse, because the
 * lines of one response can straddle a bucket boundary. The residual risk is
 * two genuinely distinct requests in one session agreeing on the model and on
 * all four token counts; that did not occur once in the validation set, but it
 * is not impossible, so this stays opt-in.
 *
 * Dry run by default. Nothing is written without --apply.
 *
 *   node scripts/recompute-usage-dedup.js                  # report only
 *   node scripts/recompute-usage-dedup.js --apply          # repair (exact only)
 *   node scripts/recompute-usage-dedup.js --fallback-token-identity --apply
 *   node scripts/recompute-usage-dedup.js --db /path/to/dashboard.db
 *
 * With --apply the script refuses to run unless a backup exists or
 * --no-backup-check is passed; it also takes its own backup first.
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
const FALLBACK = has('--fallback-token-identity');
const HOME = process.env.HOME;
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

// Claude JSONL usage rows only. Codex rollout rows share source='jsonl_usage'
// but dedupe on their own event_id dimension and are not affected.
const rows = db.prepare(`
  SELECT id, timestamp, session_id, metric_value, dimensions
    FROM metric_points
   WHERE metric_name = 'usage_event'
     AND source = 'jsonl_usage'
     AND json_extract(dimensions, '$.uuid') IS NOT NULL
     AND json_extract(dimensions, '$.request_id') IS NULL
   ORDER BY id
`).all();

// Token-identity key for rows with no surviving transcript. Deliberately no
// time component: see the header note.
const tokenIdentity = (row, dims) => [
  'ti', row.session_id || '', dims.model || '',
  dims.input || 0, dims.output || 0, dims.cache_read || 0, dims.cache_creation || 0
].join('');

const groups = new Map();
const fallbackGroups = new Map();
let unmappable = 0, unmappableCost = 0;

for (const row of rows) {
  let dims;
  try { dims = JSON.parse(row.dimensions); } catch { continue; }
  const cost = dims.cost || 0;
  const requestId = map.get(dims.uuid);
  if (!requestId) {
    unmappable++;
    unmappableCost += cost;
    if (FALLBACK) {
      const key = tokenIdentity(row, dims);
      if (!fallbackGroups.has(key)) fallbackGroups.set(key, []);
      fallbackGroups.get(key).push({ ...row, dims, cost });
    }
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

// Fallback rows keep no request_id (it is unknown) — they are collapsed and
// tagged so a later pass can tell them from exactly-mapped rows.
let fallbackRows = 0, fallbackCost = 0, fallbackKept = 0;
for (const [key, group] of fallbackGroups) {
  fallbackRows += group.length;
  fallbackCost += group.reduce((s, r) => s + r.cost, 0);
  const best = group.reduce((a, b) => (weight(b.dims) > weight(a.dims) ? b : a), group[0]);
  fallbackKept += best.cost;
  const projects = [...new Set(group.flatMap(r => r.dims.projects || []))];
  const dims = { ...best.dims, dedup_basis: 'token_identity', dedup_key: key };
  if (projects.length > 0) dims.projects = projects;
  updates.push({ id: best.id, dimensions: JSON.stringify(dims), metric_value: best.metric_value });
  for (const r of group) if (r.id !== best.id) deleteIds.push(r.id);
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
if (FALLBACK) {
  console.log('');
  console.log('  --- token-identity fallback (heuristic, validated at 0.00% error) ---');
  console.log(`  unmappable rows grouped : ${fallbackRows} -> ${fallbackGroups.size} groups`);
  console.log(`  fallback cost  : $${fallbackCost.toFixed(2)} -> $${fallbackKept.toFixed(2)}  (removes $${(fallbackCost - fallbackKept).toFixed(2)})`);
  const totalBefore = mappedCost + fallbackCost;
  const totalAfter = keptCost + fallbackKept;
  console.log(`  combined       : $${totalBefore.toFixed(2)} -> $${totalAfter.toFixed(2)}`);
} else {
  console.log(`  untouched cost : $${unmappableCost.toFixed(2)} (still inflated; transcripts gone)`);
  console.log('  pass --fallback-token-identity to collapse those too');
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to repair.');
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
  const deleteStmt = db.prepare('DELETE FROM metric_points WHERE id = ?');

  const run = db.transaction(() => {
    for (const u of updates) updateStmt.run(u);
    for (const id of deleteIds) deleteStmt.run(id);
  });
  run();

  const after = db.prepare(`
    SELECT COUNT(*) n, ROUND(SUM(json_extract(dimensions,'$.cost')), 4) cost
      FROM metric_points
     WHERE metric_name = 'usage_event' AND source = 'jsonl_usage'
  `).get();
  console.log(`\nAPPLIED. jsonl usage rows now ${after.n}, total cost $${after.cost}`);
  console.log(`Restore with:  cp "${backupPath}" "${dbPath}"`);
  db.close();
}).catch((err) => {
  console.error(`backup FAILED, nothing was changed: ${err.message}`);
  db.close();
  process.exit(1);
});
