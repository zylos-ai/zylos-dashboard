import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ObserverCoordinator } from '../src/lib/observer-coordinator.js';
import { ObserverManager } from '../src/lib/observer-manager.js';

function context(principalId, credentialId = `${principalId}-session`) {
  const value = { kind: 'api', principalId, scope: 'admin' };
  Object.defineProperty(value, 'credentialId', { value: credentialId, enumerable: false });
  return value;
}

function fixture(overrides = {}) {
  let now = 1_000;
  let starts = 0;
  let stops = 0;
  const containment = {
    active: null,
    async stopGeneration() { stops += 1; this.active = null; return { stopped: true }; },
  };
  const coordinator = {
    async firstLease() {
      starts += 1;
      containment.active = { generation: 5 };
      return containment.active;
    },
    async disable() { await containment.stopGeneration(); return { enabled: false }; },
    async uninstall() { await containment.stopGeneration(); return { state: 'not_installed' }; },
  };
  const validCredentials = new Set(['admin-session', 'admin-refreshed', 'other-session']);
  const authGate = {
    revalidateAuthContext(value) {
      return validCredentials.has(value.credentialId) ? value : null;
    },
  };
  const manager = new ObserverManager({
    coordinator, containment, authGate, runtime: 'codex',
    now: () => now, idleGraceMs: 10, revalidateMs: 60_000, ...overrides,
  });
  return {
    manager, containment, coordinator, authGate, validCredentials,
    advance(ms) { now += ms; },
    counts() { return { starts, stops }; },
  };
}

test('leases coalesce first start and bind principal, target, and generation', async () => {
  const f = fixture();
  const admin = context('admin');
  const [first, second] = await Promise.all([
    f.manager.createLease(admin),
    f.manager.createLease(admin),
  ]);
  assert.equal(f.counts().starts, 1);
  assert.notEqual(first.id, second.id);
  assert.equal(first.generation, 5);
  assert.equal(f.manager.validateLease(first.id, context('admin', 'admin-refreshed')).id, first.id,
    'same stable key principal may refresh its API session');
  assert.throws(() => f.manager.validateLease(first.id, context('other')), (error) => error?.code === 'lease_mismatch');
  assert.throws(() => f.manager.validateLease(first.id, admin, { target: 'remote' }), (error) => error?.code === 'lease_mismatch');
});

test('lease capacity, preset allowlist, renewal, and expiry fail closed', async () => {
  const f = fixture({ maxViewers: 1, leaseTtlMs: 30 });
  const admin = context('admin');
  const lease = await f.manager.createLease(admin);
  await assert.rejects(f.manager.createLease(admin), (error) => error?.code === 'capacity_exceeded');
  assert.throws(() => f.manager.setPreset(lease.id, admin, '200x100'), (error) => error?.code === 'invalid_preset');
  assert.equal(f.manager.setPreset(lease.id, admin, 'wide').preset, 'wide');
  f.advance(20);
  assert.equal(f.manager.renewLease(lease.id, admin).expiresAt, 1_050);
  f.advance(31);
  assert.throws(() => f.manager.validateLease(lease.id, admin), (error) => error?.code === 'lease_expired');
  assert.ok(await f.manager.createLease(admin), 'an expired lease must not consume reserved capacity');
});

test('concurrent lease reservations cannot exceed capacity', async () => {
  const f = fixture({ maxViewers: 1 });
  const attempts = await Promise.allSettled([
    f.manager.createLease(context('admin')),
    f.manager.createLease(context('admin')),
  ]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = attempts.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'capacity_exceeded');
});

test('pending leases prevent idle teardown while the first generation is still starting', async () => {
  let finishStart;
  const f = fixture({ idleGraceMs: 5 });
  f.coordinator.firstLease = () => {
    f.containment.active = { generation: 5 };
    return new Promise((resolve) => {
      finishStart = () => resolve(f.containment.active);
    });
  };

  const first = f.manager.createLease(context('admin'));
  await new Promise((resolve) => setImmediate(resolve));
  const second = f.manager.createLease(context('admin'));
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(f.counts().stops, 0);
  finishStart();
  const leases = await Promise.all([first, second]);
  assert.equal(leases.length, 2);
  assert.equal(f.manager.leases.size, 2);
  assert.equal(f.counts().stops, 0);
});

test('shutdown waits for an in-flight first lease start and tears down its generation', async () => {
  let finishStart;
  const f = fixture();
  f.coordinator.firstLease = () => new Promise((resolve) => {
    finishStart = () => {
      f.containment.active = { generation: 5 };
      resolve(f.containment.active);
    };
  });

  const lease = f.manager.createLease(context('admin'));
  await new Promise((resolve) => setImmediate(resolve));
  let shutdownFinished = false;
  const shutdown = f.manager.shutdown().then((result) => {
    shutdownFinished = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownFinished, false);

  finishStart();
  await assert.rejects(lease, (error) => error?.code === 'operation_obsolete');
  await shutdown;
  assert.equal(f.counts().stops, 1);
  assert.equal(f.containment.active, null);
  assert.equal(f.manager.generation, null);
  assert.equal(f.manager._revalidationTimer, null);
  await assert.rejects(f.manager.createLease(context('admin')), (error) => error?.code === 'operation_obsolete');
});

test('10-second policy revalidation revokes a lease and last lease stops after grace', async () => {
  const f = fixture();
  const admin = context('admin');
  const lease = await f.manager.createLease(admin);
  f.validCredentials.delete('admin-session');
  assert.equal(await f.manager.revalidate(), 0);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.counts().stops, 1);
  assert.throws(() => f.manager.validateLease(lease.id, admin), (error) => error?.code === 'lease_not_found');
});

test('disable invalidates every lease before entering lifecycle teardown', async () => {
  const f = fixture();
  const lease = await f.manager.createLease(context('admin'));
  const result = await f.manager.invalidateAndDisable();
  assert.equal(result.enabled, false);
  assert.equal(f.manager.leases.size, 0);
  assert.equal(f.manager.generation, null);
  assert.throws(() => f.manager.validateLease(lease.id, context('admin')), (error) => error?.code === 'lease_not_found');
});

for (const action of ['disable', 'uninstall']) {
  test(`${action} waits for an in-flight first lease start before teardown`, async () => {
    let finishStart;
    const f = fixture();
    f.coordinator.firstLease = () => new Promise((resolve) => {
      finishStart = () => {
        f.containment.active = { generation: 5 };
        resolve(f.containment.active);
      };
    });

    const lease = f.manager.createLease(context('admin'));
    await new Promise((resolve) => setImmediate(resolve));
    let lifecycleFinished = false;
    const lifecycle = (action === 'disable'
      ? f.manager.invalidateAndDisable()
      : f.manager.invalidateAndUninstall()).then((result) => {
      lifecycleFinished = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lifecycleFinished, false);
    await assert.rejects(f.manager.createLease(context('admin')), (error) => error?.code === 'operation_obsolete');

    finishStart();
    await assert.rejects(lease, (error) => error?.code === 'operation_obsolete');
    await lifecycle;
    assert.equal(f.counts().stops, 1);
    assert.equal(f.containment.active, null);
    assert.equal(f.manager.generation, null);
    assert.equal(f.manager._revalidationTimer, null);
  });
}

for (const action of ['disable', 'uninstall']) {
  test(`${action} preserves config failure but still tears down the revoked generation`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `observer-manager-${action}-`));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, 'config.json');
    fs.writeFileSync(configPath, `${JSON.stringify({ observer: { enabled: true, generation: 0 } })}\n`);
    let stops = 0;
    const containment = {
      active: null,
      async stopGeneration() {
        stops += 1;
        this.active = null;
        return { stopped: true };
      },
    };
    const installer = {
      async verify() { return { state: 'installed', binaryPath: '/fixture/zellij' }; },
      async removeInstalledArtifacts() { throw new Error('must not remove after persistence failure'); },
    };
    const coordinator = new ObserverCoordinator({
      configPath,
      installer,
      start: async ({ generation }) => {
        containment.active = { generation };
        return containment.active;
      },
      teardown: ({ reason }) => containment.stopGeneration({ reason }),
    });
    const manager = new ObserverManager({
      coordinator,
      containment,
      authGate: { revalidateAuthContext: (value) => value },
      runtime: 'codex',
      idleGraceMs: 5,
      revalidateMs: 60_000,
    });
    await manager.createLease(context('admin'));
    fs.writeFileSync(configPath, '{invalid json');

    const operation = action === 'disable'
      ? manager.invalidateAndDisable()
      : manager.invalidateAndUninstall();
    await assert.rejects(operation, (error) => error?.code === 'invalid_config');
    assert.equal(containment.active, null);
    assert.equal(manager.leases.size, 0);
    assert.equal(manager._idleTimer, null);
    assert.equal(manager._revalidationTimer, null);
    assert.equal(manager.generation, null);
    assert.equal(stops, 1);
  });
}

test('lifecycle persistence error remains primary while cleanup failure stays visible', async () => {
  const persistenceError = Object.assign(new Error('invalid config'), { code: 'invalid_config' });
  const cleanupError = Object.assign(new Error('owned survivors'), { code: 'owned_survivors' });
  const f = fixture();
  f.coordinator.disable = async () => { throw persistenceError; };
  f.containment.active = { generation: 5 };
  f.containment.stopGeneration = async () => { throw cleanupError; };
  f.manager.generation = 5;

  await assert.rejects(f.manager.invalidateAndDisable(), (error) => {
    assert.equal(error, persistenceError);
    assert.equal(error.cleanupError, cleanupError);
    return true;
  });
  assert.equal(f.manager._runtimeError, cleanupError);
});
