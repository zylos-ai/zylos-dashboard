import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

// Pre-acceptance helper experiment only: this does not exercise the product adapter.
const args = process.argv.slice(2);
assert.equal(args.length, 4, 'usage: native-helper-probe.mjs --helper-dir ABS --output-dir ABS (fresh path)');
const options = {};
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--helper-dir', '--output-dir'].includes(args[i]) && !options[args[i]], 'invalid/duplicate option');
  assert.ok(path.isAbsolute(args[i + 1]), 'paths must be absolute');
  options[args[i]] = args[i + 1];
}
assert.ok(options['--helper-dir'] && options['--output-dir']);
if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error(`UNSUPPORTED: native linux x64 required; actual ${process.platform} ${process.arch}`);
}
assert.ok(process.getuid() !== 0 && process.geteuid() !== 0, 'unprivileged UID required');
const root = options['--output-dir'];
fs.mkdirSync(root, { mode: 0o700 }); // EEXIST intentionally refuses re-use, including symlinks.
const guardian = path.join(options['--helper-dir'], 'linux-guardian');
const marked = path.join(options['--helper-dir'], 'marked-exec');
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(root, 'probe-fixture');
const identities = [];
const children = [];
const runStarted = performance.now();
let sequence = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function record(event) {
  const monotonicMs = performance.now();
  fs.appendFileSync(path.join(root, 'events.jsonl'), `${JSON.stringify({ monotonicMs, runElapsedMs: monotonicMs - runStarted, ...event })}\n`, { mode: 0o600 });
}
function command(bin, argv, timeout = 1500) {
  const r = spawnSync(bin, argv, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  record({ event: 'command', bin, argv, status: r.status, signal: r.signal, error: r.error?.message, stdout: r.stdout, stderr: r.stderr });
  if (r.error) throw r.error;
  return r;
}
// Independent /proc oracle: never interpret permission/parse failure as absence.
function proc(pid) {
  let stat, uid;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    uid = fs.statSync(`/proc/${pid}`).uid;
  }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') return null; throw e; }
  const end = stat.lastIndexOf(') ');
  assert.ok(end > 0, 'malformed proc stat');
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  assert.ok(fields.length > 19 && /^\d+$/.test(fields[19]), 'missing proc start ticks');
  assert.ok(/^\d+$/.test(fields[1]), 'missing proc parent PID');
  return { pid, ticks: fields[19], state: fields[0], parentPid: Number(fields[1]), uid };
}
function remember(pid, role) {
  const id = proc(pid);
  assert.ok(id && id.uid === process.getuid(), `missing/wrong UID fixture ${pid}`);
  const value = { ...id, role }; identities.push(value); record({ event: 'identity-snapshot', ...value }); return value;
}
function markerDescriptors(pid, marker) {
  const target = fs.statSync(marker, { bigint: true });
  const matches = [];
  for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
    let st;
    try { st = fs.statSync(`/proc/${pid}/fd/${fd}`, { bigint: true }); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (st.dev !== target.dev || st.ino !== target.ino) continue;
    const info = fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8');
    const position = /^pos:\s+(\d+)$/m.exec(info);
    assert.ok(position, 'fdinfo position unavailable');
    matches.push({ fd: Number(fd), position: position[1] });
  }
  const expected = String(0x5a170000n + (target.ino & 0xfffffn));
  record({ event: 'independent-marker-fds', pid, matches, expected });
  return { matches, expected };
}
function alive(id) {
  return classify(id).classification === 'live';
}
function classify(id) {
  const current = proc(id.pid);
  const classification = !current ? 'absent' : current.ticks !== id.ticks ? 'reused' : ['Z', 'X', 'x'].includes(current.state) ? 'terminated-zombie' : 'live';
  return { original: id, current, classification };
}
function safeKill(id) {
  const current = classify(id);
  if (current.classification !== 'live') return;
  assert.equal(current.current.uid, process.getuid());
  const killed = command(fixture, ['cleanup', String(id.pid), id.ticks]);
  assert.equal(killed.status, 0, `pidfd cleanup failed closed for ${id.pid}`);
  record({ event: 'exact-fixture-cleanup', ...id });
}
async function until(test, label, timeout = 2500) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { if (await test()) return; await pause(25); }
  throw new Error(`timeout: ${label}`);
}
function launch(bin, argv, label, pipes = false) {
  const log = path.join(root, `${++sequence}-${label}.log`);
  const fd = fs.openSync(log, 'wx', 0o600);
  const child = spawn(bin, argv, { stdio: ['ignore', fd, fd, ...(pipes ? ['pipe'] : [])] });
  children.push(child);
  child.on('exit', (code, signal) => record({ event: 'child-reaped', pid: child.pid, label, code, signal }));
  fs.closeSync(fd);
  child.on('error', (e) => record({ event: 'spawn-error', label, error: e.message }));
  if (pipes) child.stdio[3].on('error', () => {});
  return { child, log };
}
async function fixtureProcess(mode, dir, marker) {
  const report = path.join(dir, `${mode}.pid`);
  const isMarked = mode === 'daemon' || mode === 'family';
  const executable = isMarked ? marked : fixture;
  const argv = isMarked ? [marker, fixture, mode, report, marker] : [mode, report, marker || '-'];
  const launched = launch(executable, argv, mode);
  // The launcher is ours too, even though daemonizing launchers exit quickly.
  const launcher = proc(launched.child.pid);
  if (launcher) {
    assert.equal(launcher.uid, process.getuid());
    identities.push({ ...launcher, role: `${mode}-launcher` });
    record({ event: 'identity-snapshot', ...launcher, role: `${mode}-launcher` });
  }
  await until(() => fs.existsSync(report) && /^\d+\n$/.test(fs.readFileSync(report, 'utf8')), `${mode} ready`);
  return remember(Number(fs.readFileSync(report, 'utf8').trim()), mode);
}
async function census(marker, deadline = performance.now() + 2500, onUnknown = () => {}) {
  for (;;) {
    const remaining = Math.floor(deadline - performance.now());
    assert.ok(remaining > 0, 'census did not recover before deadline (never treated as empty)');
    const r = command(guardian, ['census', `fdpath:${marker}`], Math.min(1500, remaining));
    if (r.status === 5) {
      onUnknown();
      record({ event: 'census-retry', delayMs: 100, deadlineMonotonicMs: deadline });
      assert.ok(performance.now() + 100 < deadline, 'census failed closed until deadline (not an empty census)');
      await pause(100);
      continue;
    }
    assert.ok(r.status === 0 || r.status === 2, 'unexpected census failure (not an empty census)');
    const rows = r.stdout.trim().split('\n').filter(Boolean).map((s) => JSON.parse(s));
    const count = rows.find((row) => row.event === 'count');
    const owned = rows.filter((row) => row.event === 'owned');
    assert.equal(count?.count, owned.length);
    assert.equal(r.status, owned.length ? 2 : 0);
    return owned;
  }
}
function helperIdentity(pid) {
  const r = command(guardian, ['identity', String(pid)]);
  assert.equal(r.status, 0); return JSON.parse(r.stdout.trim());
}
async function cleanOracle(marker, originals, started) {
  let zeroSince;
  const deadline = started + 10000;
  record({ event: 'oracle-start', triggerMonotonicMs: started, deadlineMonotonicMs: deadline });
  await until(async () => {
    const classifications = originals.map(classify);
    const survivors = classifications.filter((id) => id.classification === 'live');
    const owned = await census(marker, deadline, () => { zeroSince = undefined; });
    record({ event: 'whole-set-oracle', classifications, survivors, owned, triggerElapsedMs: performance.now() - started });
    if (survivors.length || owned.length) { zeroSince = undefined; return false; }
    zeroSince ??= performance.now();
    return performance.now() - zeroSince >= 1000;
  }, 'whole owned set and original helper identities gone', Math.max(1, 10000 - (performance.now() - started)));
  assert.ok(performance.now() - started <= 10000, 'cleanup exceeded 10 second wall bound');
  record({ event: 'oracle-pass', triggerMonotonicMs: started, triggerElapsedMs: performance.now() - started, quietElapsedMs: performance.now() - zeroSince });
}
let failed;
try {
  const build = command('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', path.join(here, 'probe-fixture.c'), '-o', fixture], 10000);
  assert.equal(build.status, 0, 'fixture build failed');
  const parent = helperIdentity(process.pid);
  const sentinel = await fixtureProcess('sentinel', root);
  // A PID-only same_identity mutant must fail this without exposing any fixture
  // to a signal: the marker is freshly created and never opened by a process.
  const emptyMarker = path.join(root, 'identity-empty.marker');
  fs.writeFileSync(emptyMarker, 'empty identity control\n', { flag: 'wx', mode: 0o600 });
  assert.deepEqual(await census(emptyMarker), []);
  const correct = command(guardian, ['reconcile', String(process.pid), String(parent.startSec), String(parent.startUsec), `fdpath:${emptyMarker}`, '8000']);
  assert.equal(correct.status, 4, 'correct start ticks must refuse a live parent');
  const identityStarted = performance.now();
  record({ event: 'trigger', mode: 'identity-mismatch', triggerMonotonicMs: identityStarted });
  const mismatch = command(guardian, ['reconcile', String(process.pid), String(BigInt(parent.startSec) + 1n), String(parent.startUsec), `fdpath:${emptyMarker}`, '8000'], 8500);
  assert.equal(mismatch.status, 0, 'same PID with wrong start ticks must reconcile empty marker, not report parent-alive');
  assert.match(mismatch.stdout, /"event":"clean"/);
  assert.doesNotMatch(mismatch.stdout, /"event":"(?:term|kill|owned|parent-alive)"/);
  await cleanOracle(emptyMarker, [], identityStarted);
  assert.ok(alive(sentinel));
  record({ event: 'case-pass', mode: 'identity-mismatch', triggerElapsedMs: performance.now() - identityStarted });
  for (const mode of ['graceful', 'abrupt', 'omitted-control']) {
    const caseStarted = performance.now();
    record({ event: 'case-start', mode });
    const dir = path.join(root, mode); fs.mkdirSync(dir, { mode: 0o700 });
    const marker = path.join(dir, 'marker'); fs.writeFileSync(marker, 'isolated probe marker\n', { flag: 'wx', mode: 0o600 });
    const hardlink = path.join(dir, 'marker-hardlink'); fs.linkSync(marker, hardlink);
    const reader = await fixtureProcess('reader', dir, hardlink);
    const daemon = await fixtureProcess('daemon', dir, marker);
    const family = await fixtureProcess('family', dir, marker);
    const childReport = path.join(dir, 'family.pid.child');
    await until(() => fs.existsSync(childReport) && /^\d+\n$/.test(fs.readFileSync(childReport, 'utf8')), 'unmarked descendant ready');
    const descendant = remember(Number(fs.readFileSync(childReport, 'utf8').trim()), 'unmarked-descendant');
    assert.equal(proc(descendant.pid).parentPid, family.pid, 'unmarked child must remain attached to its marked parent');
    assert.deepEqual(markerDescriptors(descendant.pid, marker).matches, [], 'closure fixture child retained marker');
    const familyFds = markerDescriptors(family.pid, marker);
    assert.ok(familyFds.matches.some((fd) => fd.position === familyFds.expected));
    const readerFds = markerDescriptors(reader.pid, marker);
    assert.ok(readerFds.matches.some((fd) => fd.position === '0'), 'reader did not open same marker inode at zero');
    assert.ok(readerFds.matches.every((fd) => fd.position !== readerFds.expected));
    const daemonFds = markerDescriptors(daemon.pid, marker);
    assert.ok(daemonFds.matches.some((fd) => fd.position === daemonFds.expected), 'daemon did not inherit primed marker descriptor');
    const owned = await census(marker);
    assert.ok(owned.some((id) => id.pid === daemon.pid), 'double-fork daemon absent from census');
    assert.ok(owned.some((id) => id.pid === family.pid), 'marked family parent absent from census');
    assert.ok(owned.some((id) => id.pid === descendant.pid), 'unmarked descendant absent: closure is required');
    assert.ok(!owned.some((id) => id.pid === sentinel.pid || id.pid === reader.pid), 'census selected unrelated sentinel/offset-zero reader');
    const refuse = command(guardian, ['reconcile', String(process.pid), String(parent.startSec), String(parent.startUsec), `fdpath:${marker}`, '8000']);
    assert.equal(refuse.status, 4, 'reconcile did not refuse live parent');
    assert.ok(alive(daemon), 'live-parent refusal harmed owned fixture');
    const originals = [daemon, family, descendant];
    let triggerStarted;
    if (mode === 'graceful') {
      const watch = launch(guardian, ['watch', '3', String(process.pid), String(parent.startSec), String(parent.startUsec), `fdpath:${marker}`, '8000'], mode, true);
      originals.push(remember(watch.child.pid, 'guardian'));
      await until(() => fs.readFileSync(watch.log, 'utf8').includes('"event":"watching"'), 'watch ready');
      triggerStarted = performance.now();
      record({ event: 'trigger', mode, triggerMonotonicMs: triggerStarted });
      watch.child.stdio[3].end();
      await cleanOracle(marker, originals, triggerStarted);
      assert.match(fs.readFileSync(watch.log, 'utf8'), /"event":"clean"/);
    } else if (mode === 'abrupt') {
      const ready = path.join(dir, 'producer-ready.json'); const log = path.join(dir, 'guardian.log');
      const producer = launch(process.execPath, [path.join(here, 'probe-producer.mjs'), guardian, marker, ready, log], mode);
      const producerId = remember(producer.child.pid, 'producer');
      await until(() => fs.existsSync(ready) && fs.readFileSync(ready, 'utf8').endsWith('}'), 'producer ready');
      const ids = JSON.parse(fs.readFileSync(ready, 'utf8'));
      assert.equal(ids.producer, producer.child.pid);
      originals.push(producerId, remember(ids.guardian, 'guardian'));
      await until(() => fs.readFileSync(log, 'utf8').includes('"event":"watching"'), 'abrupt watch ready');
      triggerStarted = performance.now();
      record({ event: 'trigger', mode, triggerMonotonicMs: triggerStarted });
      safeKill(producerId);
      await cleanOracle(marker, originals, triggerStarted);
      assert.match(fs.readFileSync(log, 'utf8'), /"event":"clean"/);
    } else {
      // Calibrate against deliberately omitted containment, not a helper test hook.
      const falseZero = { event: 'known-bad-clean', count: 0, mechanism: 'omitted' };
      record(falseZero); await pause(250);
      assert.ok(alive(daemon), 'known-bad control failed to produce a survivor');
      assert.ok((await census(marker)).some((id) => id.pid === daemon.pid));
      record({ event: 'false-zero-rejected', survivor: daemon });
      triggerStarted = performance.now();
      record({ event: 'trigger', mode, triggerMonotonicMs: triggerStarted });
      for (const id of originals) safeKill(id);
      await cleanOracle(marker, originals, triggerStarted);
    }
    assert.ok(alive(sentinel) && alive(reader), 'unrelated sentinel or wrong-offset reader was killed');
    safeKill(reader);
    record({ event: 'case-pass', mode, caseElapsedMs: performance.now() - caseStarted, triggerElapsedMs: performance.now() - triggerStarted });
  }
} catch (e) { failed = e; record({ event: 'failure', error: e.stack }); }
finally {
  // Never delete evidence; only signal exact identities created by this harness.
  for (const id of identities) {
    try { safeKill(id); } catch (e) { failed ||= e; record({ event: 'cleanup-error', id, error: e.message }); }
  }
  try { await until(() => identities.every((id) => !alive(id)), 'final fixture cleanup', 3000); }
  catch (e) { failed ||= e; }
  try { record({ event: 'pre-reap-classifications', classifications: identities.map(classify) }); }
  catch (e) { failed ||= e; record({ event: 'pre-reap-query-error', error: e.message }); }
  try {
    await until(() => children.every((child) => child.exitCode !== null || child.signalCode !== null), 'direct child reaping', 3000);
  } catch (e) { failed ||= e; record({ event: 'reaping-error', error: e.message }); }
  let finalClassifications;
  try { finalClassifications = identities.map(classify); }
  catch (e) { failed ||= e; finalClassifications = { error: e.message }; }
  const result = { result: failed ? 'FAIL' : 'PASS', scope: 'native-helper-pre-acceptance-only', platform: process.platform, arch: process.arch, outputDir: root, identities, finalClassifications, error: failed?.message };
  fs.writeFileSync(path.join(root, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result));
}
if (failed) process.exitCode = 1;
