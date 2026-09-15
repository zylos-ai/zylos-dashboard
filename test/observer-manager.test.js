import assert from 'node:assert/strict';
import test from 'node:test';
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
  assert.equal(f.manager.setPreset(lease.id, admin, '110x30').preset, '110x30');
  f.advance(20);
  assert.equal(f.manager.renewLease(lease.id, admin).expiresAt, 1_050);
  f.advance(31);
  assert.throws(() => f.manager.validateLease(lease.id, admin), (error) => error?.code === 'lease_expired');
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
