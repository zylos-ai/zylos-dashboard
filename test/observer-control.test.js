import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ObserverControlServer, runObserverPreUninstall } from '../src/lib/observer-control.js';

function fixture(t, observer = { enabled: true, generation: 4 }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-control-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const configPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({ observer }, null, 2)}\n`, { mode: 0o600 });
  return { dataDir, configPath };
}

test('component pre-uninstall joins the running producer coordinator', async (t) => {
  const { dataDir, configPath } = fixture(t);
  let calls = 0;
  const server = new ObserverControlServer({
    dataDir,
    onPreUninstall: async () => { calls += 1; },
  });
  await server.start();
  t.after(() => server.close());
  const result = await runObserverPreUninstall({ dataDir, configPath });
  assert.deepEqual(result, { mode: 'online' });
  assert.equal(calls, 1);
  assert.equal(fs.statSync(server.socketPath).mode & 0o777, 0o600);
});

test('component pre-uninstall takes offline ownership only with no live producer', async (t) => {
  const { dataDir, configPath } = fixture(t);
  const result = await runObserverPreUninstall({ dataDir, configPath });
  assert.deepEqual(result, { mode: 'offline' });
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.observer.enabled, false);
  assert.equal(saved.observer.teardownFence, true);
  assert.equal(saved.observer.removalState, null);
  assert.equal(saved.observer.lastError, null);
});

test('an old ownerless coordinator lock is recovered but a fresh initializer is preserved', async (t) => {
  const { dataDir } = fixture(t);
  const lockPath = path.join(dataDir, 'observer', 'runtime', 'control', 'coordinator.lock');
  fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, stale, stale);
  const recovered = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  await recovered.start();
  assert.equal(fs.lstatSync(lockPath).isFile(), true);
  await recovered.close();

  fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  const contender = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  await assert.rejects(contender.start(), (error) => error?.code === 'coordinator_active');
  assert.equal(fs.existsSync(lockPath), true);
});

test('an old corrupt coordinator owner record is safely recovered', async (t) => {
  const { dataDir } = fixture(t);
  const lockPath = path.join(dataDir, 'observer', 'runtime', 'control', 'coordinator.lock');
  fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), '{broken');
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, stale, stale);
  const server = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  await server.start();
  await server.close();
});


test('closing a failed contender preserves the owning producer control socket', async (t) => {
  const { dataDir, configPath } = fixture(t);
  let calls = 0;
  const owner = new ObserverControlServer({ dataDir, onPreUninstall: async () => { calls += 1; } });
  await owner.start();
  t.after(() => owner.close());
  const contender = new ObserverControlServer({ dataDir, onPreUninstall: async () => {} });
  await assert.rejects(contender.start(), { code: 'coordinator_active' });
  await contender.close();
  assert.equal(fs.existsSync(owner.socketPath), true);
  assert.deepEqual(await runObserverPreUninstall({ dataDir, configPath }), { mode: 'online' });
  assert.equal(calls, 1);
});
