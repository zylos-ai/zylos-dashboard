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
let sequence = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function record(event) {
  fs.appendFileSync(path.join(root, 'events.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
}
function command(bin, argv, timeout = 1500) {
  const r = spawnSync(bin, argv, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  record({ event: 'command', bin, argv, status: r.status, signal: r.signal, error: r.error?.message, stdout: r.stdout, stderr: r.stderr });
  if (r.error) throw r.error;
  return r;
}
// Independent /proc oracle: never interpret permission/parse failure as absence.
function proc(pid) {
  let stat;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') return null; throw e; }
  const end = stat.lastIndexOf(') ');
  assert.ok(end > 0, 'malformed proc stat');
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  assert.ok(fields.length > 19 && /^\d+$/.test(fields[19]), 'missing proc start ticks');
  return { pid, ticks: fields[19], state: fields[0], uid: fs.statSync(`/proc/${pid}`).uid };
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
  if (!alive(id)) return;
  assert.equal(proc(id.pid).uid, process.getuid());
  const killed = command(fixture, ['cleanup', String(id.pid), id.ticks]);
  assert.equal(killed.status, 0, `pidfd cleanup failed closed for ${id.pid}`);
  record({ event: 'exact-fixture-cleanup', ...id });
}
async function until(test, label, timeout = 2500) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { if (test()) return; await pause(25); }
  throw new Error(`timeout: ${label}`);
}
function launch(bin, argv, label, pipes = false) {
  const log = path.join(root, `${++sequence}-${label}.log`);
  const fd = fs.openSync(log, 'wx', 0o600);
  const child = spawn(bin, argv, { stdio: ['ignore', fd, fd, ...(pipes ? ['pipe'] : [])] });
  fs.closeSync(fd);
  child.on('error', (e) => record({ event: 'spawn-error', label, error: e.message }));
  if (pipes) child.stdio[3].on('error', () => {});
  return { child, log };
}
async function fixtureProcess(mode, dir, marker) {
  const report = path.join(dir, `${mode}.pid`);
  const executable = mode === 'daemon' ? marked : fixture;
  const argv = mode === 'daemon' ? [marker, fixture, mode, report, '-'] : [mode, report, marker || '-'];
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
function census(marker) {
  const r = command(guardian, ['census', `fdpath:${marker}`]);
  assert.ok(r.status === 0 || r.status === 2, 'census failed closed (not an empty census)');
  const rows = r.stdout.trim().split('\n').filter(Boolean).map((s) => JSON.parse(s));
  const count = rows.find((row) => row.event === 'count');
  const owned = rows.filter((row) => row.event === 'owned');
  assert.equal(count?.count, owned.length); return owned;
}
function helperIdentity(pid) {
  const r = command(guardian, ['identity', String(pid)]);
  assert.equal(r.status, 0); return JSON.parse(r.stdout.trim());
}
async function cleanOracle(marker, originals, started) {
  let zeroSince;
  await until(() => {
    const classifications = originals.map(classify);
    const survivors = classifications.filter((id) => id.classification === 'live');
    const owned = census(marker);
    record({ event: 'whole-set-oracle', classifications, survivors, owned });
    if (survivors.length || owned.length) { zeroSince = undefined; return false; }
    zeroSince ??= performance.now();
    return performance.now() - zeroSince >= 1000;
  }, 'whole owned set and original helper identities gone', Math.max(1, 10000 - (performance.now() - started)));
  assert.ok(performance.now() - started <= 10000, 'cleanup exceeded 10 second wall bound');
}
let failed;
try {
  const build = command('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', path.join(here, 'probe-fixture.c'), '-o', fixture], 10000);
  assert.equal(build.status, 0, 'fixture build failed');
  const parent = helperIdentity(process.pid);
  const sentinel = await fixtureProcess('sentinel', root);
  for (const mode of ['graceful', 'abrupt', 'omitted-control']) {
    const dir = path.join(root, mode); fs.mkdirSync(dir, { mode: 0o700 });
    const marker = path.join(dir, 'marker'); fs.writeFileSync(marker, 'isolated probe marker\n', { flag: 'wx', mode: 0o600 });
    const hardlink = path.join(dir, 'marker-hardlink'); fs.linkSync(marker, hardlink);
    const reader = await fixtureProcess('reader', dir, hardlink);
    const daemon = await fixtureProcess('daemon', dir, marker);
    const readerFds = markerDescriptors(reader.pid, marker);
    assert.ok(readerFds.matches.some((fd) => fd.position === '0'), 'reader did not open same marker inode at zero');
    assert.ok(readerFds.matches.every((fd) => fd.position !== readerFds.expected));
    const daemonFds = markerDescriptors(daemon.pid, marker);
    assert.ok(daemonFds.matches.some((fd) => fd.position === daemonFds.expected), 'daemon did not inherit primed marker descriptor');
    const owned = census(marker);
    assert.ok(owned.some((id) => id.pid === daemon.pid), 'double-fork daemon absent from census');
    assert.ok(!owned.some((id) => id.pid === sentinel.pid || id.pid === reader.pid), 'census selected unrelated sentinel/offset-zero reader');
    const refuse = command(guardian, ['reconcile', String(process.pid), String(parent.startSec), String(parent.startUsec), `fdpath:${marker}`, '8000']);
    assert.equal(refuse.status, 4, 'reconcile did not refuse live parent');
    assert.ok(alive(daemon), 'live-parent refusal harmed owned fixture');
    let originals = [daemon];
    if (mode === 'graceful') {
      const watch = launch(guardian, ['watch', '3', String(process.pid), String(parent.startSec), String(parent.startUsec), `fdpath:${marker}`, '8000'], mode, true);
      originals.push(remember(watch.child.pid, 'guardian'));
      await until(() => fs.readFileSync(watch.log, 'utf8').includes('"event":"watching"'), 'watch ready');
      const started = performance.now(); watch.child.stdio[3].end();
      await cleanOracle(marker, originals, started);
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
      const started = performance.now(); safeKill(producerId);
      await cleanOracle(marker, originals, started);
      assert.match(fs.readFileSync(log, 'utf8'), /"event":"clean"/);
    } else {
      // Calibrate against deliberately omitted containment, not a helper test hook.
      const falseZero = { event: 'known-bad-clean', count: 0, mechanism: 'omitted' };
      record(falseZero); await pause(250);
      assert.ok(alive(daemon), 'known-bad control failed to produce a survivor');
      assert.ok(census(marker).some((id) => id.pid === daemon.pid));
      record({ event: 'false-zero-rejected', survivor: daemon });
      const started = performance.now(); safeKill(daemon);
      await cleanOracle(marker, originals, started);
    }
    assert.ok(alive(sentinel) && alive(reader), 'unrelated sentinel or wrong-offset reader was killed');
    safeKill(reader);
    record({ event: 'case-pass', mode });
  }
} catch (e) { failed = e; record({ event: 'failure', error: e.stack }); }
finally {
  // Never delete evidence; only signal exact identities created by this harness.
  for (const id of identities) {
    try { safeKill(id); } catch (e) { failed ||= e; record({ event: 'cleanup-error', id, error: e.message }); }
  }
  try { await until(() => identities.every((id) => !alive(id)), 'final fixture cleanup', 3000); }
  catch (e) { failed ||= e; }
  let finalClassifications;
  try { finalClassifications = identities.map(classify); }
  catch (e) { failed ||= e; finalClassifications = { error: e.message }; }
  const result = { result: failed ? 'FAIL' : 'PASS', scope: 'native-helper-pre-acceptance-only', platform: process.platform, arch: process.arch, outputDir: root, identities, finalClassifications, error: failed?.message };
  fs.writeFileSync(path.join(root, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result));
}
if (failed) process.exitCode = 1;
