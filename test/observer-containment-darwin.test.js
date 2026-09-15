import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DarwinObserverContainment } from '../src/lib/observer-containment-darwin.js';
import {
  captureOriginalIdentities,
  classifyOriginalIdentities,
  originalIdentitiesGone,
  processIdentity,
} from './fixtures/observer-process-identity.mjs';

const runAcceptance = process.env.OBSERVER_ACCEPTANCE === '1' && process.platform === 'darwin' && process.arch === 'arm64';

async function readJsonLine(stream, timeoutMs = 12_000) {
  stream.setEncoding('utf8');
  let buffer = '';
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for child output: ${buffer}`)), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      stream.off('data', onData);
      resolve(JSON.parse(buffer.slice(0, newline)));
    };
    stream.on('data', onData);
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

test('packaged Darwin helpers match their pinned manifest', async () => {
  const containment = new DarwinObserverContainment({ dataDir: os.tmpdir() });
  const helpers = await containment.verifyHelperManifest();
  assert.match(helpers.guardian, /darwin-guardian$/);
  assert.match(helpers.markedExec, /marked-exec$/);
  assert.match(helpers.ptyMarkedExec, /pty-marked-exec$/);
});

test('native helper execution reports unsupported platforms without weakening manifest verification', async () => {
  const containment = new DarwinObserverContainment({
    dataDir: os.tmpdir(), platform: 'linux', arch: 'arm64',
  });
  await containment.verifyHelperManifest();
  await assert.rejects(containment.verifyHelpers(), (error) => error?.code === 'unsupported_platform');
});

test('Darwin product containment starts read-only target and proves zero owned survivors', {
  skip: !runAcceptance ? 'set OBSERVER_ACCEPTANCE=1 on accepted darwin-arm64 fixture' : false,
}, async (t) => {
  const zellij = process.env.OBSERVER_ZELLIJ_PATH;
  const tmux = process.env.OBSERVER_TMUX_PATH || '/opt/homebrew/bin/tmux';
  assert.ok(zellij && fs.existsSync(zellij), 'OBSERVER_ZELLIJ_PATH must name the accepted binary');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-product-containment-'));
  const tmuxSocket = path.join(os.tmpdir(), `observer-product-${process.pid}.sock`);
  let cleanupSafe = false;
  t.after(() => {
    try { execFileSync(tmux, ['-S', tmuxSocket, 'kill-server'], { timeout: 3_000 }); } catch {}
    if (cleanupSafe) fs.rmSync(root, { recursive: true, force: true });
  });
  execFileSync(tmux, [
    '-S', tmuxSocket, '-f', '/dev/null', 'new-session', '-d', '-s', 'codex-main', '-x', '80', '-y', '21',
  ]);
  execFileSync(tmux, ['-S', tmuxSocket, 'send-keys', '-t', 'codex-main', 'printf observer-product-sentinel', 'Enter']);

  const containment = new DarwinObserverContainment({
    dataDir: root,
    tmuxPath: tmux,
    tmuxSocket,
  });
  const active = await containment.startGeneration({ generation: 1, binaryPath: zellij, runtime: 'codex' });
  assert.equal(active.state, 'active');
  assert.equal(await new Promise((resolve) => {
    const socket = new net.Socket();
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.connect(active.port, '127.0.0.1');
  }), true);
  const stopped = await containment.stopGeneration({ reason: 'acceptance' });
  assert.equal(stopped.count, 0);
  assert.ok(stopped.elapsedMs < 10_000);
  execFileSync(tmux, ['-S', tmuxSocket, 'has-session', '-t', 'codex-main']);
  cleanupSafe = true;
});

test('Darwin product guardian cleans the whole owned set after abrupt producer death', {
  skip: !runAcceptance ? 'set OBSERVER_ACCEPTANCE=1 on accepted darwin-arm64 fixture' : false,
}, async (t) => {
  const zellij = process.env.OBSERVER_ZELLIJ_PATH;
  const tmux = process.env.OBSERVER_TMUX_PATH || '/opt/homebrew/bin/tmux';
  assert.ok(zellij && fs.existsSync(zellij), 'OBSERVER_ZELLIJ_PATH must name the accepted binary');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-product-abrupt-'));
  const tmuxSocket = path.join('/tmp', `observer-abrupt-${process.pid}.sock`);
  let child;
  let cleanupSafe = false;
  t.after(() => {
    if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL');
    try { execFileSync(tmux, ['-S', tmuxSocket, 'kill-server'], { timeout: 3_000 }); } catch {}
    if (cleanupSafe) fs.rmSync(root, { recursive: true, force: true });
  });
  execFileSync(tmux, [
    '-S', tmuxSocket, '-f', '/dev/null', 'new-session', '-d', '-s', 'codex-main', '-x', '80', '-y', '21',
  ]);
  child = spawn(process.execPath, [
    path.resolve('test/fixtures/observer-containment-child.mjs'), root, zellij, tmux, tmuxSocket,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = await readJsonLine(child.stdout);
  assert.equal(ready.event, 'ready');
  const started = Date.now();
  child.kill('SIGKILL');
  await once(child, 'exit');

  const probe = new DarwinObserverContainment({ dataDir: root, tmuxPath: tmux, tmuxSocket });
  const helpers = await probe.verifyHelpers();
  const cleaned = await waitUntil(() => {
    try {
      execFileSync(helpers.guardian, ['census', ready.marker], { stdio: 'ignore', timeout: 2_000 });
      return true;
    } catch {
      return false;
    }
  });
  assert.equal(cleaned, true, 'guardian did not reach a zero-owned census');
  assert.ok(Date.now() - started < 10_000, 'abrupt-death cleanup exceeded 10 seconds');
  const reconciled = await probe.reconcilePersisted();
  assert.deepEqual(reconciled, [{ generation: 7, reconciled: true }]);
  execFileSync(tmux, ['-S', tmuxSocket, 'has-session', '-t', 'codex-main']);
  cleanupSafe = true;
});

test('known-bad producer-owned guardian pipes leave a detected survivor before exact reconciliation', {
  skip: !runAcceptance ? 'set OBSERVER_ACCEPTANCE=1 on accepted darwin-arm64 fixture' : false,
}, async (t) => {
  const zellij = process.env.OBSERVER_ZELLIJ_PATH;
  const tmux = process.env.OBSERVER_TMUX_PATH || '/opt/homebrew/bin/tmux';
  assert.ok(zellij && fs.existsSync(zellij), 'OBSERVER_ZELLIJ_PATH must name the accepted binary');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-product-pipe-mutant-'));
  const tmuxSocket = path.join('/tmp', `observer-pipe-mutant-${process.pid}.sock`);
  let child;
  let cleanupSafe = false;
  t.after(() => {
    if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL');
    try { execFileSync(tmux, ['-S', tmuxSocket, 'kill-server'], { timeout: 3_000 }); } catch {}
    if (cleanupSafe) fs.rmSync(root, { recursive: true, force: true });
  });
  execFileSync(tmux, [
    '-S', tmuxSocket, '-f', '/dev/null', 'new-session', '-d', '-s', 'codex-main', '-x', '80', '-y', '21',
  ]);
  child = spawn(process.execPath, [
    path.resolve('test/fixtures/observer-containment-child.mjs'), root, zellij, tmux, tmuxSocket, 'producer-pipe',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = await readJsonLine(child.stdout);
  child.kill('SIGKILL');
  await once(child, 'exit');
  await new Promise((resolve) => setTimeout(resolve, 500));

  const probe = new DarwinObserverContainment({ dataDir: root, tmuxPath: tmux, tmuxSocket });
  const helpers = await probe.verifyHelpers();
  assert.throws(() => execFileSync(helpers.guardian, ['census', ready.marker], {
    stdio: 'ignore', timeout: 2_000,
  }), (error) => error?.status === 2, 'known-bad pipe wiring did not leave a detectable owner');
  assert.deepEqual(await probe.reconcilePersisted(), [{ generation: 7, reconciled: true }]);
  execFileSync(tmux, ['-S', tmuxSocket, 'has-session', '-t', 'codex-main']);
  cleanupSafe = true;
});

test('identity oracle detects a held guardian that marker census cannot see', {
  skip: !runAcceptance ? 'set OBSERVER_ACCEPTANCE=1 on accepted darwin-arm64 fixture' : false,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-held-guardian-'));
  const markerFile = path.join(root, 'ownership.marker');
  fs.writeFileSync(markerFile, 'held-guardian', { mode: 0o600 });
  const containment = new DarwinObserverContainment({ dataDir: root });
  const helpers = await containment.verifyHelpers();
  const parent = processIdentity(helpers.guardian, process.pid);
  assert.equal(parent.result, 'present');
  const guardian = spawn(helpers.guardian, [
    'watch', '3', String(process.pid), String(parent.identity.startSec),
    String(parent.identity.startUsec), `fdpath:${markerFile}`, '9000',
  ], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  t.after(() => {
    try { guardian.stdio[3]?.end(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  await readJsonLine(guardian.stdout);
  const originals = captureOriginalIdentities(helpers.guardian, { guardian: guardian.pid });
  execFileSync(helpers.guardian, ['census', `fdpath:${markerFile}`], { stdio: 'ignore', timeout: 2_000 });
  const held = classifyOriginalIdentities(helpers.guardian, originals);
  assert.equal(held.guardian.result, 'survivor');
  assert.equal(originalIdentitiesGone(held), false);

  guardian.stdio[3].end();
  await once(guardian, 'exit');
  assert.equal(guardian.exitCode, 0);
  const released = classifyOriginalIdentities(helpers.guardian, originals);
  assert.equal(originalIdentitiesGone(released), true);
});
