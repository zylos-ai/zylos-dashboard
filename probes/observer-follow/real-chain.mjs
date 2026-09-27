// Opt-in native regression probe. Uses only new isolated sockets and data directories.
// OBSERVER_ZELLIJ_BINARY=/absolute/path/to/pinned/zellij node probes/observer-follow/real-chain.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = process.env.OBSERVER_PROBE_SOURCE || fileURLToPath(new URL('../../', import.meta.url));
const load = (file) => import(pathToFileURL(path.join(root, 'src/lib', file)).href);
const { createObserverContainment } = await load('observer-containment.js');
const { ObserverSizeMonitor } = await load('observer-size-monitor.js');
const { ObserverUpstream } = await load('observer-upstream.js');
const { observerArtifactFor } = await load('observer-artifacts.js');
const binary = process.env.OBSERVER_ZELLIJ_BINARY;
assert.ok(binary && path.isAbsolute(binary), 'OBSERVER_ZELLIJ_BINARY must be an absolute path');
const artifact = observerArtifactFor();
assert.ok(artifact, 'platform has no validated native Observer artifact');
assert.equal(crypto.createHash('sha256').update(await fs.readFile(binary)).digest('hex'), artifact.binarySha256, 'only pinned shipped binary permitted');
const tmuxPath = process.env.OBSERVER_TMUX_BINARY || execFileSync('/usr/bin/which', ['tmux'], { encoding: 'utf8' }).trim();
const environment = { ...process.env, TERM: 'xterm-256color' };
delete environment.TMUX; delete environment.TMUX_PANE;
const iso = await fs.mkdtemp(path.join(os.tmpdir(), 'zof-'));
const report = { platform: `${process.platform}-${process.arch}`, tmux: execFileSync(tmuxPath, ['-V'], { encoding: 'utf8' }).trim(), binarySha256: artifact.binarySha256, source: root, iso, scenarios: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, timeout = 4000) {
  const start = Date.now(); let error;
  while (Date.now() - start < timeout) {
    try { await check(); return Date.now() - start; } catch (e) { error = e; }
    await delay(40);
  }
  throw error;
}
const helperSource = `import os,pty,fcntl,termios,struct,subprocess,signal,sys,threading,json
master,slave=pty.openpty()
def size(c,r): fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',r,c,0,0))
size(100,30)
p=subprocess.Popen([sys.argv[1],'-N','-S',sys.argv[2],'attach-session','-t','=claude-main'],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
os.close(slave)
def drain():
 while True:
  try: os.read(master,65536)
  except OSError: return
threading.Thread(target=drain,daemon=True).start()
try:
 for line in sys.stdin:
  c,r=json.loads(line);size(c,r);os.kill(p.pid,signal.SIGWINCH)
finally:
 p.kill();p.wait();os.close(master)
`;
async function scenario(name, { ordinary = false, statusLines = 1, follow = false, guard = false } = {}) {
  const dir = path.join(iso, name); await fs.mkdir(dir); const dataDir = path.join(dir, 'data'); await fs.mkdir(dataDir);
  const socket = path.join(dir, 'agent.sock');
  const exec = (...args) => execFileSync(tmuxPath, ['-N', '-S', socket, ...args], { encoding: 'utf8', env: environment }).trim();
  execFileSync(tmuxPath, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'claude-main', '-x', ordinary ? '100' : '140', '-y', ordinary ? '29' : '40', 'sleep 120'], { env: environment });
  let helper, monitor, upstream; const containment = createObserverContainment({ dataDir, tmuxPath, tmuxSocket: socket });
  const entry = { name, statusLines, ordinary, follow, events: [] }; report.scenarios.push(entry);
  const agent = () => exec('display-message', '-p', '-t', '=claude-main:', '#{window_width}x#{window_height}');
  const option = () => exec('show-options', '-Awv', '-t', '=claude-main:', 'window-size');
  const inner = () => exec('list-clients', '-F', '#{client_width}x#{client_height}|#{client_flags}').split('\n').filter(v => v.includes('read-only'));
  const capture = label => { const result = { label, agent: agent(), windowSize: option(), inner: inner() }; entry.events.push(result); return result; };
  try {
    exec('set-option', '-t', 'claude-main', 'status', statusLines === 0 ? 'off' : statusLines === 1 ? 'on' : String(statusLines));
    if (ordinary) {
      helper = spawn('python3', ['-u', '-c', helperSource, tmuxPath, socket], { env: environment, stdio: ['pipe', 'ignore', 'pipe'] });
      helper.stderr.on('data', b => process.stderr.write(b));
      await eventually(() => assert.match(exec('list-clients', '-F', '#{client_width}x#{client_height}|#{client_flags}'), /^100x30\|/));
    }
    const before = capture('before');
    if (guard) {
      let error;
      try { await containment.startGeneration({ generation: 1, binaryPath: binary, runtime: 'claude' }); }
      catch (caught) { error = caught; }
      assert.ok(error, 'faulty startup must be rejected');
      assert.equal(error.code, 'target_size_changed', 'must fail on raw Agent window geometry mismatch');
      assert.equal(containment.active, null, 'guard must not publish an active Observer');
      assert.equal(inner().length, 0, 'guard must disconnect Observer attachment');
      assert.notEqual(agent(), before.agent, 'fault injection must actually change Agent geometry; guard must not restore it');
      assert.equal(option(), before.windowSize);
      entry.errorCode = error.code;
      capture('guard-disconnected-without-restoring-agent');
      entry.result = 'PASS';
      return;
    }
    await containment.startGeneration({ generation: 1, binaryPath: binary, runtime: 'claude' });
    const active = containment.active;
    const outer = () => execFileSync(tmuxPath, ['-N', '-S', active.outerSocket, 'display-message', '-p', '-t', 'observer:client', '#{window_width}x#{window_height}'], { encoding: 'utf8' }).trim();
    const expected = ordinary ? '100x30' : `140x${40 + statusLines}`;
    await eventually(() => { assert.equal(agent(), before.agent, 'startup must preserve detached Agent'); assert.equal(option(), before.windowSize); assert.equal(outer(), expected); assert.ok(inner().some(v => v.startsWith(expected + '|'))); });
    capture('attached');
    monitor = new ObserverSizeMonitor({ onChange: async (size, target) => {
      assert.equal(await containment.resize(target, size), true);
      upstream?.resize(size);
      entry.events.push({ label: 'applied', size, at: Date.now() });
    } });
    const size = await monitor.start(active);
    upstream = new ObserverUpstream({ active });
    await upstream.connect({ size, onDisplay() {} });
    for (const [cols, rows] of !follow ? [] : ordinary ? [[140, 41], [80, 24]] : [[120, 35 + statusLines], [90, 25 + statusLines]]) {
      const start = Date.now();
      if (ordinary) helper.stdin.write(JSON.stringify([cols, rows]) + '\n');
      else exec('resize-window', '-t', '=claude-main:', '-x', String(cols), '-y', String(rows - statusLines));
      const elapsed = await eventually(() => {
        assert.equal(agent(), `${cols}x${rows - statusLines}`);
        assert.equal(outer(), `${cols}x${rows}`);
        assert.ok(inner().some(v => v.startsWith(`${cols}x${rows}|`)), 'actual inner tmux client must follow');
      }, 3200);
      Object.assign(capture('follow'), { elapsedMs: elapsed, totalMs: Date.now() - start });
    }
    if (ordinary) {
      const prior = agent();
      await containment.resize(active, { cols: 40, rows: 10 });
      await eventually(() => assert.ok(inner().some(v => v.startsWith('40x10|'))));
      assert.equal(agent(), prior, 'small observer must not resize Agent while ordinary client attached');
      capture('small-observer-control');
      await containment.resize(active, monitor.size);
    }
    monitor.stop(); upstream.close();
    const final = agent(); const finalOption = option();
    await containment.stopGeneration({ reason: 'isolated-follow-probe' });
    assert.equal(agent(), final, 'stop must preserve Agent dimensions');
    if (!follow) assert.equal(agent(), before.agent, 'unchanged detached Agent must preserve exact initial dimensions across start/stop');
    assert.equal(inner().length, 0); assert.equal(option(), finalOption); capture('stopped');
    entry.result = 'PASS';
  } catch (e) {
    entry.result = 'FAIL'; entry.error = e.stack;
    try { capture('failure-observation'); } catch (captureError) { entry.captureError = captureError.message; }
    throw e;
  }
  finally {
    monitor?.stop(); upstream?.close();
    try {
      await containment.stopGeneration({ reason: 'isolated-follow-probe-finally' });
      assert.equal(inner().length, 0, 'cleanup must remove test Observer client');
      entry.cleanup = { innerClients: 0, active: containment.active };
    } catch (error) {
      entry.cleanupError = error.stack;
      throw error;
    } finally {
      try {
        if (helper) {
          helper.stdin.end();
          await new Promise(resolve => { if (helper.exitCode !== null) resolve(); else helper.once('exit', resolve); });
        }
      } finally {
        try { exec('kill-server'); } catch { /* Only the newly created socket is addressed. */ }
      }
    }
  }
}
try {
  const selected = process.env.OBSERVER_PROBE_CASE;
  const cases = [
    ['detached-unchanged', {}],
    ['detached-status-off', { statusLines: 0 }],
    ['detached-status-multiline', { statusLines: 3 }],
    ['detached-follow', { follow: true }],
    ['ordinary-follow', { ordinary: true, follow: true }],
  ];
  if (selected === 'guard') await scenario('guard', { guard: true });
  else {
    assert.ok(!selected || cases.some(([name]) => name === selected), 'unknown probe case');
    for (const [name, options] of cases) if (!selected || selected === name) await scenario(name, options);
  }
  report.result = 'PASS';
}
catch (error) { report.result = 'FAIL'; report.error = error.stack; process.exitCode = 1; }
finally { console.log(JSON.stringify(report, null, 2)); }
