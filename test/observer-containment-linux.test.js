import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LinuxObserverContainment } from '../src/lib/observer-containment-linux.js';
import { DarwinObserverContainment } from '../src/lib/observer-containment-darwin.js';
import { createObserverContainment } from '../src/lib/observer-containment.js';
import { observerArtifactFor } from '../src/lib/observer-artifacts.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-linux-unit-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function writeHelpers(helperDir, platform = 'linux-x64') {
  fs.mkdirSync(helperDir, { recursive: true });
  const binaries = {};
  for (const name of ['linux-guardian', 'marked-exec', 'pty-marked-exec']) {
    const bytes = `fixture-only:${name}\n`;
    fs.writeFileSync(path.join(helperDir, name), bytes, { mode: 0o700 });
    binaries[name] = { sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }
  fs.writeFileSync(path.join(helperDir, 'manifest.json'), JSON.stringify({ schema: 1, platform, binaries }));
}

test('factory preserves Darwin selection and selects Linux helpers and artifacts', async (t) => {
  const dataDir = fixture(t);
  const darwin = createObserverContainment({ dataDir, platform: 'darwin', arch: 'arm64' });
  assert.equal(darwin.constructor, DarwinObserverContainment);
  assert.equal(path.basename(darwin.helperPaths.guardian), 'darwin-guardian');
  await darwin.verifyHelperManifest();
  const linux = createObserverContainment({ dataDir, platform: 'linux', arch: 'x64' });
  assert.equal(linux.constructor, LinuxObserverContainment);
  assert.equal(path.basename(linux.helperPaths.guardian), 'linux-guardian');
  assert.equal(path.basename(linux.helperDir), 'linux-x64');
  assert.equal(observerArtifactFor('linux', 'x64').platform, 'linux-x64');
});

test('Linux verifies platform, executable bytes, and helper identity before launch', async (t) => {
  const dataDir = fixture(t);
  const helperDir = path.join(dataDir, 'helpers');
  writeHelpers(helperDir);
  let spawned = false;
  const containment = new LinuxObserverContainment({
    dataDir, helperDir, platform: 'linux', arch: 'x64',
    spawnImpl() { spawned = true; throw new Error('must not spawn'); },
  });
  assert.equal((await containment.verifyHelpers()).guardian, path.join(helperDir, 'linux-guardian'));
  fs.appendFileSync(path.join(helperDir, 'linux-guardian'), 'tampered');
  await assert.rejects(containment.startGeneration({ generation: 1, runtime: 'codex', binaryPath: '/unused' }),
    { code: 'invalid_helper' });
  assert.equal(spawned, false);
  writeHelpers(helperDir, 'darwin-arm64');
  await assert.rejects(containment.verifyHelpers(), { code: 'invalid_helper_manifest' });
  writeHelpers(helperDir);
  fs.chmodSync(path.join(helperDir, 'marked-exec'), 0o600);
  await assert.rejects(containment.verifyHelpers(), { code: 'invalid_helper' });
});

test('Linux rejects a symlink helper or manifest and unsupported architecture', async (t) => {
  const dataDir = fixture(t);
  const helperDir = path.join(dataDir, 'helpers');
  writeHelpers(helperDir);
  const containment = new LinuxObserverContainment({ dataDir, helperDir, platform: 'linux', arch: 'x64' });
  fs.renameSync(path.join(helperDir, 'marked-exec'), path.join(helperDir, 'actual'));
  fs.symlinkSync(path.join(helperDir, 'actual'), path.join(helperDir, 'marked-exec'));
  await assert.rejects(containment.verifyHelpers(), { code: 'invalid_helper' });
  fs.renameSync(path.join(helperDir, 'manifest.json'), path.join(helperDir, 'manifest-actual.json'));
  fs.symlinkSync(path.join(helperDir, 'manifest-actual.json'), path.join(helperDir, 'manifest.json'));
  await assert.rejects(containment.verifyHelpers(), { code: 'invalid_helper_manifest' });
  const nonNative = new LinuxObserverContainment({ dataDir, helperDir, platform: 'linux', arch: 'ia32' });
  await assert.rejects(nonNative.verifyHelpers(), { code: 'unsupported_platform' });
});

for (const platform of ['darwin', 'linux']) test(`${platform} isolates inherited HOME, XDG, Zellij and temporary roots`, async (t) => {
  const dataDir = fixture(t);
  const root = path.join(dataDir, 'generation');
  const socketRoot = path.join(dataDir, 'sockets');
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
    'XDG_RUNTIME_DIR', 'XDG_CONFIG_DIRS', 'XDG_DATA_DIRS', 'XDG_UNKNOWN_ROOT',
    'ZELLIJ_CONFIG_DIR', 'ZELLIJ_CACHE_DIR', 'ZELLIJ_DATA_DIR', 'ZELLIJ_SOCKET_DIR', 'ZELLIJ_SESSION_NAME', 'ZELLIJ',
    'TMPDIR', 'TMP', 'TEMP', 'ZYLOS_GUARDIAN_TEST_INJECT'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = '/producer/private/root';
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const containment = createObserverContainment({ dataDir, platform, arch: 'arm64' });
  const environment = await containment._privateEnvironment(root, socketRoot);
  for (const key of keys) {
    if (['XDG_UNKNOWN_ROOT', 'ZELLIJ_SESSION_NAME', 'ZELLIJ', 'ZYLOS_GUARDIAN_TEST_INJECT'].includes(key)) {
      assert.equal(environment[key], undefined);
      continue;
    }
    const directory = path.resolve(environment[key]);
    assert.ok(directory.startsWith(`${root}/`) || directory === socketRoot, `${key}: ${directory}`);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
  assert.equal(environment.XDG_RUNTIME_DIR, socketRoot);
  assert.equal(environment.TERM, 'xterm-256color');
  if (platform === 'darwin') {
    assert.equal(environment.ZELLIJ_CACHE_DIR, path.join(root, 'home', 'Library', 'Caches', 'org.Zellij-Contributors.Zellij'));
    assert.equal(environment.ZELLIJ_DATA_DIR, path.join(root, 'home', 'Library', 'Application Support', 'org.Zellij-Contributors.Zellij'));
  }
});

test('Linux ARM64 selects its own manifest and rejects x64 artifacts', async (t) => {
  const dataDir = fixture(t);
  const helperDir = path.join(dataDir, 'helpers');
  const containment = createObserverContainment({ dataDir, helperDir, platform: 'linux', arch: 'arm64' });
  assert.equal(containment.constructor, LinuxObserverContainment);
  writeHelpers(helperDir, 'linux-x64');
  await assert.rejects(containment.verifyHelpers(), { code: 'invalid_helper_manifest' });
  writeHelpers(helperDir, 'linux-arm64');
  assert.equal((await containment.verifyHelpers()).guardian, path.join(helperDir, 'linux-guardian'));
  assert.equal(observerArtifactFor('linux', 'arm64').platform, 'linux-arm64');
});

test('empty Linux and unsupported hosts reconcile without helpers, persisted state fails closed', async (t) => {
  for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64']]) {
    const dataDir = fixture(t);
    const containment = createObserverContainment({ dataDir, platform, arch, helperDir: path.join(dataDir, 'missing') });
    assert.deepEqual(await containment.reconcilePersisted(), []);
    fs.mkdirSync(containment.runtimeRoot, { recursive: true });
    assert.deepEqual(await containment.reconcilePersisted(), []);
    fs.mkdirSync(path.join(containment.runtimeRoot, 'persisted'));
    await assert.rejects(containment.reconcilePersisted());
    assert.equal(fs.existsSync(path.join(containment.runtimeRoot, 'persisted')), true);
  }
});
