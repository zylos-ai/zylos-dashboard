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

- **A byte copy of a WAL database is a torn fragment**, in either direction. The
  same reasoning that makes `cp backup dashboard.db` unsafe makes `cp
  dashboard.db somewhere.bak` unsafe: the copy silently omits whatever is still
  in the `-wal`, and reads correctly right up until it is moved away from its
  sidecars. Every copy must go through SQLite instead.

So a restore must build the replacement through SQLite and *verify it before
stopping anything*, then stop the service, set the current database aside, swap
that same verified file in, discard the stale sidecars, and only then start the
service again.

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

Every file it produces or consumes goes through SQLite itself (`VACUUM INTO`),
never through a byte copy. That is the whole point: a WAL-mode database is a main
file *plus* a `-wal` that may hold committed rows the main file does not, so a
byte copy of one is a torn fragment, while a file SQLite writes out has that
state materialized into it and carries no sidecar of its own.

It will:

1. read the backup **once**, through SQLite, and freeze what it read into a
   self-contained file beside the database — the **frozen artifact**. This is the
   only time the backup is read
2. survey and hash **the artifact** (connection already closed), and refuse to
   proceed unless it passes `integrity_check`. All of this happens **before
   anything is stopped**, so an unusable backup costs nothing — not even downtime
3. stop `zylos-dashboard`, aborting without changes if the stop fails
4. set the current database aside — see *the two pre-restore paths* below
5. re-hash the artifact, and refuse to continue if its bytes changed
6. swap **that same artifact** in by rename, discarding the stale `-wal`/`-shm` —
   the step a bare `cp` omits — and discarding unread anything that has appeared
   beside the artifact
7. re-check the result against the artifact's survey, and that no replayable
   `-wal` remains beside it
8. start the service again — **only if every check above passed**

Note the ordering of 1-2 against 3: everything is checked before the service is
stopped, and what is checked is the file that later gets renamed into place.

### Why the backup is read before the stop, and only once

Inspecting a backup and using it are only meaningful together if they are the
same logical moment. Re-reading the backup after the service is stopped is not
that, and the gap is exploitable rather than theoretical: a stop hook committing
one row into the backup's `-wal` leaves the main file's bytes **identical**, so a
hash of the backup matches; and if the row is not a usage row — an auth session, an
API key, runtime state — the usage row count and cost total are identical too. Both
checks pass and never-inspected content is restored.

Freezing the backup into a self-contained artifact before the stop closes this by
construction rather than by detection:

- the source backup is never opened again, so nothing done to it afterwards can
  reach the live database;
- the artifact has no sidecar and cannot acquire a meaningful one, so hashing it
  is a real provenance statement rather than a statement about one of two files;
- the file that is verified is the file that is renamed into place — not a fresh
  read of anything.

Three negative controls in `test/restore-dashboard-db.test.js` mutate the source
backup during the stop window — its main file, its `-wal`, and a table outside
everything the script compares — and assert that **none of them changes the
result**. The third is the exploit above; it fails on the previous
implementation with the injected session token installed in the live database.

### The two pre-restore paths

Step 4 has two outcomes, and they are **not interchangeable**. The script says
which one happened in that line of its output; read it rather than assuming.

- **Normal path — a self-contained single file.** The live database was readable
  through SQLite, so the copy went through SQLite and any state in its `-wal` is
  materialized into the one file. Restoring from it needs nothing beside it:
  `--backup <that file>`. It can be moved or archived on its own.
- **Fallback path — a raw copy plus its sidecars.** The live database could not
  be read through SQLite (itself a reason people run restores), so the script fell
  back to a byte copy and copied the `-wal`/`-shm` alongside it, labelling the
  line `RAW copy`. This copy is **unusable without those sidecars**: move the main
  file on its own and everything the `-wal` held is silently gone. Keep the whole
  set together, move them as a set, and restore by pointing `--backup` at the main
  file with its sidecars still beside it.

### What the verification does and does not prove

Worth stating exactly, because "verification passed" invites more confidence
than the check earns:

- **Proven:** the database now on disk was built by SQLite from the backup, so
  anything that was in the backup's `-wal` is materialized into the single file;
  it **is** the artifact that was surveyed before the service was stopped,
  byte-identical and swapped in by rename; it opens cleanly; it passes
  `integrity_check`; it reports the same usage row count and cost total as that
  artifact; and no replayable `-wal` is left beside it.
- **Not proven:** that the backup itself contained the state you wanted — a
  restore of the wrong backup verifies perfectly. Nor that nothing writes to the
  database after the check; verification is a point-in-time statement, which is
  why the service is only started afterwards.

The hash is of the artifact, not of the source backup. On a WAL-mode database a
main-file hash is close to worthless — two databases with identical main files can
differ entirely in their sidecars — so it only becomes a provenance guarantee once
it is taken of a file that has no sidecar. The source backup's hash is printed for
the audit trail and deliberately never re-checked: after the artifact exists,
nothing about the source can affect the outcome.

Preview without touching anything:

```bash
node scripts/restore-dashboard-db.js --backup <file> --assume-stopped --dry-run
```

If the service is managed some other way, stop it yourself and pass
`--assume-stopped`. There is deliberately no default for this: silence must
never be read as "the service was stopped".

### If verification fails, or the replacement cannot be built

The service is **left stopped on purpose** — the script will not start it against
a restore that did not complete, and says so on stderr. It prints the path of the
pre-restore copy it set aside. A failed restore is not a one-way door.

A backup that cannot be materialized at all (a full disk, a truncated file) fails
in step 1-2, **before the service is stopped**. The script says `Nothing was
stopped` and there is no downtime and nothing to undo.

In the remaining pre-swap failure modes — the artifact's bytes changed, or the
pre-restore copy could not be made — the failure still happens before anything is
swapped, so `dashboard.db` is untouched and needs nothing done to it. The script
says `was NOT touched` when that is the case; take it literally.

Only a failure during or after the swap itself leaves a database that must not be
served. There the script names the pre-restore copy to put back and does not reach
the start step. **Which procedure to use depends on which of the two pre-restore
paths produced it** — see *the two pre-restore paths* above, and read the label on
that line of output: for the normal path, `--backup <that copy>`; for a `RAW copy`,
its `-wal`/`-shm` must be beside it or the rollback silently loses whatever the
`-wal` held.

All of these paths are covered in `test/restore-dashboard-db.test.js`, using a
fake `pm2` on `PATH` that records every invocation — so "the service was not
restarted", and for an unusable backup "the service was never stopped at all",
are asserted from observed behaviour rather than read off the source. The same
technique asserts that `--assume-stopped` invokes no service manager at all.

## Do not

- Do not run the repair script against a production database without reading the
  dry-run output first.
- Do not roll back with `cp`, `mv`, or by hand-assembling `.db`/`-wal`/`-shm`.
- Do not reconstruct deleted rows from a token tuple, a time window, or any
  other shape-based heuristic. Where the transcript is gone, the answer is
  unknown, and recording it as unknown is the correct outcome.
