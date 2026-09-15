import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DarwinObserverContainment } from '../src/lib/observer-containment-darwin.js';

function fixture() {
  const containment = new DarwinObserverContainment({ dataDir: os.tmpdir() });
  const active = { stopping: false };
  containment.active = active;
  return { containment, active };
}

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

test('child process error is handled and reported once when exit follows', async () => {
  const { containment, active } = fixture();
  const child = fakeChild();
  const failures = [];
  containment.on('failure', (error) => failures.push(error));
  containment._monitorChild(active, 'guardian', child);

  const spawnError = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
  child.emit('error', spawnError);
  child.exitCode = 1;
  child.emit('exit', 1, null);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'child_error');
  assert.equal(failures[0].cause, spawnError);
  await assert.rejects(containment._waitForCleanExit(child, 100), (error) => {
    assert.equal(error.code, 'child_error');
    return true;
  });
});

test('child exit followed by error emits only the first containment failure', () => {
  const { containment, active } = fixture();
  const child = fakeChild();
  const failures = [];
  containment.on('failure', (error) => failures.push(error));
  containment._monitorChild(active, 'web', child);

  child.exitCode = 7;
  child.emit('exit', 7, null);
  assert.doesNotThrow(() => child.emit('error', new Error('late error')));

  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'child_exit');
  assert.match(failures[0].message, /web exited unexpectedly: 7/);
});

test('waitForCleanExit rejects once on error and ignores a later exit', async () => {
  const { containment, active } = fixture();
  const child = fakeChild();
  containment._monitorChild(active, 'fallback guardian', child);
  active.stopping = true;

  const waiting = containment._waitForCleanExit(child, 100);
  const spawnError = new Error('cleanup spawn failed');
  child.emit('error', spawnError);
  child.exitCode = 1;
  child.emit('exit', 1, null);

  await assert.rejects(waiting, (error) => error === spawnError);
});

test('fallback cleanup rejects fail-closed when its guardian cannot spawn', async () => {
  const spawnError = Object.assign(new Error('fallback EACCES'), { code: 'EACCES' });
  const child = fakeChild();
  child.stdio = [null, null, null, {
    end() { queueMicrotask(() => child.emit('error', spawnError)); },
  }];
  const containment = new DarwinObserverContainment({
    dataDir: os.tmpdir(),
    spawnImpl() { return child; },
  });
  const active = {
    stopping: true,
    parent: { startSec: 1, startUsec: 2 },
    marker: 'fdpath:/tmp/observer-test-marker',
  };
  containment.active = active;

  await assert.rejects(containment._fallbackCleanup(active), (error) => error === spawnError);
});

test('cleanup phases share one deadline instead of resetting the budget', async () => {
  const containment = new DarwinObserverContainment({
    dataDir: os.tmpdir(),
    cleanupTimeoutMs: 60,
    ownershipQuietMs: 30,
    ownershipPollMs: 5,
  });
  const guardian = fakeChild();
  guardian.stdio = [null, null, null, { end() {} }];
  containment.active = {
    stopping: false,
    guardian,
    guardianLiveness: guardian.stdio[3],
    marker: 'fdpath:/tmp/observer-deadline-marker',
    port: 9,
  };
  containment._waitForCleanExit = async () => {
    await new Promise((resolve) => setTimeout(resolve, 45));
  };
  containment._census = async () => ({ count: 0, output: '{"event":"count","count":0}\n' });

  const started = Date.now();
  await assert.rejects(containment.stopGeneration(), (error) => error?.code === 'cleanup_timeout');
  assert.ok(Date.now() - started < 120, 'cleanup reset its 60ms budget between phases');
});

test('stable-empty confirmation tolerates a transient census command failure', async () => {
  const containment = new DarwinObserverContainment({
    dataDir: os.tmpdir(), cleanupTimeoutMs: 120, ownershipQuietMs: 20, ownershipPollMs: 5,
  });
  let calls = 0;
  containment._census = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('transient census failure'), { code: 'census_failed' });
    return { count: 0, output: '{"event":"count","count":0}\n' };
  };
  await containment._confirmStableEmpty({ marker: 'fdpath:/tmp/transient-census' });
  assert.ok(calls >= 2);
});

test('stable-empty confirmation keeps persistent census failure fail-closed under one deadline', async () => {
  const containment = new DarwinObserverContainment({
    dataDir: os.tmpdir(), cleanupTimeoutMs: 35, ownershipQuietMs: 10, ownershipPollMs: 5,
  });
  containment._census = async () => {
    throw Object.assign(new Error('persistent census failure'), { code: 'census_failed' });
  };
  const started = Date.now();
  await assert.rejects(
    containment._confirmStableEmpty({ marker: 'fdpath:/tmp/persistent-census' }),
    (error) => error?.code === 'census_failed',
  );
  assert.ok(Date.now() - started < 90);
});

test('persisted reconciliation refuses an unowned external socket directory', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-persisted-path-'));
  const external = path.join('/tmp', `zobs-123-${'a'.repeat(10)}`);
  fs.mkdirSync(external, { recursive: true, mode: 0o700 });
  const sentinel = path.join(external, 'sentinel');
  fs.writeFileSync(sentinel, 'keep');
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  });
  const containment = new DarwinObserverContainment({ dataDir });
  const generationRoot = path.join(containment.runtimeRoot, 'fixture');
  fs.mkdirSync(generationRoot, { recursive: true });
  const markerFile = path.join(generationRoot, 'ownership.marker');
  fs.writeFileSync(markerFile, 'fixture');
  fs.writeFileSync(path.join(generationRoot, 'state.json'), JSON.stringify({
    schema: 1,
    generation: 1,
    nonce: 'fixture',
    parent: { pid: 123, startSec: 1, startUsec: 1 },
    marker: `fdpath:${markerFile}`,
    markerFile,
    root: generationRoot,
    socketRoot: external,
    socketOwnerFile: path.join(external, '.observer-owner.json'),
    port: 9,
  }));
  containment.verifyHelpers = async () => ({});

  await assert.rejects(containment.reconcilePersisted(), (error) => error?.code === 'reconcile_failed');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
});
