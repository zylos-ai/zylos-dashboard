# Usage repair and rollback runbook

Procedure for repairing historical Claude usage rows and for rolling that repair
back. Every step here is executable as written; nothing is left as "and then
restore the backup".

## Why a runbook and not a one-liner

The dashboard database runs with `journal_mode = WAL` (`src/lib/store.js`).
Two consequences drive everything below:

- **`cp backup dashboard.db` does not restore anything.** The stale
  `dashboard.db-wal` stays on disk and SQLite replays it on the next open, so
  the rows the backup was meant to bring back disappear again. The copy reports
  success, so the failure is silent — the operator believes the rollback
  happened. That is strictly more dangerous than an error.
- **Writing to the database file underneath a running service is unsafe**, even
  when the write "works", because the service holds open connections and its own
  WAL state.

So a restore must stop the service, clear the sidecars, copy, and then *verify*.

## What the repair does and does not do

`scripts/recompute-usage-dedup.js` collapses rows that were ingested more than
once for a single API response, back to one row per request.

- **Merges only on request identity** — a `requestId` / `message.id` recovered
  from the transcript on disk.
- **Never merges on token shape.** Grouping by
  `(session_id, model, input, output, cache_read, cache_creation)` describes what
  a request looked like, not which request it was. Two distinct requests in one
  session can match on all of it, and collapsing them deletes a real request and
  its cost with no way to detect or undo it. `--fallback-token-identity` is
  rejected with exit 2 rather than ignored, so an old runbook fails loudly.
- **Leaves rows whose transcript is gone untouched.** No transcript means no
  request identity, so those rows are reported as *not precisely repairable*
  rather than guessed at.

### Legacy token-identity rows: three different numbers

An earlier run of the removed fallback did collapse rows by token shape. Keep
these quantities apart — the surviving count equals the group count, so quoting
it alone reads as though the deleted rows never existed:

| Quantity | Where to read it |
|---|---|
| token-identity groups | `dedup_basis = 'token_identity'` rows in the current DB |
| rows **originally touched** | pre-fallback backup, candidate query below |
| **surviving** rows | same as the group count — one kept per group |
| rows **permanently deleted** | originally touched − surviving |

The deleted rows are unrecoverable, and their cost contribution is unknowable:
wherever two distinct requests shared a token tuple, the surviving total is too
low by the difference. State the disposition in terms of the rows originally
touched and the rows permanently deleted, never the survivor count alone.

Count the rows originally touched from the pre-fallback backup:

```sql
SELECT COUNT(*) FROM metric_points
 WHERE metric_name = 'usage_event' AND source = 'jsonl_usage'
   AND runtime = 'claude'
   AND json_extract(dimensions,'$.uuid') IS NOT NULL
   AND json_extract(dimensions,'$.request_id') IS NULL;
```

## Repair procedure

### 1. Dry run first

```bash
node scripts/recompute-usage-dedup.js
```

Writes nothing. Read the reported counts before going further.

### 2. Apply

```bash
node scripts/recompute-usage-dedup.js --apply
```

The script takes its own online backup immediately before the write and aborts
without changing anything if that backup fails. Note the backup path it prints;
step 4 needs it.

### 3. Annotate legacy keys — REQUIRED, not optional

```bash
node scripts/recompute-usage-dedup.js --annotate-legacy-keys --apply
```

This stamps every surviving token-identity row with `dedup_key_version = 1` and
`precisely_repairable = false`.

**Why it is required.** An unmarked v1 key is indistinguishable from a key
written under whatever rules come later. Any future change to key construction
will then silently reinterpret these rows — which is the exact failure this
finding exists to prevent. A capability that the official path merely *permits*
gets skipped; this step is part of the path.

Verify, and treat a non-zero result as a failed repair:

```sql
-- must return 0
SELECT COUNT(*) FROM metric_points
 WHERE json_extract(dimensions,'$.dedup_basis') = 'token_identity'
   AND (json_extract(dimensions,'$.dedup_key_version') IS NOT 1
        OR json_extract(dimensions,'$.precisely_repairable') IS NOT 0);
```

**If it does not return 0:** the annotation did not fully apply. Re-run step 3;
it is idempotent and only rewrites rows that are missing or disagree on the
markers. If it still does not converge, roll back with step 4 and do not leave
the database in a partially annotated state — a mix of marked and unmarked v1
keys is harder to reason about later than uniformly unmarked ones.

### 4. Verify the repair

```sql
-- no request_id may appear twice
SELECT json_extract(dimensions,'$.request_id') AS rid, COUNT(*) n
  FROM metric_points
 WHERE metric_name = 'usage_event' AND runtime = 'claude'
   AND json_extract(dimensions,'$.request_id') IS NOT NULL
 GROUP BY rid HAVING n > 1;
```

## Rollback procedure

Do not use `cp`. Use the restore script, which performs the whole sequence and
verifies the outcome:

```bash
node scripts/restore-dashboard-db.js \
  --backup ~/zylos/components/dashboard/dashboard.db.pre-dedup-<stamp>.bak \
  --service zylos-dashboard
```

It will:

1. read and integrity-check the backup, and refuse to proceed if it fails
2. stop `zylos-dashboard`, aborting without changes if the stop fails
3. set the current database aside with its `-wal`/`-shm`, so the restore is
   itself reversible
4. remove the stale `-wal`/`-shm` — the step a bare `cp` omits
5. copy the backup into place
6. **verify** row count, cost total and `integrity_check` against the backup,
   and exit non-zero if they disagree
7. start the service again

Preview without touching anything:

```bash
node scripts/restore-dashboard-db.js --backup <file> --assume-stopped --dry-run
```

If the service is managed some other way, stop it yourself and pass
`--assume-stopped`. There is deliberately no default for this: silence must
never be read as "the service was stopped".

### If verification fails

The script prints the path of the pre-restore copy it set aside. Put that back
(same procedure, `--backup <that copy>`) and investigate before retrying. A
failed restore is not a one-way door.

## Do not

- Do not run the repair script against a production database without reading the
  dry-run output first.
- Do not roll back with `cp`, `mv`, or by hand-assembling `.db`/`-wal`/`-shm`.
- Do not reconstruct deleted rows from a token tuple, a time window, or any
  other shape-based heuristic. Where the transcript is gone, the answer is
  unknown, and recording it as unknown is the correct outcome.
