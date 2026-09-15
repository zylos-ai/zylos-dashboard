import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { DarwinObserverContainment } from '../src/lib/observer-containment-darwin.js';
import { OBSERVER_ARTIFACTS } from '../src/lib/observer-artifacts.js';

const runAcceptance = process.env.OBSERVER_ACCEPTANCE === '1' && process.platform === 'darwin' && process.arch === 'arm64';
const CHILD = path.resolve('test/fixtures/observer-lifecycle-child.mjs');

async function listenerOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function waitUntil(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function prepareCase(t, action) {
  const zellij = process.env.OBSERVER_ZELLIJ_PATH;
  const tmux = process.env.OBSERVER_TMUX_PATH || '/opt/homebrew/bin/tmux';
  assert.ok(zellij && fs.existsSync(zellij), 'OBSERVER_ZELLIJ_PATH must name the accepted binary');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `observer-${action}-`));
  const verifierDir = fs.mkdtempSync(path.join(os.tmpdir(), `observer-${action}-verifier-`));
  const cleanupState = { zeroVerified: false };
  const configPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({ observer: { enabled: true, generation: 1 } }, null, 2)}\n`, { mode: 0o600 });
  const artifact = OBSERVER_ARTIFACTS['darwin-arm64'];
  const artifactDirectory = path.join(dataDir, 'observer', 'artifacts', `${artifact.version}-${artifact.platform}`);
  fs.mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  fs.copyFileSync(zellij, path.join(artifactDirectory, artifact.archiveEntry));
  fs.chmodSync(path.join(artifactDirectory, artifact.archiveEntry), 0o755);
  fs.writeFileSync(path.join(artifactDirectory, 'LICENSE.zellij.md'), 'MIT acceptance fixture\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'observer', 'installed.json'), `${JSON.stringify({
    schema: 1,
    platform: artifact.platform,
    version: artifact.version,
    archiveSha256: artifact.archiveSha256,
    binarySha256: artifact.binarySha256,
    binary: `${artifact.version}-${artifact.platform}/${artifact.archiveEntry}`,
  }, null, 2)}\n`, { mode: 0o600 });
  const tmuxSocket = path.join('/tmp', `zobs-life-${process.pid}-${action}.sock`);
  execFileSync(tmux, ['-S', tmuxSocket, '-f', '/dev/null', 'new-session', '-d', '-s', 'codex-main', '-x', '80', '-y', '21']);
  execFileSync(tmux, ['-S', tmuxSocket, 'send-keys', '-t', 'codex-main', `printf observer-${action}`, 'Enter']);
  t.after(() => {
    try { execFileSync(tmux, ['-S', tmuxSocket, 'kill-server'], { timeout: 3_000 }); } catch {}
    if (cleanupState.zeroVerified) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(verifierDir, { recursive: true, force: true });
    }
  });
  return { dataDir, configPath, verifierDir, cleanupState, tmux, tmuxSocket };
}

for (const action of ['last-lease', 'disable', 'pre-uninstall', 'restart', 'abrupt']) {
  test(`real Observer lifecycle ${action} leaves zero owned survivors`, {
    skip: !runAcceptance ? 'set OBSERVER_ACCEPTANCE=1 on accepted darwin-arm64 fixture' : false,
    timeout: 30_000,
  }, async (t) => {
    const fixture = prepareCase(t, action);
    const child = spawn(process.execPath, [
      CHILD, action, fixture.dataDir, fixture.configPath, fixture.tmux, fixture.tmuxSocket,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const iterator = lines[Symbol.asyncIterator]();
    const readyLine = await iterator.next();
    assert.equal(readyLine.done, false, stderr);
    const ready = JSON.parse(readyLine.value);
    assert.equal(ready.event, 'ready');
    assert.match(ready.marker, /^fdpath:/);
    const verifierFile = path.join(fixture.verifierDir, 'ownership.marker');
    fs.linkSync(ready.marker.slice('fdpath:'.length), verifierFile);
    const verifierMarker = `fdpath:${verifierFile}`;
    const startedAt = Date.now();

    let done = null;
    if (action === 'abrupt') {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    } else {
      const doneLine = await iterator.next();
      assert.equal(doneLine.done, false, stderr);
      done = JSON.parse(doneLine.value);
      assert.equal(done.event, 'done');
      assert.ok(done.elapsedMs < 10_000, `${action} exceeded cleanup bound: ${done.elapsedMs}`);
      if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
      assert.equal(child.exitCode, 0, stderr);
    }

    const probe = new DarwinObserverContainment({
      dataDir: fixture.dataDir,
      tmuxPath: fixture.tmux,
      tmuxSocket: fixture.tmuxSocket,
    });
    const helpers = await probe.verifyHelpers();
    let emptySince = null;
    const zero = await waitUntil(() => {
      try {
        execFileSync(helpers.guardian, ['census', verifierMarker], { stdio: 'ignore', timeout: 2_000 });
        emptySince ??= Date.now();
        return Date.now() - emptySince >= 1_000;
      } catch {
        emptySince = null;
        return false;
      }
    });
    assert.equal(zero, true, `owned process census did not reach zero: ${stderr}`);
    fixture.cleanupState.zeroVerified = true;
    assert.equal(await listenerOpen(ready.port), false, 'Observer listener survived lifecycle teardown');
    assert.ok(Date.now() - startedAt < 10_000, `${action} whole oracle exceeded 10 seconds`);
    execFileSync(fixture.tmux, ['-S', fixture.tmuxSocket, 'has-session', '-t', 'codex-main']);
    if (action === 'abrupt') await probe.reconcilePersisted();
    if (done) assert.equal(done.manifestPresent, action !== 'pre-uninstall');
  });
}
