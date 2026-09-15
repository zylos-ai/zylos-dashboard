import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { mutateConfig } from '../src/lib/config-mutation.js';

const execFileAsync = promisify(execFile);

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
