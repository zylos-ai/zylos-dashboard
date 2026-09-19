import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PosixObserverContainment } from '../src/lib/observer-containment-posix.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-directory-'));
  const namespaces = new Set();
  const make = () => {
    const c = new PosixObserverContainment({ dataDir, ownershipQuietMs: 0, spawnImpl() { throw new Error('fixture spawn failure'); } });
    c.verifyHelpers = async () => ({});
    c._identity = async () => ({ pid: process.pid, startSec: 1, startUsec: 0 });
    c._run = async () => ({ stdout: '' });
    c._fallbackCleanup = async () => {};
    c._confirmStableEmpty = async () => {};
    const originalNamespace = c._socketNamespace.bind(c);
    c._socketNamespace = async (...args) => {
      const n = await originalNamespace(...args);
      if (n) namespaces.add(n.root);
      return n;
    };
    return c;
  };
  t.after(() => {
    for (const n of namespaces) fs.rmSync(n, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { make, dataDir };
}
const start = (c) => c.startGeneration({ generation: 9, binaryPath: '/unused', runtime: 'codex' });
const interruption = () => Object.assign(new Error('simulated interruption'), { code: 'EINTR' });

for (const boundary of ['generation-created', 'socket-created', 'socket-owner', 'state-written', 'socket-published', 'generation-published']) {
  test(`restart recovers interrupted preparation at ${boundary}`, async (t) => {
    const { make } = fixture(t);
    const c = make();
    const method = boundary.endsWith('created') ? 'mkdtemp' : boundary === 'socket-owner' ? 'writeFile' : 'rename';
    const original = fs.promises[method];
    let hit = false;
    const patch = t.mock.method(fs.promises, method, async (...args) => {
      const value = await original(...args);
      const [source, destination] = args;
      const matches = boundary === 'generation-created' ? source.startsWith(c.runtimeRoot) :
        boundary === 'socket-created' ? source.startsWith('/tmp/zobs-') && source.includes('/.preparing-') :
          boundary === 'socket-owner' ? source.endsWith('/.observer-owner.json') :
            boundary === 'state-written' ? destination.endsWith('/state.json') :
              boundary === 'socket-published' ? /\/s-[0-9a-f]{10}$/.test(destination) :
                path.dirname(destination) === c.runtimeRoot && !path.basename(destination).startsWith('.');
      if (matches) { hit = true; throw interruption(); }
      return value;
    });
    await assert.rejects(start(c));
    patch.mock.restore();
    assert.equal(hit, true);
    const restarted = make();
    await restarted.reconcilePersisted();
    assert.deepEqual(fs.readdirSync(c.runtimeRoot), []);
    const n = await restarted._socketNamespace();
    assert.deepEqual(fs.readdirSync(n.root), ['.observer-namespace.json']);
    assert.deepEqual(await restarted.reconcilePersisted(), []);
  });
}

async function publishedFixture(t) {
  const f = fixture(t);
  const c = f.make();
  const original = fs.promises.rename;
  const patch = t.mock.method(fs.promises, 'rename', async (...args) => {
    const value = await original(...args);
    if (path.dirname(args[1]) === c.runtimeRoot && !path.basename(args[1]).startsWith('.')) throw interruption();
    return value;
  });
  await assert.rejects(start(c));
  patch.mock.restore();
  const root = path.join(c.runtimeRoot, fs.readdirSync(c.runtimeRoot)[0]);
  const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json')));
  return { ...f, c, state };
}

for (const removed of ['socket-owner', 'state']) {
  for (const retry of ['same-process', 'restart']) {
    test(`${retry} completes retirement after interrupted ${removed} removal`, async (t) => {
      const { c, state, make } = await publishedFixture(t);
      c.active = { ...state };
      let proofs = 0;
      c._confirmStableEmpty = async () => { proofs++; };
      const original = fs.promises.rm;
      const patch = t.mock.method(fs.promises, 'rm', async (target, options) => {
        if (removed === 'socket-owner' && target === state.socketRoot) {
          await original(state.socketOwnerFile);
          throw interruption();
        }
        if (removed === 'state' && path.basename(target).startsWith('.retired-')) {
          await original(path.join(target, 'state.json'));
          await original(path.join(target, 'ownership.marker'));
          throw interruption();
        }
        return original(target, options);
      });
      await assert.rejects(c.stopGeneration());
      patch.mock.restore();
      assert.equal(proofs, 1);
      assert.ok(c.active.retiredRoot);
      if (retry === 'same-process') {
        await c.stopGeneration();
        assert.equal(proofs, 1, 'retired retry must not census a removed marker');
        assert.equal(c.active, null);
      } else await make().reconcilePersisted();
      assert.equal(fs.existsSync(state.socketRoot), false);
      assert.deepEqual(fs.readdirSync(c.runtimeRoot), []);
    });
  }
}

test('ordinary pre-child environment failure is retryable in the same producer', async (t) => {
  const { make } = fixture(t);
  const c = make();
  c._privateEnvironment = async () => { throw new Error('environment failure'); };
  await assert.rejects(start(c), /environment failure/);
  assert.equal(c.active, null);
  assert.deepEqual(fs.readdirSync(c.runtimeRoot), []);
  await assert.rejects(start(c), /environment failure/);
  assert.deepEqual(fs.readdirSync(c.runtimeRoot), []);
});

test('socket publication collision preserves existing directory and fails closed', async (t) => {
  const { make } = fixture(t);
  const c = make();
  const original = fs.promises.rename;
  let collision;
  const patch = t.mock.method(fs.promises, 'rename', async (...args) => {
    const value = await original(...args);
    if (args[1].endsWith('/state.json')) {
      const state = JSON.parse(fs.readFileSync(args[1]));
      collision = state.socketRoot;
      fs.mkdirSync(collision, { mode: 0o700 });
      fs.writeFileSync(path.join(collision, 'sentinel'), 'preserve');
    }
    return value;
  });
  await assert.rejects(start(c), /collision/);
  patch.mock.restore();
  await assert.rejects(make().reconcilePersisted(), { code: 'reconcile_failed' });
  assert.equal(fs.readFileSync(path.join(collision, 'sentinel'), 'utf8'), 'preserve');
});

for (const corruption of ['token', 'symlink', 'missing']) {
  test(`namespace ${corruption} cannot authorize staging cleanup or replacement`, async (t) => {
    const { c, state, make } = await publishedFixture(t);
    const pointer = path.join(path.dirname(c.runtimeRoot), 'socket-namespace.json');
    if (corruption === 'token') {
      const n = JSON.parse(fs.readFileSync(pointer));
      n.token = '0'.repeat(32);
      fs.writeFileSync(pointer, JSON.stringify(n));
    } else if (corruption === 'symlink') {
      fs.renameSync(pointer, `${pointer}.original`);
      fs.symlinkSync(`${pointer}.original`, pointer);
    } else fs.unlinkSync(pointer);
    const next = make();
    if (corruption !== 'missing') await assert.rejects(next.reconcilePersisted());
    await assert.rejects(start(next));
    assert.equal(fs.existsSync(state.socketOwnerFile), true);
  });
}

test('unrecognized ownerless generation is not treated as unpublished preparation', async (t) => {
  const { make } = fixture(t);
  const c = make();
  const unknown = path.join(c.runtimeRoot, 'old-generation');
  fs.mkdirSync(unknown, { recursive: true, mode: 0o700 });
  await assert.rejects(c.reconcilePersisted(), { code: 'reconcile_failed' });
  assert.equal(fs.existsSync(unknown), true);
});

for (const boundary of ['namespace-created', 'namespace-owner', 'namespace-published']) {
  test(`interruption at ${boundary} leaves no live generation and retry does not adopt an orphan`, async (t) => {
    const { make } = fixture(t);
    const c = make();
    const method = boundary === 'namespace-created' ? 'mkdtemp' : boundary === 'namespace-owner' ? 'writeFile' : 'rename';
    const original = fs.promises[method];
    let orphan;
    const patch = t.mock.method(fs.promises, method, async (...args) => {
      const value = await original(...args);
      const hit = boundary === 'namespace-created' ? args[0] === '/tmp/zobs-' :
        boundary === 'namespace-owner' ? args[0].endsWith('/.observer-namespace.json') : args[1].endsWith('/socket-namespace.json');
      if (hit) {
        orphan = boundary === 'namespace-created' ? value : boundary === 'namespace-owner' ? path.dirname(args[0]) : JSON.parse(fs.readFileSync(args[1])).root;
        throw interruption();
      }
      return value;
    });
    await assert.rejects(start(c));
    patch.mock.restore();
    t.after(() => fs.rmSync(orphan, { recursive: true, force: true }));
    assert.equal(c.active, null);
    assert.deepEqual(fs.readdirSync(c.runtimeRoot), []);
    const next = make();
    const namespace = await next._socketNamespace(true);
    assert.equal(namespace.root === orphan, boundary === 'namespace-published');
    assert.equal(fs.existsSync(orphan), true, 'unregistered orphan must not be guessed/deleted');
  });
}

test('missing entire namespace permits only ordinary producer/census/listener reconciliation, then replacement', async (t) => {
  const { c, state, make } = await publishedFixture(t);
  fs.rmSync(state.socketNamespace.root, { recursive: true });
  const next = make();
  let census = 0;
  next._run = async () => { throw Object.assign(new Error('producer alive'), { code: 4 }); };
  next._confirmStableEmpty = async () => { census++; };
  await assert.rejects(next.reconcilePersisted(), /producer is still alive/);
  assert.equal(census, 0);
  assert.equal(fs.existsSync(state.root), true);
  next._run = async () => ({ stdout: '' });
  await next.reconcilePersisted();
  assert.equal(census, 1);
  assert.deepEqual(fs.readdirSync(c.runtimeRoot), []);
  const replacement = await next._socketNamespace(true);
  assert.notEqual(replacement.root, state.socketNamespace.root);
});

test('existing namespace missing owner record never gets adopted or cleaned', async (t) => {
  const { c, state, make } = await publishedFixture(t);
  fs.unlinkSync(path.join(state.socketNamespace.root, '.observer-namespace.json'));
  await assert.rejects(make().reconcilePersisted());
  await assert.rejects(make()._socketNamespace(true));
  assert.equal(fs.existsSync(state.socketOwnerFile), true);
  assert.equal(fs.existsSync(state.root), true);
});

test('preparing generation cleanup retires before socket removal, preserving restart retry', async (t) => {
  const { make } = fixture(t);
  const c = make();
  const rename = fs.promises.rename;
  const publication = t.mock.method(fs.promises, 'rename', async (...args) => {
    const value = await rename(...args);
    if (/\/s-[0-9a-f]{10}$/.test(args[1])) throw interruption();
    return value;
  });
  await assert.rejects(start(c));
  publication.mock.restore();
  const preparing = path.join(c.runtimeRoot, fs.readdirSync(c.runtimeRoot)[0]);
  const state = JSON.parse(fs.readFileSync(path.join(preparing, 'state.json')));
  const rm = fs.promises.rm;
  const removal = t.mock.method(fs.promises, 'rm', async (target, options) => {
    if (target === state.socketRoot) {
      await rm(state.socketOwnerFile);
      throw interruption();
    }
    return rm(target, options);
  });
  await assert.rejects(make().reconcilePersisted());
  removal.mock.restore();
  assert.equal(fs.readdirSync(c.runtimeRoot)[0].startsWith('.retired-'), true);
  await make().reconcilePersisted();
  assert.deepEqual(fs.readdirSync(c.runtimeRoot), []);
  assert.equal(fs.existsSync(state.socketRoot), false);
});

test('same-process retry tolerates interruption after retired directory was completely removed', async (t) => {
  const { c, state } = await publishedFixture(t);
  c.active = { ...state };
  const rm = fs.promises.rm;
  const removal = t.mock.method(fs.promises, 'rm', async (target, options) => {
    const value = await rm(target, options);
    if (path.basename(target).startsWith('.retired-')) throw interruption();
    return value;
  });
  await assert.rejects(c.stopGeneration());
  removal.mock.restore();
  await c.stopGeneration();
  assert.equal(c.active, null);
  assert.deepEqual(fs.readdirSync(c.runtimeRoot), []);
});
