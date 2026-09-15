import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const [guardianPath, markedExecPath, runtimeRoot, evidenceFile] = process.argv.slice(2);
if (!guardianPath || !markedExecPath || !runtimeRoot) {
  throw new Error('usage: guardian-selftest.mjs <guardian> <marked-exec> <runtime-root> [evidence-file]');
}

const markerPath = path.join(runtimeRoot, 'guardian-selftest.marker');
fs.writeFileSync(markerPath, 'stage-a guardian self-test\n', { mode: 0o600 });
const marker = `fdpath:${markerPath}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForOwned(pid, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  let lastResult;
  while (performance.now() < deadline) {
    lastResult = spawnSync(guardianPath, ['census', marker], { encoding: 'utf8' });
    if (lastResult.status === 2 && new RegExp(`"pid":${pid}(?:,|})`).test(lastResult.stdout)) {
      return lastResult;
    }
    await delay(50);
  }
  throw new Error(`owned process ${pid} was not discovered: ${lastResult?.stdout || lastResult?.stderr || 'no census output'}`);
}

const identityResult = spawnSync(guardianPath, ['identity', String(process.pid)], {
  encoding: 'utf8',
});
assert.equal(identityResult.status, 0, identityResult.stderr);
const parentIdentity = JSON.parse(identityResult.stdout.trim());

const unrelated = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
const owned = spawn(markedExecPath, [markerPath, '/bin/sh', '-c', 'trap "" TERM; exec /bin/sleep 60'], { stdio: 'ignore' });

const guardian = spawn(guardianPath, [
  'watch',
  '3',
  String(process.pid),
  String(parentIdentity.startSec),
  String(parentIdentity.startUsec),
  marker,
  '8000',
], {
  env: { ...process.env, ZYLOS_GUARDIAN_TEST_FAIL_CENSUS: '2-30' },
  stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
});

let guardianOutput = '';
let guardianError = '';
guardian.stdout.setEncoding('utf8');
guardian.stderr.setEncoding('utf8');
guardian.stdout.on('data', (chunk) => { guardianOutput += chunk; });
guardian.stderr.on('data', (chunk) => { guardianError += chunk; });

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('guardian did not enter watch mode')), 3000);
  const inspect = () => {
    if (guardianOutput.includes('"event":"watching"')) {
      clearTimeout(timeout);
      resolve();
    }
  };
  guardian.stdout.on('data', inspect);
  inspect();
});

const censusBefore = await waitForOwned(owned.pid);
assert.equal(censusBefore.status, 2, censusBefore.stderr);
assert.match(censusBefore.stdout, new RegExp(`"pid":${owned.pid}`));
assert.doesNotMatch(censusBefore.stdout, new RegExp(`"pid":${unrelated.pid}(?:,|})`));
assert.match(censusBefore.stdout, /"event":"count","count":1(?:,|})/);

const permanentFailure = spawnSync(guardianPath, [
  'reconcile', String(process.pid),
  String(parentIdentity.startSec + 1), String(parentIdentity.startUsec),
  marker, '400',
], {
  encoding: 'utf8',
  env: { ...process.env, ZYLOS_GUARDIAN_TEST_FAIL_CENSUS: 'always' },
});
assert.notEqual(permanentFailure.status, 0, 'permanent census failure falsely reported clean');
assert.match(permanentFailure.stdout, /"event":"census-error"/);
assert.equal(owned.exitCode, null, 'permanent census failure lost or killed an undiscovered identity');

const started = performance.now();
guardian.stdio[3].end();
const [guardianCode] = await once(guardian, 'exit');
const elapsedMs = Math.round(performance.now() - started);
assert.equal(guardianCode, 0, guardianError || guardianOutput);
assert.ok(elapsedMs < 8000, `guardian cleanup exceeded bound: ${elapsedMs}ms`);
assert.match(guardianOutput, /"event":"census-error"/, 'transient census failure control did not execute');
const guardianEvents = guardianOutput.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const firstErrorIndex = guardianEvents.findIndex((event) => event.event === 'census-error');
const lastErrorIndex = guardianEvents.findLastIndex((event) => event.event === 'census-error');
const trackedKillIndex = guardianEvents.findIndex((event) => event.event === 'kill' && event.pid === owned.pid);
assert.ok(firstErrorIndex >= 0 && trackedKillIndex > firstErrorIndex && trackedKillIndex < lastErrorIndex,
  'guardian did not continue signaling the previously tracked exact identity during census failure');

const censusAfter = spawnSync(guardianPath, ['census', marker], { encoding: 'utf8' });
assert.equal(censusAfter.status, 0, censusAfter.stdout);
assert.equal(unrelated.exitCode, null, 'unrelated process was terminated');

unrelated.kill('SIGTERM');
await once(unrelated, 'exit');
if (owned.exitCode === null) {
  owned.kill('SIGKILL');
}

const report = {
  result: 'pass',
  elapsedMs,
  ownedPid: owned.pid,
  unrelatedPid: unrelated.pid,
  guardianEvents,
  permanentFailure: {
    exitCode: permanentFailure.status,
    events: permanentFailure.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  },
};
if (evidenceFile) fs.writeFileSync(evidenceFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify(report)}\n`);
