import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TmuxObserverContainment } from '../src/lib/observer-containment-tmux.js';
import { runStartupWorker } from '../src/lib/observer-tmux-worker.js';
import { readReceipt, writeAtomic, exists, validateState, digest } from '../src/lib/observer-tmux-state.js';

const role = (pid, command = 'fixture-process', ppid = 1) => ({ pid, ppid, start: `start-${pid}`, status: 'S', command });
async function fixture(t, extra = {}) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'observer-tmux-unit-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const binaryPath = path.join(dataDir, 'zellij');
  await fs.writeFile(binaryPath, 'inert fixture; never executed', { mode: 0o700 });
  const calls = [];
  const adapter = new TmuxObserverContainment({ dataDir, platform: process.platform, arch: process.arch,
    exec: async (file, args) => { calls.push(args); return { stdout: args.includes('display-message') ? '/tmp/fixture-target.sock\n' : '' }; },
    observe: async (pid) => role(pid), snapshot: async () => [], choosePort: async () => 23456,
    cleanupTimeoutMs: 1, startupTimeoutMs: 1, ...extra });
  const publish = async () => {
    const state = await adapter._publish({ generation: 1, binaryPath, runtime: 'codex' });
    t.after(() => fs.rm(state.socketRoot, { recursive: true, force: true }));
    return state;
  };
  return { adapter, publish, calls, dataDir, binaryPath };
}
const failedReceipt = (s) => ({ schema: 2, generation: s.generation, nonce: s.nonce, creationClosed: true,
  outcome: 'failed', sessionIssued: false, webLaunch: 'not-issued', roles: { outer: null, client: null, daemon: null, inner: null, web: null } });

for (const phase of ['staging-created', 'staged-layoutFile', 'staged-tmuxConfig', 'staged-configFile', 'staged-metadata', 'before-publication']) {
  test(`interrupted ${phase} is inert staging recoverable without native commands`, async (t) => {
    const f = await fixture(t, { phase: async (name) => { if (name === phase) throw new Error('interruption'); } });
    await assert.rejects(f.publish(), /interruption/);
    f.calls.length = 0;
    await f.adapter.reconcilePersisted();
    assert.deepEqual(await fs.readdir(f.adapter.runtimeRoot), []);
    assert.equal(f.calls.length, 0);
  });
}

test('published pending generation cancels and a delayed worker issues zero commands', async (t) => {
  const f = await fixture(t); const state = await f.publish();
  await fs.rename(path.join(state.root, 'pending'), path.join(state.root, 'cancelled'));
  let commands = 0;
  assert.deepEqual(await runStartupWorker(state.root, { exec: async () => { commands++; } }), { claimed: false });
  assert.equal(commands, 0);
  f.calls.length = 0;
  await f.adapter.reconcilePersisted();
  assert.equal(await exists(state.root), false);
  assert.equal(f.calls.length, 0);
});

test('workers refuse staging paths before commands or claiming', async (t) => {
  const f = await fixture(t); const state = await f.publish();
  const staged = path.join(f.adapter.runtimeRoot, `.staging-${path.basename(state.root)}`);
  await fs.rename(state.root, staged);
  let commands = 0;
  await assert.rejects(runStartupWorker(staged, { exec: async () => { commands++; } }), { code: 'unsafe_runtime_state' });
  assert.equal(commands, 0);
  assert.equal(await exists(path.join(staged, 'pending')), true);
});

test('claim and cancellation compete on the actual permit; late worker cannot create', async (t) => {
  const f = await fixture(t); const state = await f.publish();
  const results = await Promise.allSettled([
    fs.rename(path.join(state.root, 'pending'), path.join(state.root, 'starting')),
    fs.rename(path.join(state.root, 'pending'), path.join(state.root, 'cancelled')),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  let commands = 0;
  assert.equal((await runStartupWorker(state.root, { exec: async () => { commands++; } })).claimed, false);
  assert.equal(commands, 0);
});

test('claimed startup without terminal receipt stays fenced despite total process absence', async (t) => {
  const f = await fixture(t); const state = await f.publish();
  await fs.rename(path.join(state.root, 'pending'), path.join(state.root, 'starting'));
  await assert.rejects(f.adapter.reconcilePersisted(), { code: 'startup_incomplete' });
  assert.equal(await exists(state.root), true);
  assert.equal(await exists(f.binaryPath), true);
});

test('ready receipt requires all roles and acknowledged running web; failed prelaunch receipt remains valid', async (t) => {
  const f = await fixture(t); const s = await f.publish(); const receipt = failedReceipt(s);
  await writeAtomic(path.join(s.root, 'receipt.json'), receipt);
  assert.equal((await readReceipt(s)).outcome, 'failed');
  for (const change of [{ outcome: 'ready' }, { webLaunch: 'running' }, { sessionIssued: true }, { creationClosed: false }]) {
    await writeAtomic(path.join(s.root, 'receipt.json'), { ...receipt, ...change });
    await assert.rejects(readReceipt(s), { code: 'unsafe_runtime_state' });
  }
});

test('immutable metadata rejects malformed hashes and parent identities', async (t) => {
  const f = await fixture(t); const s = await f.publish();
  for (const change of [{ hashes: { ...s.hashes, binary: 'bad' } }, { parent: { pid: -1, start: 'bad' } }]) {
    await writeAtomic(path.join(s.root, 'state.json'), { ...s, ...change });
    await assert.rejects(validateState(s.root), { code: 'unsafe_runtime_state' });
  }
});

// Native tmux with LC_ALL=C renders control characters in format strings as '_'.
// Expand the requested format so tests exercise the query/parser contract.
function tmuxCFormat(format, fields) {
  return format.replace(/[\x00-\x1f\x7f]/g, '_')
    .replace(/#\{([^}]+)\}/g, (_, key) => String(fields[key] ?? '')) + '\n';
}

const initializationLog = 'INFO   |zellij_server            | 2026-09-20 19:45:18.123 [main      ] zellij-server/src/lib.rs:1044: FirstClientConnected: session initialized, spawning tabs \n';

async function workerFixture(t, { log = initializationLog, held = false, webExited = false, authFailure = false, launchFailure = false, backgroundPlugin = false } = {}) {
  const f = await fixture(t); const state = await f.publish();
  t.after(() => fs.rm(state.socketRoot, { recursive: true, force: true }));
  const commands = []; const phases = [];
  const logDirectory = path.join(state.root, 'tmp', `zellij-${process.getuid()}`, 'zellij-log');
  await fs.mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const logFile = path.join(logDirectory, 'zellij.log');
  if (log !== null) await fs.writeFile(logFile, log, { mode: 0o600 });
  const roles = { outer: role(110, `tmux -S ${state.outerSocket}`), client: role(111, `${state.binaryPath} --session ${state.sessionName}`),
    daemon: role(112, `${state.binaryPath} --server ${state.socketRoot}/${state.sessionName}`),
    inner: role(113, 'tmux attach-session', 112), web: role(114, `${state.binaryPath} web --start`) };
  const opts = {
    observe: async (pid) => held && pid === 113 ? null : Object.values(roles).find((r) => r.pid === pid) || null,
    snapshot: async () => Object.values(roles),
    wait: async (check) => { const result = await check(); if (!result) throw new Error('unsettled fixture'); return result; },
    phase: async (name) => { phases.push(name); assert.equal(await exists(path.join(state.root, 'receipt.json')), false); },
    probe: () => ({ connect: async () => { if (authFailure) throw new Error('auth failed'); }, close() {} }),
    exec: async (file, args) => {
      assert.equal(await exists(path.join(state.root, 'starting')), true, 'native commands require claim');
      assert.equal(await exists(path.join(state.root, 'receipt.json')), false, 'no command after receipt');
      commands.push(args);
      if (args.includes('new-session') && launchFailure) throw new Error('lost acknowledgement');
      if (args.includes('display-message')) return { stdout: tmuxCFormat(args.at(-1), {
        pid: 110, pane_pid: args.includes('observer:web') ? 114 : 111,
        pane_dead: args.includes('observer:web') && webExited ? 1 : 0, pane_dead_status: '' }) };
      if (args.includes('list-panes')) return { stdout: JSON.stringify([...(backgroundPlugin ? [{ is_plugin: true, is_suppressed: true, plugin_url: 'zellij:link' }] : []), { is_plugin: false, exited: held,
        terminal_command: [state.tmuxPath, '-N', '-S', state.tmuxSocket, 'attach-session', '-r', '-t', '=codex-main'].join(' ') }]) };
      if (args.includes('list-clients')) return { stdout: tmuxCFormat(args.at(-1), { client_pid: 113, client_readonly: 1, session_name: 'codex-main' }) };
      if (args.includes('--create-read-only-token')) return { stdout: 'token_1: 12345678-1234-1234-1234-123456789abc\n' };
      return { stdout: '' };
    },
  };
  return { ...f, state, opts, commands, phases, roles, logFile };
}
for (const [name, options, outcome] of [['ready', {}, 'ready'], ['held target exit', { held: true }, 'failed'],
  ['foreground web exit', { webExited: true }, 'failed'], ['authentication failure', { authFailure: true }, 'failed']]) {
  test(`worker ${name} closes creation before terminal receipt`, async (t) => {
    const f = await workerFixture(t, options);
    assert.equal((await runStartupWorker(f.state.root, f.opts)).outcome, outcome);
    const receipt = await readReceipt(f.state);
    assert.equal(receipt.outcome, outcome);
    assert.equal(f.phases.at(-1), 'before-receipt');
    if (outcome === 'ready') assert.equal(receipt.roles.inner.pid, 113);
    if (options.held) assert.equal(receipt.webLaunch, 'not-issued');
    if (options.webExited) assert.equal(receipt.webLaunch, 'exited');
  });
}
test('worker waits passively for initialization before any Zellij CLI query', async (t) => {
  const f = await workerFixture(t, { log: null });
  const originalWait = f.opts.wait;
  let withheld = false;
  f.opts.wait = async (check) => {
    const result = await check();
    if (result) return result;
    assert.equal(withheld, false);
    withheld = true;
    assert.equal(f.commands.some((args) => args.includes('list-panes') || args.includes('--create-read-only-token')), false);
    await fs.writeFile(f.logFile, initializationLog, { mode: 0o600 });
    return originalWait(check);
  };
  const originalExec = f.opts.exec;
  f.opts.exec = async (file, args) => {
    if (file === f.state.binaryPath) assert.equal(withheld, true, 'Zellij CLI must not beat initialization');
    return originalExec(file, args);
  };
  assert.equal((await runStartupWorker(f.state.root, f.opts)).outcome, 'ready');
  assert.equal(withheld, true);
});

for (const kind of ['missing', 'malformed', 'symlink-file', 'symlink-parent', 'public-file', 'oversized', 'no-daemon', 'duplicate-daemon']) {
  test(`initialization gate fails closed for ${kind} before Zellij CLI`, async (t) => {
    const f = await workerFixture(t, { log: kind === 'missing' ? null : initializationLog });
    if (kind === 'malformed') await fs.writeFile(f.logFile, initializationLog.replace('zellij_server', 'other_module'));
    if (kind === 'public-file') await fs.chmod(f.logFile, 0o644);
    if (kind === 'oversized') await fs.writeFile(f.logFile, initializationLog + 'x'.repeat(128 * 1024));
    if (kind === 'symlink-file') {
      const target = path.join(f.dataDir, 'outside.log');
      await fs.rename(f.logFile, target); await fs.symlink(target, f.logFile);
    }
    if (kind === 'symlink-parent') {
      const directory = path.dirname(f.logFile); const target = path.join(f.dataDir, 'outside-logs');
      await fs.rename(directory, target); await fs.symlink(target, directory);
    }
    if (kind === 'no-daemon') f.opts.snapshot = async () => [];
    if (kind === 'duplicate-daemon') f.opts.snapshot = async () => [f.roles.daemon, { ...f.roles.daemon, pid: 999 }];
    let zellijCalls = 0;
    const originalExec = f.opts.exec;
    f.opts.exec = async (file, args) => { if (file === f.state.binaryPath) zellijCalls++; return originalExec(file, args); };
    assert.deepEqual(await runStartupWorker(f.state.root, f.opts), { claimed: true, settled: false });
    assert.equal(zellijCalls, 0);
    assert.equal(await exists(path.join(f.state.root, 'receipt.json')), false);
  });
}

test('C-locale tmux formats preserve startup identities and healthy active client', async (t) => {
  const f = await workerFixture(t);
  assert.equal((await runStartupWorker(f.state.root, f.opts)).outcome, 'ready');
  f.adapter.active = { ...f.state, receipt: await readReceipt(f.state) };
  f.adapter.snapshot = f.opts.snapshot;
  f.adapter.observe = f.opts.observe;
  let readonly = 1;
  f.adapter.exec = async (file, args) => ({ stdout: tmuxCFormat(args.at(-1), {
    client_pid: 113, client_readonly: readonly, session_name: 'codex-main',
  }) });
  let failures = 0; f.adapter.on('failure', () => { failures++; });
  await f.adapter._checkActive();
  assert.equal(failures, 0, 'healthy read-only client must remain active');
  readonly = 0;
  await f.adapter._checkActive();
  assert.equal(failures, 1, 'loss of read-only attachment must still fail');
});

test('unexpected background plugin keeps startup fenced', async (t) => {
  const f = await workerFixture(t, { backgroundPlugin: true });
  assert.deepEqual(await runStartupWorker(f.state.root, f.opts), { claimed: true, settled: false });
  assert.equal(await exists(path.join(f.state.root, 'receipt.json')), false);
  assert.match(JSON.parse(await fs.readFile(path.join(f.state.root, 'startup-error.json'), 'utf8')).message, /Unexpected fixed Observer layout/);
});

test('lost creation acknowledgement never publishes a terminal receipt', async (t) => {
  const f = await workerFixture(t, { launchFailure: true });
  assert.deepEqual(await runStartupWorker(f.state.root, f.opts), { claimed: true, settled: false });
  assert.equal(await exists(path.join(f.state.root, 'receipt.json')), false);
});

test('retired interruption resumes even with missing metadata and no native commands', async (t) => {
  const f = await fixture(t, { phase: async (name) => { if (name === 'retired') throw new Error('interrupted retirement'); } });
  const s = await f.publish();
  await assert.rejects(f.adapter.reconcilePersisted(), /interrupted retirement/);
  const [name] = await fs.readdir(f.adapter.runtimeRoot);
  assert.ok(name.startsWith('.retired-'));
  await fs.unlink(path.join(f.adapter.runtimeRoot, name, 'state.json'));
  f.calls.length = 0;
  await f.adapter.reconcilePersisted();
  assert.deepEqual(await fs.readdir(f.adapter.runtimeRoot), []);
  assert.equal(f.calls.length, 0);
  assert.equal(await exists(s.root), false);
});

test('active inner role disappearance emits one failure and read-only loss is detected', async (t) => {
  const f = await workerFixture(t);
  await runStartupWorker(f.state.root, f.opts);
  f.adapter.active = { ...f.state, receipt: await readReceipt(f.state) };
  f.adapter.snapshot = f.opts.snapshot;
  f.adapter.observe = f.opts.observe;
  f.adapter.exec = f.opts.exec;
  // Queries after receipt are expected here; use a separate strict mock.
  f.adapter.exec = async () => ({ stdout: '113|0|codex-main\n' });
  let failures = 0; f.adapter.on('failure', () => { failures++; });
  await f.adapter._checkActive(); await f.adapter._checkActive();
  assert.equal(failures, 1);
  f.adapter.active.failed = false;
  f.adapter.observe = async () => null;
  await f.adapter._checkActive();
  assert.equal(failures, 2);
});

test('settled cleanup tolerates partial socket deletion and repeats absence before retirement', async (t) => {
  const f = await fixture(t); const s = await f.publish();
  t.after(() => fs.rm(s.socketRoot, { recursive: true, force: true }));
  await fs.rename(path.join(s.root, 'pending'), path.join(s.root, 'starting'));
  await writeAtomic(path.join(s.root, 'receipt.json'), failedReceipt(s));
  await fs.mkdir(s.socketRoot, { mode: 0o700 });
  // Models interruption after owner.json unlink but before socket-root rmdir.
  await writeAtomic(path.join(s.root, 'retirement.json'), { nonce: s.nonce, socketRemoval: true });
  let observations = 0;
  f.adapter.snapshot = async () => { observations++; return []; };
  f.adapter.observe = async () => null;
  await f.adapter.reconcilePersisted();
  assert.ok(observations > 0);
  assert.equal(await exists(s.socketRoot), false);
  assert.equal(await exists(s.root), false);
});

test('missing socket owner without retirement evidence remains fenced', async (t) => {
  const f = await fixture(t); const s = await f.publish();
  t.after(() => fs.rm(s.socketRoot, { recursive: true, force: true }));
  await fs.rename(path.join(s.root, 'pending'), path.join(s.root, 'starting'));
  await writeAtomic(path.join(s.root, 'receipt.json'), failedReceipt(s));
  await fs.mkdir(s.socketRoot, { mode: 0o700 });
  await assert.rejects(f.adapter.reconcilePersisted(), { code: 'ENOENT' });
  assert.equal(await exists(s.root), true);
});

test('failed web cleanup preserves an unrelated listener on the selected port', async (t) => {
  const { default: net } = await import('node:net');
  const listener = net.createServer((socket) => socket.end('foreign listener'));
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const f = await fixture(t, { choosePort: async () => listener.address().port });
  const s = await f.publish();
  await fs.rename(path.join(s.root, 'pending'), path.join(s.root, 'starting'));
  await writeAtomic(path.join(s.root, 'receipt.json'), { ...failedReceipt(s), sessionIssued: true, webLaunch: 'exited',
    roles: { outer: role(110), client: role(111), daemon: role(112), inner: role(113), web: null } });
  f.adapter.observe = async () => null;
  await f.adapter.reconcilePersisted();
  assert.equal(await exists(s.root), false);
  assert.equal(listener.listening, true);
  const text = await new Promise((resolve, reject) => {
    const client = net.createConnection(s.port, '127.0.0.1'); let value = '';
    client.on('data', (chunk) => { value += chunk; }); client.on('end', () => resolve(value)); client.on('error', reject);
  });
  assert.equal(text, 'foreign listener');
});


test('changed executable or self-consistent changed layout cannot reach native commands', async (t) => {
  const f = await fixture(t); const s = await f.publish();
  const original = await fs.readFile(f.binaryPath);
  await fs.writeFile(f.binaryPath, 'changed executable');
  await assert.rejects(validateState(s.root), { code: 'unsafe_runtime_state' });
  await fs.writeFile(f.binaryPath, original);
  const changed = 'layout { pane command="sh" }\n';
  await fs.writeFile(s.layoutFile, changed);
  await writeAtomic(path.join(s.root, 'state.json'), { ...s, hashes: { ...s.hashes, layoutFile: digest(changed) } });
  let commands = 0;
  await assert.rejects(runStartupWorker(s.root, { exec: async () => { commands++; } }), { code: 'unsafe_runtime_state' });
  assert.equal(commands, 0);
});

test('optional Observer import does not resolve a platform-specific temp directory', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const moduleUrl = new URL('../src/lib/observer-containment.js', import.meta.url).href;
  const script = `import fs from 'node:fs/promises'; fs.realpath = async () => { throw new Error('unsupported temp'); }; await import(${JSON.stringify(moduleUrl)});`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]);
});
