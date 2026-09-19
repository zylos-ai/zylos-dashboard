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
const containmentProbePath = new URL('./darwin-containment-probe.mjs', import.meta.url).pathname;

function events(output) {
  return output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function identity(pid, env = process.env) {
  const result = spawnSync(guardianPath, ['identity', String(pid)], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

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

async function waitForOutput(readOutput, needle, label, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (readOutput().includes(needle)) return;
    await delay(25);
  }
  throw new Error(`${label} did not emit ${needle}: ${readOutput()}`);
}

const parentIdentity = identity(process.pid);

const cleanupEnvContract = spawnSync(process.execPath, [containmentProbePath, '--cleanup-env-selftest'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    ZYLOS_GUARDIAN_TEST_FAIL_CENSUS: 'always',
    ZYLOS_GUARDIAN_TEST_FAIL_IDENTITY: 'all:always',
    ZYLOS_GUARDIAN_TEST_COLLAPSE_IDENTITY_ERROR: '1',
    ZYLOS_GUARDIAN_TEST_FAIL_LISTPIDS: 'fill:always',
    ZYLOS_GUARDIAN_TEST_COLLAPSE_LISTPIDS_ZERO: '1',
  },
});
assert.equal(cleanupEnvContract.status, 0, cleanupEnvContract.stderr || cleanupEnvContract.stdout);
assert.deepEqual(events(cleanupEnvContract.stdout), [{
  event: 'cleanup-env-selftest',
  result: 'pass',
  remaining: [],
}]);

const listpidsContract = spawnSync(guardianPath, ['listpids-selftest'], { encoding: 'utf8' });
assert.equal(listpidsContract.status, 0, listpidsContract.stderr || listpidsContract.stdout);
const listpidsContractEvent = events(listpidsContract.stdout)[0];
assert.equal(listpidsContractEvent.result, 'pass');
assert.equal(listpidsContractEvent.normalCount, 2);
assert.equal(listpidsContractEvent.permanentZeroErrno, 5);
assert.equal(listpidsContractEvent.temporaryZeroErrno, 5);
assert.equal(listpidsContractEvent.temporaryRecovered, true);
assert.equal(listpidsContractEvent.saturationFillCalls, 2);
assert.equal(listpidsContractEvent.saturationSecondBytes, listpidsContractEvent.saturationFirstBytes * 2);
assert.equal(listpidsContractEvent.boundaryErrno, 84);
assert.equal(listpidsContractEvent.misalignedErrno, 5);
assert.equal(listpidsContractEvent.knownBadFalseEmpty, true);

const unrelated = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
const identityOwned = spawn(markedExecPath, [markerPath, '/bin/sh', '-c', 'trap "" TERM; exec /bin/sleep 60'], { stdio: 'ignore' });
await waitForOwned(identityOwned.pid);
const ownedIdentity = identity(identityOwned.pid);

const failedIdentityEnv = { ...process.env, ZYLOS_GUARDIAN_TEST_FAIL_IDENTITY: `${identityOwned.pid}:always` };
const identityCliFailure = spawnSync(guardianPath, ['identity', String(identityOwned.pid)], {
  encoding: 'utf8',
  env: failedIdentityEnv,
});
assert.equal(identityCliFailure.status, 5, identityCliFailure.stderr || identityCliFailure.stdout);
assert.deepEqual(events(identityCliFailure.stdout), [{ event: 'identity-error', pid: identityOwned.pid, errno: 5 }]);

const oracleFailure = spawnSync(process.execPath, [
  containmentProbePath,
  '--identity-oracle',
  '--guardian', guardianPath,
  '--pid', String(identityOwned.pid),
  '--start-sec', String(ownedIdentity.startSec),
  '--start-usec', String(ownedIdentity.startUsec),
], {
  encoding: 'utf8',
  env: failedIdentityEnv,
});
assert.notEqual(oracleFailure.status, 0, 'whole-topology oracle collapsed identity exit 5 into absence');
assert.match(`${oracleFailure.stdout}\n${oracleFailure.stderr}`, /identity query failed/);

const absentParentStartSec = parentIdentity.startUsec === 999999 ? parentIdentity.startSec + 1 : parentIdentity.startSec;
const absentParentStartUsec = parentIdentity.startUsec === 999999 ? 0 : parentIdentity.startUsec + 1;
const reconcileArgs = [
  'reconcile', String(process.pid), String(absentParentStartSec), String(absentParentStartUsec), marker, '500',
];
const collapsedIdentityFailure = spawnSync(guardianPath, reconcileArgs, {
  encoding: 'utf8',
  env: { ...failedIdentityEnv, ZYLOS_GUARDIAN_TEST_COLLAPSE_IDENTITY_ERROR: '1' },
});
assert.equal(collapsedIdentityFailure.status, 0, collapsedIdentityFailure.stderr || collapsedIdentityFailure.stdout);
assert.match(collapsedIdentityFailure.stdout, /"event":"clean"/);
assert.equal(identityOwned.exitCode, null, 'known-bad collapse unexpectedly removed the owned process');

const permanentIdentityFailure = spawnSync(guardianPath, reconcileArgs, {
  encoding: 'utf8',
  env: failedIdentityEnv,
});
assert.notEqual(permanentIdentityFailure.status, 0, 'permanent identity failure falsely reported clean');
assert.match(permanentIdentityFailure.stdout, new RegExp(`"event":"census-error","errno":5,"queryPid":${identityOwned.pid}`));
assert.equal(identityOwned.exitCode, null, 'permanent identity failure signaled an unknown identity');

// Target-specific calls 1–2 establish a stable census identity; call 3 checks
// the tracked identity. Fail there before any TERM pass can complete.
const identityGuardian = spawn(guardianPath, [
  'watch',
  '3',
  String(process.pid),
  String(parentIdentity.startSec),
  String(parentIdentity.startUsec),
  marker,
  '8000',
], {
  env: { ...process.env, ZYLOS_GUARDIAN_TEST_FAIL_IDENTITY: `${identityOwned.pid}:3-20` },
  stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
});
let identityGuardianOutput = '';
let identityGuardianError = '';
identityGuardian.stdout.setEncoding('utf8');
identityGuardian.stderr.setEncoding('utf8');
identityGuardian.stdout.on('data', (chunk) => { identityGuardianOutput += chunk; });
identityGuardian.stderr.on('data', (chunk) => { identityGuardianError += chunk; });
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('identity guardian did not enter watch mode')), 3000);
  const inspect = () => {
    if (identityGuardianOutput.includes('"event":"watching"')) {
      clearTimeout(timeout);
      resolve();
    }
  };
  identityGuardian.stdout.on('data', inspect);
  inspect();
});
const identityStarted = performance.now();
identityGuardian.stdio[3].end();
const [identityGuardianCode] = await once(identityGuardian, 'exit');
const identityElapsedMs = Math.round(performance.now() - identityStarted);
assert.equal(identityGuardianCode, 0, identityGuardianError || identityGuardianOutput);
const identityGuardianEvents = events(identityGuardianOutput);
const identityErrorIndex = identityGuardianEvents.findIndex((event) =>
  event.pid === identityOwned.pid && event.event === 'identity-error');
const identityOwnedIndex = identityGuardianEvents.findIndex((event) => event.event === 'owned' && event.pid === identityOwned.pid);
const identityKillIndex = identityGuardianEvents.findIndex((event) => event.event === 'kill' && event.pid === identityOwned.pid);
assert.ok(identityErrorIndex >= 0 && identityOwnedIndex > identityErrorIndex && identityKillIndex > identityOwnedIndex,
  'transient identity failure did not fail closed, recover, and kill the exact owner');
assert.ok(!identityGuardianEvents.slice(0, identityOwnedIndex).some((event) => event.event === 'clean'),
  'transient identity unknown advanced stable-zero before recovery');
assert.ok(identityElapsedMs >= 1500, `TERM grace started before the first complete TERM pass: ${identityElapsedMs}ms`);
if (identityOwned.exitCode === null && identityOwned.signalCode === null) await once(identityOwned, 'exit');

const parentIdentityFailure = spawnSync(guardianPath, [
  'reconcile', String(process.pid), String(parentIdentity.startSec), String(parentIdentity.startUsec), marker, '500',
], {
  encoding: 'utf8',
  env: { ...process.env, ZYLOS_GUARDIAN_TEST_FAIL_IDENTITY: `${process.pid}:always` },
});
assert.equal(parentIdentityFailure.status, 5, parentIdentityFailure.stderr || parentIdentityFailure.stdout);
assert.deepEqual(events(parentIdentityFailure.stdout), [{ event: 'identity-error', pid: process.pid, errno: 5 }]);

const collapsedParentIdentity = spawnSync(guardianPath, [
  'reconcile', String(process.pid), String(parentIdentity.startSec), String(parentIdentity.startUsec), marker, '500',
], {
  encoding: 'utf8',
  env: {
    ...process.env,
    ZYLOS_GUARDIAN_TEST_FAIL_IDENTITY: `${process.pid}:always`,
    ZYLOS_GUARDIAN_TEST_COLLAPSE_IDENTITY_ERROR: '1',
  },
});
assert.equal(collapsedParentIdentity.status, 0, collapsedParentIdentity.stderr || collapsedParentIdentity.stdout);
assert.match(collapsedParentIdentity.stdout, /"event":"reconcile"/,
  'known-bad parent identity collapse did not falsely enter reconcile');

const watchParent = spawn(guardianPath, [
  'watch', '3', String(process.pid), String(parentIdentity.startSec), String(parentIdentity.startUsec), marker, '1500',
], {
  env: { ...process.env, ZYLOS_GUARDIAN_TEST_FAIL_IDENTITY: `${process.pid}:1-3` },
  stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
});
let watchParentOutput = '';
let watchParentError = '';
watchParent.stdout.setEncoding('utf8');
watchParent.stderr.setEncoding('utf8');
watchParent.stdout.on('data', (chunk) => { watchParentOutput += chunk; });
watchParent.stderr.on('data', (chunk) => { watchParentError += chunk; });
await waitForOutput(() => watchParentOutput, '"event":"identity-error"', 'parent identity watch');
await waitForOutput(
  () => watchParentOutput.match(/"event":"identity-error"/g)?.length >= 3 ? 'three-errors' : watchParentOutput,
  'three-errors',
  'parent identity watch',
);
assert.doesNotMatch(watchParentOutput, /"event":"parent-gone"/,
  'unknown parent identity was collapsed into parent-gone');
watchParent.stdio[3].end();
const [watchParentCode] = await once(watchParent, 'exit');
assert.equal(watchParentCode, 0, watchParentError || watchParentOutput);
assert.match(watchParentOutput, /"event":"liveness-gone"/,
  'liveness HUP did not remain a separate definitive cleanup trigger');

const collapsedWatchParent = spawn(guardianPath, [
  'watch', '3', String(process.pid), String(parentIdentity.startSec), String(parentIdentity.startUsec), marker, '500',
], {
  env: {
    ...process.env,
    ZYLOS_GUARDIAN_TEST_FAIL_IDENTITY: `${process.pid}:1-3`,
    ZYLOS_GUARDIAN_TEST_COLLAPSE_IDENTITY_ERROR: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
});
let collapsedWatchOutput = '';
collapsedWatchParent.stdout.setEncoding('utf8');
collapsedWatchParent.stdout.on('data', (chunk) => { collapsedWatchOutput += chunk; });
await waitForOutput(() => collapsedWatchOutput, '"event":"parent-gone"', 'known-bad parent watch');
collapsedWatchParent.stdio[3].end();
const [collapsedWatchCode] = collapsedWatchParent.exitCode === null && collapsedWatchParent.signalCode === null
  ? await once(collapsedWatchParent, 'exit')
  : [collapsedWatchParent.exitCode];
assert.equal(collapsedWatchCode, 0,
  `known-bad parent watch did not falsely complete: ${collapsedWatchOutput}`);

const listpidsOwned = spawn(markedExecPath, [markerPath, '/bin/sh', '-c', 'trap "" TERM; exec /bin/sleep 60'], { stdio: 'ignore' });
await waitForOwned(listpidsOwned.pid);
const listpidsReconcileArgs = [
  'reconcile', String(process.pid), String(absentParentStartSec), String(absentParentStartUsec), marker, '500',
];
const permanentListpidsFailure = spawnSync(guardianPath, listpidsReconcileArgs, {
  encoding: 'utf8',
  env: { ...process.env, ZYLOS_GUARDIAN_TEST_FAIL_LISTPIDS: 'fill:always' },
});
assert.equal(permanentListpidsFailure.status, 3, permanentListpidsFailure.stderr || permanentListpidsFailure.stdout);
const permanentListpidsEvents = events(permanentListpidsFailure.stdout);
assert.ok(permanentListpidsEvents.some((event) => event.event === 'census-error' && event.errno === 5));
assert.ok(!permanentListpidsEvents.some((event) => event.event === 'clean'),
  'fill 0/EIO advanced stable-zero');
assert.equal(listpidsOwned.exitCode, null, 'fill failure signaled an undiscovered process');

const collapsedListpidsFailure = spawnSync(guardianPath, [...listpidsReconcileArgs.slice(0, -1), '2000'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    ZYLOS_GUARDIAN_TEST_FAIL_LISTPIDS: 'fill:always',
    ZYLOS_GUARDIAN_TEST_COLLAPSE_LISTPIDS_ZERO: '1',
  },
});
assert.equal(collapsedListpidsFailure.status, 0, collapsedListpidsFailure.stderr || collapsedListpidsFailure.stdout);
assert.match(collapsedListpidsFailure.stdout, /"event":"clean"/,
  'known-bad listpids collapse did not falsely report stable-zero');
assert.equal(listpidsOwned.exitCode, null, 'known-bad listpids control unexpectedly removed its survivor');
listpidsOwned.kill('SIGKILL');
await once(listpidsOwned, 'exit');

const transientListpidsOwned = spawn(markedExecPath, [markerPath, '/bin/sh', '-c', 'trap "" TERM; exec /bin/sleep 60'], { stdio: 'ignore' });
await waitForOwned(transientListpidsOwned.pid);
const transientListpidsGuardian = spawn(guardianPath, [
  'watch', '3', String(process.pid), String(parentIdentity.startSec), String(parentIdentity.startUsec), marker, '8000',
], {
  env: { ...process.env, ZYLOS_GUARDIAN_TEST_FAIL_LISTPIDS: 'fill:1-3' },
  stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
});
let transientListpidsOutput = '';
let transientListpidsError = '';
transientListpidsGuardian.stdout.setEncoding('utf8');
transientListpidsGuardian.stderr.setEncoding('utf8');
transientListpidsGuardian.stdout.on('data', (chunk) => { transientListpidsOutput += chunk; });
transientListpidsGuardian.stderr.on('data', (chunk) => { transientListpidsError += chunk; });
await waitForOutput(() => transientListpidsOutput, '"event":"watching"', 'listpids transient watch');
transientListpidsGuardian.stdio[3].end();
const [transientListpidsCode] = await once(transientListpidsGuardian, 'exit');
assert.equal(transientListpidsCode, 0, transientListpidsError || transientListpidsOutput);
const transientListpidsEvents = events(transientListpidsOutput);
const transientListpidsErrorIndex = transientListpidsEvents.findIndex((event) =>
  event.event === 'census-error' && event.errno === 5);
const transientListpidsOwnedIndex = transientListpidsEvents.findIndex((event) =>
  event.event === 'owned' && event.pid === transientListpidsOwned.pid);
const transientListpidsKillIndex = transientListpidsEvents.findIndex((event) =>
  event.event === 'kill' && event.pid === transientListpidsOwned.pid);
assert.ok(transientListpidsErrorIndex >= 0 && transientListpidsOwnedIndex > transientListpidsErrorIndex &&
  transientListpidsKillIndex > transientListpidsOwnedIndex,
  'transient listpids failure did not fail closed, recover, and kill the exact owner');
assert.ok(!transientListpidsEvents.slice(0, transientListpidsOwnedIndex).some((event) => event.event === 'clean'),
  'transient listpids failure advanced stable-zero before recovery');
if (transientListpidsOwned.exitCode === null && transientListpidsOwned.signalCode === null) {
  await once(transientListpidsOwned, 'exit');
}

const survivorOwned = spawn(markedExecPath, [markerPath, '/bin/sh', '-c', 'trap "" TERM; exec /bin/sleep 60'], { stdio: 'ignore' });
await waitForOwned(survivorOwned.pid);
const survivorArgs = [
  'reconcile', String(process.pid), String(absentParentStartSec), String(absentParentStartUsec), marker, '400',
];
const survivorUnknown = spawnSync(guardianPath, survivorArgs, {
  encoding: 'utf8',
  env: { ...process.env, ZYLOS_GUARDIAN_TEST_FAIL_IDENTITY: `${survivorOwned.pid}:3-1000` },
});
assert.equal(survivorUnknown.status, 3, survivorUnknown.stderr || survivorUnknown.stdout);
const survivorUnknownEvents = events(survivorUnknown.stdout);
assert.ok(survivorUnknownEvents.some((event) => event.event === 'identity-error' && event.pid === survivorOwned.pid),
  'timeout survivor did not report its unknown identity');
assert.ok(!survivorUnknownEvents.some((event) => ['term', 'kill'].includes(event.event) && event.pid === survivorOwned.pid),
  'timeout path signaled a process while its identity was unknown');
assert.equal(survivorOwned.exitCode, null, 'timeout identity unknown lost the exact survivor');

const collapsedSurvivor = spawnSync(guardianPath, [...survivorArgs.slice(0, -1), '2000'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    ZYLOS_GUARDIAN_TEST_FAIL_IDENTITY: `${survivorOwned.pid}:3-1000`,
    ZYLOS_GUARDIAN_TEST_COLLAPSE_IDENTITY_ERROR: '1',
  },
});
assert.equal(collapsedSurvivor.status, 0, collapsedSurvivor.stderr || collapsedSurvivor.stdout);
assert.match(collapsedSurvivor.stdout, /"event":"clean"/,
  'known-bad timeout identity collapse did not falsely report stable-zero');
assert.equal(survivorOwned.exitCode, null, 'known-bad timeout control unexpectedly removed its survivor');
survivorOwned.kill('SIGKILL');
await once(survivorOwned, 'exit');

const signalOwned = spawn(markedExecPath, [markerPath, '/bin/sh', '-c', 'trap "" TERM; exec /bin/sleep 60'], { stdio: 'ignore' });
await waitForOwned(signalOwned.pid);
// Calls 1–2 are census, 3 is tracked liveness, and 4 is the final
// identity check immediately before sending TERM.
const signalGuardian = spawn(guardianPath, [
  'reconcile', String(process.pid), String(absentParentStartSec), String(absentParentStartUsec), marker, '4000',
], {
  env: { ...process.env, ZYLOS_GUARDIAN_TEST_FAIL_IDENTITY: `${signalOwned.pid}:4-4` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let signalRecheckOutput = '';
let signalRecheckError = '';
signalGuardian.stdout.setEncoding('utf8');
signalGuardian.stderr.setEncoding('utf8');
signalGuardian.stdout.on('data', (chunk) => { signalRecheckOutput += chunk; });
signalGuardian.stderr.on('data', (chunk) => { signalRecheckError += chunk; });
const [signalRecheckCode] = await once(signalGuardian, 'exit');
assert.equal(signalRecheckCode, 0, signalRecheckError || signalRecheckOutput);
const signalRecheckEvents = events(signalRecheckOutput);
const signalUnknownIndex = signalRecheckEvents.findIndex((event) =>
  event.event === 'identity-error' && event.pid === signalOwned.pid);
const signalOwnedIndex = signalRecheckEvents.findIndex((event) => event.event === 'owned' && event.pid === signalOwned.pid);
assert.ok(signalOwnedIndex >= 0 && signalOwnedIndex < signalUnknownIndex,
  'signal fault did not reach the pre-signal check after establishing tracked liveness');
const signalTermIndex = signalRecheckEvents.findIndex((event) => event.event === 'term' && event.pid === signalOwned.pid);
const signalKillIndex = signalRecheckEvents.findIndex((event) => event.event === 'kill' && event.pid === signalOwned.pid);
assert.ok(signalUnknownIndex >= 0 && signalTermIndex > signalUnknownIndex && signalKillIndex > signalTermIndex,
  'signal recheck did not fail closed, recover, TERM, and then KILL the exact owner');
assert.ok(!signalRecheckEvents.slice(0, signalUnknownIndex + 1).some((event) =>
  ['term', 'kill'].includes(event.event) && event.pid === signalOwned.pid),
  'signal recheck signaled the owner while its identity was unknown');
if (signalOwned.exitCode === null && signalOwned.signalCode === null) await once(signalOwned, 'exit');

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
const guardianEvents = events(guardianOutput);
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
  listpidsContract: listpidsContractEvent,
  listpidsFailure: {
    permanentExitCode: permanentListpidsFailure.status,
    permanentEvents: permanentListpidsEvents,
    knownBadExitCode: collapsedListpidsFailure.status,
    knownBadEvents: events(collapsedListpidsFailure.stdout),
    transientEvents: transientListpidsEvents,
  },
  identityTriState: {
    identityCliExitCode: identityCliFailure.status,
    oracleExitCode: oracleFailure.status,
    knownBadCollapseExitCode: collapsedIdentityFailure.status,
    permanentFailureExitCode: permanentIdentityFailure.status,
    transientElapsedMs: identityElapsedMs,
    transientEvents: identityGuardianEvents,
    reconcileParentExitCode: parentIdentityFailure.status,
    knownBadReconcileParentExitCode: collapsedParentIdentity.status,
    watchParentEvents: events(watchParentOutput),
    knownBadWatchParentEvents: events(collapsedWatchOutput),
    timeoutSurvivorExitCode: survivorUnknown.status,
    timeoutSurvivorEvents: survivorUnknownEvents,
    knownBadTimeoutSurvivorExitCode: collapsedSurvivor.status,
    signalRecheckEvents,
  },
  permanentFailure: {
    exitCode: permanentFailure.status,
    events: events(permanentFailure.stdout),
  },
};
if (evidenceFile) fs.writeFileSync(evidenceFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify(report)}\n`);
