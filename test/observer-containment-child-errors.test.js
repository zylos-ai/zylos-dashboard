import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
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
