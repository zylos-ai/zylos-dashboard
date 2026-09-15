import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { mutateConfig } from '../src/lib/config-mutation.js';

const execFileAsync = promisify(execFile);

async function waitForPath(filePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function fixture(value = { untouched: { value: 1 } }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-config-mutation-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return { directory, configPath };
}

test('config mutations serialize overlapping producers without losing unrelated fields', async (t) => {
  const { directory, configPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let releaseFirst;
  const firstCanFinish = new Promise((resolve) => { releaseFirst = resolve; });
  let firstEntered;
  const firstDidEnter = new Promise((resolve) => { firstEntered = resolve; });

  const settings = mutateConfig(configPath, async (config) => {
    firstEntered();
    await firstCanFinish;
    config.settings = { saved: true };
  });
  await firstDidEnter;
  const observer = mutateConfig(configPath, (config) => {
    config.observer = { enabled: false };
  });
  releaseFirst();
  await Promise.all([settings, observer]);

  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(saved, {
    untouched: { value: 1 },
    settings: { saved: true },
    observer: { enabled: false },
  });
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test('invalid existing JSON fails closed without replacement', async (t) => {
  const { directory, configPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(configPath, '{ invalid\n');
  await assert.rejects(
    mutateConfig(configPath, (config) => { config.observer = { enabled: true }; }),
    (error) => error?.code === 'invalid_config',
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{ invalid\n');
});

test('config lock serializes separate producer processes', async (t) => {
  const { directory, configPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/lib/config-mutation.js', import.meta.url).href;
  const script = `
    const [{ mutateConfig }, moduleUrl, configPath, field, wait] = [
      await import(process.argv[1]), process.argv[1], process.argv[2], process.argv[3], Number(process.argv[4])
    ];
    await mutateConfig(configPath, async (config) => {
      await new Promise((resolve) => setTimeout(resolve, wait));
      config[field] = { pid: process.pid };
    });
  `;
  await Promise.all([
    execFileAsync(process.execPath, ['--input-type=module', '--eval', script, moduleUrl, configPath, 'settings', '80']),
    execFileAsync(process.execPath, ['--input-type=module', '--eval', script, moduleUrl, configPath, 'configure', '0']),
  ]);
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(typeof saved.settings.pid, 'number');
  assert.equal(typeof saved.configure.pid, 'number');
  assert.deepEqual(saved.untouched, { value: 1 });
});

test('dead stale lock is recovered but a live lock times out', async (t) => {
  const { directory, configPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = `${configPath}.lock`;
  fs.mkdirSync(lockPath, { mode: 0o700 });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 999_999_999, nonce: 'dead' }));
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, stale, stale);
  await mutateConfig(configPath, (config) => { config.recovered = true; }, { staleLockMs: 5, lockTimeoutMs: 200 });
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).recovered, true);

  fs.mkdirSync(lockPath, { mode: 0o700 });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, nonce: 'live' }));
  fs.utimesSync(lockPath, stale, stale);
  await assert.rejects(
    mutateConfig(configPath, () => {}, { staleLockMs: 5, lockTimeoutMs: 30, retryMs: 5 }),
    (error) => error?.code === 'lock_timeout',
  );
});

test('competing stale-lock recoverers in separate processes cannot remove a successor lock', async (t) => {
  const { directory, configPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = `${configPath}.lock`;
  fs.mkdirSync(lockPath, { mode: 0o700 });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 999_999_999, nonce: 'dead' }));
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, stale, stale);
  const moduleUrl = new URL('../src/lib/config-mutation.js', import.meta.url).href;
  const pausedPath = path.join(directory, 'first-paused');
  const allowPath = path.join(directory, 'allow-first');
  const secondEnteredPath = path.join(directory, 'second-entered');
  const criticalPath = path.join(directory, 'critical');
  const overlapPath = path.join(directory, 'overlap');
  const script = `
    import fs from 'node:fs';
    const [moduleUrl, configPath, role, pausedPath, allowPath, secondEnteredPath, criticalPath, overlapPath] = process.argv.slice(1);
    const originalRename = fs.promises.rename.bind(fs.promises);
    let paused = false;
    if (role === 'first') fs.promises.rename = async (source, destination) => {
      if (!paused && source === configPath + '.lock' && destination.startsWith(source + '.stale-')) {
        paused = true;
        fs.writeFileSync(pausedPath, 'ready');
        while (!fs.existsSync(allowPath)) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return originalRename(source, destination);
    };
    const { mutateConfig } = await import(moduleUrl);
    await mutateConfig(configPath, async (config) => {
      if (role === 'second') fs.writeFileSync(secondEnteredPath, 'entered');
      try { fs.mkdirSync(criticalPath); } catch (error) {
        if (error.code === 'EEXIST') fs.writeFileSync(overlapPath, 'overlap');
        else throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
      config[role] = true;
      try { fs.rmdirSync(criticalPath); } catch {}
    }, { staleLockMs: 5, lockTimeoutMs: 2_000, retryMs: 5 });
  `;
  const args = [moduleUrl, configPath, 'first', pausedPath, allowPath, secondEnteredPath, criticalPath, overlapPath];
  const first = execFileAsync(process.execPath, ['--input-type=module', '--eval', script, ...args]);
  await waitForPath(pausedPath);
  args[2] = 'second';
  const second = execFileAsync(process.execPath, ['--input-type=module', '--eval', script, ...args]);
  await Promise.race([
    waitForPath(secondEnteredPath, 250).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 250)),
  ]);
  fs.writeFileSync(allowPath, 'go');
  await Promise.all([first, second]);
  assert.equal(fs.existsSync(overlapPath), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
    untouched: { value: 1 }, first: true, second: true,
  });
});
