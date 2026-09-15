import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const [guardianPath, markedExecPath, runtimeRoot] = process.argv.slice(2);
if (!guardianPath || !markedExecPath || !runtimeRoot) {
  throw new Error('usage: guardian-selftest.mjs <guardian> <marked-exec> <runtime-root>');
}

const markerPath = path.join(runtimeRoot, 'guardian-selftest.marker');
fs.writeFileSync(markerPath, 'stage-a guardian self-test\n', { mode: 0o600 });
const marker = `fdpath:${markerPath}`;

const identityResult = spawnSync(guardianPath, ['identity', String(process.pid)], {
  encoding: 'utf8',
});
assert.equal(identityResult.status, 0, identityResult.stderr);
const parentIdentity = JSON.parse(identityResult.stdout.trim());

const unrelated = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
const owned = spawn(markedExecPath, [markerPath, '/bin/sleep', '60'], { stdio: 'ignore' });

const guardian = spawn(guardianPath, [
  'watch',
  '3',
  String(process.pid),
  String(parentIdentity.startSec),
  String(parentIdentity.startUsec),
  marker,
  '8000',
], {
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

const censusBefore = spawnSync(guardianPath, ['census', marker], { encoding: 'utf8' });
assert.equal(censusBefore.status, 2, censusBefore.stderr);
assert.match(censusBefore.stdout, new RegExp(`"pid":${owned.pid}`));

const started = performance.now();
guardian.stdio[3].end();
const [guardianCode] = await once(guardian, 'exit');
const elapsedMs = Math.round(performance.now() - started);
assert.equal(guardianCode, 0, guardianError || guardianOutput);
assert.ok(elapsedMs < 8000, `guardian cleanup exceeded bound: ${elapsedMs}ms`);

const censusAfter = spawnSync(guardianPath, ['census', marker], { encoding: 'utf8' });
assert.equal(censusAfter.status, 0, censusAfter.stdout);
assert.equal(unrelated.exitCode, null, 'unrelated process was terminated');

unrelated.kill('SIGTERM');
await once(unrelated, 'exit');
if (owned.exitCode === null) {
  owned.kill('SIGKILL');
}

process.stdout.write(`${JSON.stringify({
  result: 'pass',
  elapsedMs,
  ownedPid: owned.pid,
  unrelatedPid: unrelated.pid,
  guardianEvents: guardianOutput.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
})}\n`);
