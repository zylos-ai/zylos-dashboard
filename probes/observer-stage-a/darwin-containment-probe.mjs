import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { WsClient } from './ws-client.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  const { deadline, ...spawnOptions } = options;
  if (deadline !== undefined) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new Error(`${command} exceeded global deadline before launch`);
    spawnOptions.timeout = Math.min(spawnOptions.timeout ?? remaining, remaining);
  }
  const result = spawnSync(command, args, { encoding: 'utf8', ...spawnOptions });
  if (result.error?.code === 'ETIMEDOUT') throw new Error(`${command} exceeded global deadline`);
  return result;
}

function identity(guardian, pid, env) {
  const result = run(guardian, ['identity', String(pid)], { env });
  assert.equal(result.status, 0, result.stderr || result.stdout || `identity query failed for pid ${pid}`);
  return JSON.parse(result.stdout.trim());
}

function sameIdentityState(guardian, expected, deadline, env) {
  const result = run(guardian, ['identity', String(expected.pid)], { deadline, env });
  if (result.status === 2) return 'gone';
  if (result.status !== 0) {
    throw new Error(`identity query failed for pid ${expected.pid}: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  const actual = JSON.parse(result.stdout.trim());
  return actual.startSec === expected.startSec && actual.startUsec === expected.startUsec ? 'match' : 'changed';
}

function sameIdentityAlive(guardian, expected, deadline, env) {
  return sameIdentityState(guardian, expected, deadline, env) === 'match';
}

function aliveTopology(guardian, records, deadline) {
  return records.filter((record) => sameIdentityAlive(guardian, record, deadline));
}

function uniqueTopology(records) {
  const unique = new Map();
  for (const record of records) {
    const key = `${record.pid}:${record.startSec}:${record.startUsec}`;
    if (!unique.has(key)) unique.set(key, record);
  }
  return [...unique.values()];
}

function census(guardian, marker, deadline) {
  const result = run(guardian, ['census', marker], { deadline });
  assert.ok(result.status === 0 || result.status === 2, result.stderr);
  return {
    count: Number(result.stdout.match(/"event":"count","count":(\d+)/)?.[1] ?? -1),
    records: result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  };
}

async function waitFor(check, description, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

async function withinDeadline(promise, deadline, description) {
  const remaining = Math.max(1, deadline - performance.now());
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} exceeded global deadline`)), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function freePort() {
  const server = net.createServer();
  server.unref();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function prepareDirectory(directory, mode = 0o700) {
  fs.mkdirSync(directory, { recursive: true, mode });
  fs.chmodSync(directory, mode);
}

function makeEnvironment(caseRoot, socketRoot) {
  const home = path.join(caseRoot, 'home');
  const config = path.join(caseRoot, 'config');
  const data = path.join(caseRoot, 'data');
  const tmp = path.join(caseRoot, 'tmp');
  for (const directory of [home, config, data, tmp, socketRoot]) {
    prepareDirectory(directory);
  }
  prepareDirectory(path.join(home, 'Library'));
  prepareDirectory(path.join(home, 'Library', 'Application Support'));
  prepareDirectory(path.join(home, 'Library', 'Application Support', 'org.Zellij-Contributors.Zellij'));
  prepareDirectory(path.join(home, 'Library', 'Caches'));
  prepareDirectory(path.join(home, 'Library', 'Caches', 'org.Zellij-Contributors.Zellij'));
  return {
    ...process.env,
    HOME: home,
    TMPDIR: `${tmp}/`,
    ZELLIJ_SOCKET_DIR: socketRoot,
    ZELLIJ_CONFIG_DIR: config,
    TERM: 'xterm-256color',
  };
}

function zellijBase(paths) {
  return ['--data-dir', paths.data, '--config', paths.configFile];
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function childMode(options) {
  const caseRoot = path.join(options.runtimeRoot, 'containment', options.caseName);
  prepareDirectory(caseRoot);
  const socketRoot = `/tmp/zo297-${process.pid}`;
  const tmuxSocket = `/tmp/za297-${process.pid}.sock`;
  const env = makeEnvironment(caseRoot, socketRoot);
  const paths = {
    caseRoot,
    configFile: options.configFile,
    data: path.join(caseRoot, 'data'),
    markerFile: path.join(caseRoot, 'ownership.marker'),
    layoutFile: path.join(caseRoot, `${options.sessionMode}-tmux-layout.kdl`),
    socketRoot,
    tmuxSocket,
    tokenFile: path.join(caseRoot, `${options.sessionMode}-token.txt`),
  };
  fs.writeFileSync(paths.markerFile, `${options.caseName}\n`, { mode: 0o600 });
  fs.chmodSync(paths.markerFile, 0o600);
  const marker = `fdpath:${paths.markerFile}`;
  const sessionName = `observer-${options.caseName}`.slice(0, 40);
  const port = await freePort();

  const tmuxStart = run(options.tmux, [
    '-S', paths.tmuxSocket,
    '-f', '/dev/null',
    'new-session', '-d', '-s', 'agent-sentinel', '-x', '80', '-y', '21',
  ]);
  assert.equal(tmuxStart.status, 0, tmuxStart.stderr);
  const tmuxLayoutArgs = ['-S', paths.tmuxSocket, 'attach-session'];
  if (options.sessionMode === 'read-only') tmuxLayoutArgs.push('-r');
  tmuxLayoutArgs.push('-t', 'agent-sentinel');
  const layout = `layout {\n  pane command=${JSON.stringify(options.tmux)} focus=true {\n    args ${tmuxLayoutArgs.map((argument) => JSON.stringify(argument)).join(' ')}\n  }\n}\n`;
  fs.writeFileSync(paths.layoutFile, layout, { mode: 0o600 });
  fs.chmodSync(paths.layoutFile, 0o600);

  const unrelatedRoot = path.join(caseRoot, 'unrelated-zellij');
  const unrelatedSocketRoot = `/tmp/zu297-${process.pid}`;
  const unrelatedEnv = makeEnvironment(unrelatedRoot, unrelatedSocketRoot);
  const unrelatedPaths = {
    data: path.join(unrelatedRoot, 'data'),
    configFile: options.configFile,
  };
  const unrelatedSessionName = `unrelated-${options.caseName}`.slice(0, 40);
  const unrelatedZellij = spawn('/usr/bin/expect', [
    options.ptySpawn,
    options.zellij,
    ...zellijBase(unrelatedPaths),
    '--session', unrelatedSessionName,
  ], { env: unrelatedEnv, stdio: 'ignore', detached: true });
  unrelatedZellij.unref();
  await waitFor(() => {
    const result = run(options.zellij, [...zellijBase(unrelatedPaths), 'list-sessions', '--short'], { env: unrelatedEnv });
    return result.stdout.includes(unrelatedSessionName);
  }, 'unrelated Zellij startup');
  const unrelatedChildPid = await waitFor(() => {
    const result = run('/usr/bin/pgrep', ['-P', String(unrelatedZellij.pid)]);
    const pid = Number(result.stdout.trim().split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }, 'unrelated Zellij client identity');
  const unrelatedTopology = [
    { ...identity(options.guardian, unrelatedZellij.pid), role: 'unrelated-pty-wrapper' },
    { ...identity(options.guardian, unrelatedChildPid), role: 'unrelated-zellij-client' },
  ];

  const client = spawn(options.ptyMarkedExec, [
    paths.markerFile,
    options.zellij,
    ...zellijBase(paths),
    '--new-session-with-layout', paths.layoutFile,
    '--session', sessionName,
  ], {
    env: options.wrapperLinger ? {
      ...env,
      ZYLOS_PTY_MARKER_TEST_LINGER_WRAPPER: '1',
      ...(options.wrapperMarkerMutant ? { ZYLOS_PTY_MARKER_TEST_CLOSE_WRAPPER: '1' } : {}),
    } : env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let clientOutput = '';
  let clientError = '';
  client.stdout.setEncoding('utf8');
  client.stderr.setEncoding('utf8');
  client.stdout.on('data', (chunk) => { clientOutput += chunk; });
  client.stderr.on('data', (chunk) => { clientError += chunk; });

  await waitFor(() => {
    const result = run(options.zellij, [...zellijBase(paths), 'list-sessions', '--short'], { env });
    if (result.stdout.includes(sessionName)) return true;
    if (client.exitCode !== null) throw new Error(clientError || clientOutput || `client exited ${client.exitCode}`);
    return false;
  }, 'Zellij session startup');

  assert.ok(options.sessionMode === 'read-only' || options.sessionMode === 'writable', `invalid session mode: ${options.sessionMode}`);

  const tokenFlag = options.sessionMode === 'read-only' ? '--create-read-only-token' : '--create-token';
  const token = run(options.zellij, [...zellijBase(paths), 'web', tokenFlag], { env });
  assert.equal(token.status, 0, token.stderr);
  fs.writeFileSync(paths.tokenFile, token.stdout, { mode: 0o600 });
  fs.chmodSync(paths.tokenFile, 0o600);

  const web = spawn(options.markedExec, [
    paths.markerFile,
    options.zellij,
    ...zellijBase(paths),
    'web', '--start', '--ip', '127.0.0.1', '--port', String(port),
  ], { env, stdio: 'ignore' });

  await waitFor(async () => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    return new Promise((resolve) => {
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
  }, 'Zellij web listener startup');

  let guardian;
  let guardianLiveness;
  const parentIdentity = identity(options.guardian, process.pid);
  const startGuardian = () => {
    guardian = spawn(options.guardian, [
      'watch', '3', String(process.pid),
      String(parentIdentity.startSec), String(parentIdentity.startUsec),
      marker, '9000',
    ], { stdio: ['ignore', 'inherit', 'inherit', 'pipe'] });
    guardianLiveness = guardian.stdio[3];
    return guardian;
  };

  if (!options.knownBad) {
    startGuardian();
    await delay(250);
    assert.equal(guardian.exitCode, null, 'guardian exited during startup');
  }

  const ownedBefore = census(options.guardian, marker);
  assert.ok(ownedBefore.count >= 2, `expected detached Zellij ownership set, got ${ownedBefore.count}`);

  if (options.restartGuardian) {
    const firstGuardianPid = guardian.pid;
    guardian.kill('SIGKILL');
    await once(guardian, 'exit');
    guardianLiveness.destroy();
    startGuardian();
    await delay(250);
    assert.equal(guardian.exitCode, null, 'replacement guardian exited during startup');
    emit({ event: 'guardian-restarted', firstGuardianPid, guardianPid: guardian.pid });
  }

  const guardianIdentity = guardian ? identity(options.guardian, guardian.pid) : null;
  const explicitTopology = uniqueTopology([
    { ...parentIdentity, role: 'harness-parent' },
    { ...identity(options.guardian, client.pid), role: 'pty-wrapper' },
    { ...identity(options.guardian, web.pid), role: 'web-launcher' },
    ...(guardianIdentity ? [{ ...guardianIdentity, role: 'guardian' }] : []),
    ...ownedBefore.records.filter((record) => record.event === 'owned').map((record) => ({ ...record, role: 'marker-owned' })),
  ]);

  emit({
    event: 'ready',
    caseName: options.caseName,
    parent: parentIdentity,
    guardianPid: guardian?.pid ?? null,
    marker,
    markerFile: paths.markerFile,
    port,
    privateRoots: {
      home: env.HOME,
      cache: path.join(env.HOME, 'Library', 'Caches', 'org.Zellij-Contributors.Zellij'),
      data: path.join(env.HOME, 'Library', 'Application Support', 'org.Zellij-Contributors.Zellij'),
      config: env.ZELLIJ_CONFIG_DIR,
      pluginData: paths.data,
      socket: env.ZELLIJ_SOCKET_DIR,
      tmp: env.TMPDIR,
    },
    sessionName,
    tmuxSocket: paths.tmuxSocket,
    tmuxTarget: 'agent-sentinel',
    sessionMode: options.sessionMode,
    tokenFile: paths.tokenFile,
    ownedBefore,
    processPids: { client: client.pid, webLauncher: web.pid },
    topology: explicitTopology,
    unrelatedZellij: {
      sessionName: unrelatedSessionName,
      socketRoot: unrelatedSocketRoot,
      root: unrelatedRoot,
      topology: unrelatedTopology,
    },
  });

  const graceful = async () => {
    if (guardianLiveness) guardianLiveness.end();
    if (guardian) await once(guardian, 'exit');
    emit({ event: 'graceful-complete', caseName: options.caseName });
    process.exit(0);
  };
  process.once('SIGTERM', () => { graceful().catch((error) => { throw error; }); });
  await new Promise(() => {});
}

function parseChildOutput(buffer) {
  return buffer.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function cleanupFailedCase(options, caseName, child, childIdentity, ready, watcher) {
  const cleanupEnv = { ...process.env };
  delete cleanupEnv.ZYLOS_GUARDIAN_TEST_FAIL_CENSUS;
  delete cleanupEnv.ZYLOS_GUARDIAN_TEST_FAIL_IDENTITY;
  delete cleanupEnv.ZYLOS_GUARDIAN_TEST_COLLAPSE_IDENTITY_ERROR;
  const cleanupErrors = [];
  try { watcher?.close(); } catch {}
  try { watcher?.control?.close(); } catch {}
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (sameIdentityAlive(options.guardian, childIdentity, undefined, cleanupEnv)) {
        child.kill('SIGKILL');
        await Promise.race([once(child, 'close'), delay(1000)]);
      }
    } catch (error) {
      emit({ event: 'failed-case-identity-error', pid: childIdentity.pid, message: error.message });
    }
  }
  const caseRoot = path.join(options.runtimeRoot, 'containment', caseName);
  const markerFile = path.join(caseRoot, 'ownership.marker');
  if (fs.existsSync(markerFile)) {
    const reconcile = run(options.guardian, [
      'reconcile', String(childIdentity.pid), String(childIdentity.startSec), String(childIdentity.startUsec),
      `fdpath:${markerFile}`, '5000',
    ], { env: cleanupEnv, timeout: 6000 });
    if (reconcile.status !== 0) {
      cleanupErrors.push(`exact reconcile exit ${reconcile.status}: ${reconcile.stderr || reconcile.stdout}`);
    }
  }
  for (const record of ready?.topology ?? []) {
    if (record.role === 'harness-parent' || record.role === 'guardian') continue;
    try {
      if (sameIdentityAlive(options.guardian, record, undefined, cleanupEnv)) process.kill(record.pid, 'SIGTERM');
    } catch (error) {
      emit({ event: 'failed-case-identity-error', pid: record.pid, message: error.message });
    }
  }
  const unrelatedRoot = ready?.unrelatedZellij.root ?? path.join(caseRoot, 'unrelated-zellij');
  const unrelatedSocketRoot = ready?.unrelatedZellij.socketRoot ?? `/tmp/zu297-${child.pid}`;
  const unrelatedSessionName = ready?.unrelatedZellij.sessionName ?? `unrelated-${caseName}`.slice(0, 40);
  const unrelatedEnv = makeEnvironment(unrelatedRoot, unrelatedSocketRoot);
  run(options.zellij, [
    ...zellijBase({ data: path.join(unrelatedRoot, 'data'), configFile: options.configFile }),
    'kill-session', unrelatedSessionName,
  ], { env: unrelatedEnv, timeout: 3000 });
  run(options.tmux, ['-S', ready?.tmuxSocket ?? `/tmp/za297-${child.pid}.sock`, 'kill-server'], { timeout: 3000 });
  if (cleanupErrors.length > 0) throw new Error(`failed-case cleanup incomplete: ${cleanupErrors.join('; ')}`);
}

function cleanupFailedChildMode(options) {
  const caseRoot = path.join(options.runtimeRoot, 'containment', options.caseName);
  const markerFile = path.join(caseRoot, 'ownership.marker');
  const cleanupEnv = { ...process.env };
  delete cleanupEnv.ZYLOS_GUARDIAN_TEST_FAIL_CENSUS;
  delete cleanupEnv.ZYLOS_GUARDIAN_TEST_FAIL_IDENTITY;
  delete cleanupEnv.ZYLOS_GUARDIAN_TEST_COLLAPSE_IDENTITY_ERROR;
  if (fs.existsSync(markerFile)) {
    try {
      const self = identity(options.guardian, process.pid, cleanupEnv);
      const absentStartSec = self.startUsec === 999999 ? self.startSec + 1 : self.startSec;
      const absentStartUsec = self.startUsec === 999999 ? 0 : self.startUsec + 1;
      run(options.guardian, [
        'reconcile', String(self.pid), String(absentStartSec), String(absentStartUsec),
        `fdpath:${markerFile}`, '5000',
      ], { env: cleanupEnv, timeout: 6000 });
    } catch {}
  }
  const unrelatedRoot = path.join(caseRoot, 'unrelated-zellij');
  const unrelatedEnv = makeEnvironment(unrelatedRoot, `/tmp/zu297-${process.pid}`);
  run(options.zellij, [
    ...zellijBase({ data: path.join(unrelatedRoot, 'data'), configFile: options.configFile }),
    'kill-session', `unrelated-${options.caseName}`.slice(0, 40),
  ], { env: unrelatedEnv, timeout: 3000 });
  run(options.tmux, ['-S', `/tmp/za297-${process.pid}.sock`, 'kill-server'], { timeout: 3000 });
}

async function runCase(options, definition) {
  const caseName = `${definition.name}-${process.pid}`;
  const child = spawn(process.execPath, [
    new URL(import.meta.url).pathname,
    '--child',
    '--case-name', caseName,
    ...(definition.knownBad ? ['--known-bad'] : []),
    ...(definition.restartGuardian ? ['--restart-guardian'] : []),
    ...(definition.wrapperMarkerMutant ? ['--wrapper-marker-mutant'] : []),
    ...(definition.wrapperLinger ? ['--wrapper-linger'] : []),
    '--runtime-root', options.runtimeRoot,
    '--zellij', options.zellij,
    '--guardian', options.guardian,
    '--marked-exec', options.markedExec,
    '--config-file', options.configFile,
    '--pty-marked-exec', options.ptyMarkedExec,
    '--tmux', options.tmux,
    '--pty-spawn', options.ptySpawn,
    '--session-mode', 'read-only',
  ], { stdio: ['inherit', 'pipe', 'inherit'] });
  child.stdout.setEncoding('utf8');
  let output = '';
  let ready;
  let watcher;
  let succeeded = false;
  const childIdentity = identity(options.guardian, child.pid);
  child.stdout.on('data', (chunk) => { output += chunk; });
  try {
  ready = await waitFor(() => {
    const records = parseChildOutput(output);
    return records.find((record) => record.event === 'ready');
  }, `${definition.name} readiness`, 20000);

  const watcherLogin = await fetch(`http://127.0.0.1:${ready.port}/command/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_token: fs.readFileSync(ready.tokenFile, 'utf8').match(/^token_[0-9]+:\s*([0-9a-f-]{36})(?:\s|$)/m)?.[1], remember_me: false }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(watcherLogin.status, 200, `active watcher login failed (${watcherLogin.status})`);
  const watcherCookie = watcherLogin.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(watcherCookie?.startsWith('session_token='), 'active watcher login returned no cookie');
  const watcherSessionResponse = await fetch(`http://127.0.0.1:${ready.port}/session?session=${encodeURIComponent(ready.sessionName)}&welcome=false`, {
    method: 'POST', headers: { Cookie: watcherCookie, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(watcherSessionResponse.status, 200, `active watcher bootstrap failed (${watcherSessionResponse.status})`);
  const watcherBoot = await watcherSessionResponse.json();
  assert.equal(watcherBoot.is_read_only, true, 'containment watcher is not read-only');
  const watcherControl = new WsClient({
    port: ready.port,
    path: `/ws/control?web_client_id=${encodeURIComponent(watcherBoot.web_client_id)}`,
    cookie: watcherCookie,
  });
  watcher = new WsClient({
    port: ready.port,
    path: `/ws/terminal/${encodeURIComponent(ready.sessionName)}?web_client_id=${encodeURIComponent(watcherBoot.web_client_id)}&rows=21&cols=80`,
    cookie: watcherCookie,
  });
  watcher.control = watcherControl;
  let watcherBytes = 0;
  let watcherPayload = Buffer.alloc(0);
  watcher.on('message', (message) => {
    const payload = Buffer.isBuffer(message) ? message : Buffer.from(message);
    watcherBytes += payload.length;
    watcherPayload = Buffer.concat([watcherPayload, payload]);
    if (watcherPayload.length > 256 * 1024) watcherPayload = watcherPayload.subarray(watcherPayload.length - 256 * 1024);
  });
  await watcherControl.connect();
  await watcher.connect();
  await waitFor(() => watcherBytes > 0, `${definition.name} active watcher initial data`, 5000);
  const watcherMarker = `__ACTIVE_WATCHER_${caseName}__`;
  const markerCommand = run(options.tmux, [
    '-S', ready.tmuxSocket, 'send-keys', '-t', ready.tmuxTarget, '-l', `printf '${watcherMarker}\\n'`,
  ]);
  assert.equal(markerCommand.status, 0, markerCommand.stderr);
  const markerEnter = run(options.tmux, ['-S', ready.tmuxSocket, 'send-keys', '-t', ready.tmuxTarget, 'Enter']);
  assert.equal(markerEnter.status, 0, markerEnter.stderr);
  try {
    await waitFor(() => watcherPayload.includes(Buffer.from(watcherMarker)), `${definition.name} active watcher rendered marker`, 5000);
  } catch (error) {
    const pane = run(options.tmux, ['-S', ready.tmuxSocket, 'capture-pane', '-p', '-J', '-t', ready.tmuxTarget]);
    throw new Error(`${error.message}; pane=${JSON.stringify(pane.stdout)}; watcherTail=${JSON.stringify(watcherPayload.subarray(-4096).toString('utf8'))}`);
  }
  const watcherClosed = Promise.all([once(watcher, 'close'), once(watcherControl, 'close')]);

  const started = performance.now();
  const deadline = started + 10000;
  child.kill(definition.graceful ? 'SIGTERM' : 'SIGKILL');
  await withinDeadline(once(child, 'close'), deadline, `${definition.name} child close`);

  if (definition.graceful) {
    await withinDeadline(waitFor(() => parseChildOutput(output).some((record) => record.event === 'graceful-complete'), 'graceful completion'), deadline, `${definition.name} graceful completion`);
  }

  let cleanupEvents = parseChildOutput(output);
  let after = census(options.guardian, ready.marker, deadline);
  if (definition.knownBad) {
    assert.ok(after.count > 0, 'known-bad control did not leave a detectable detached process');
    const cleanup = run(options.guardian, [
      'reconcile', String(ready.parent.pid),
      String(ready.parent.startSec), String(ready.parent.startUsec),
      ready.marker, '9000',
    ], { deadline });
    assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.stdout);
    cleanupEvents = cleanupEvents.concat(parseChildOutput(cleanup.stdout));
    after = census(options.guardian, ready.marker, deadline);
  } else {
    await withinDeadline(waitFor(() => {
      after = census(options.guardian, ready.marker, deadline);
      return after.count === 0;
    }, `${definition.name} owned-process cleanup`, 10000), deadline, `${definition.name} owned-process cleanup`);
  }

  assert.equal(after.count, 0, JSON.stringify(after));
  await withinDeadline(watcherClosed, deadline, `${definition.name} active watcher close`);
  const aliveTopologyAfterCleanup = await withinDeadline(waitFor(
    () => aliveTopology(options.guardian, ready.topology, deadline),
    `${definition.name} whole-topology identity queries`,
    10000,
  ), deadline, `${definition.name} whole-topology identity queries`);
  if (definition.wrapperMarkerMutant) {
    assert.deepEqual(aliveTopologyAfterCleanup.map((record) => record.role), ['pty-wrapper'], `wrapper-retention mutant did not expose the exact topology hole: ${JSON.stringify(aliveTopologyAfterCleanup)}`);
    process.kill(aliveTopologyAfterCleanup[0].pid, 'SIGKILL');
    await withinDeadline(waitFor(() => !sameIdentityAlive(options.guardian, aliveTopologyAfterCleanup[0], deadline),
      'exact markerless wrapper cleanup'), deadline, 'exact markerless wrapper cleanup');
  } else {
    assert.deepEqual(aliveTopologyAfterCleanup, [], `whole owned topology survived cleanup: ${JSON.stringify(aliveTopologyAfterCleanup)}`);
  }
  const tmuxAlive = run(options.tmux, ['-S', ready.tmuxSocket, 'has-session', '-t', 'agent-sentinel'], { deadline });
  assert.equal(tmuxAlive.status, 0, 'sentinel Agent tmux did not survive Observer cleanup');
  const listenerClosed = await withinDeadline(new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: ready.port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
    socket.setTimeout(Math.max(1, deadline - performance.now()), () => {
      socket.destroy();
      reject(new Error('Observer listener close check timed out'));
    });
  }), deadline, `${definition.name} listener close`);
  assert.equal(listenerClosed, true, 'Observer listener survived cleanup');
  const unrelatedEnv = makeEnvironment(ready.unrelatedZellij.root, ready.unrelatedZellij.socketRoot);
  const unrelatedPaths = { data: path.join(ready.unrelatedZellij.root, 'data'), configFile: options.configFile };
  const unrelatedAlive = run(options.zellij, [...zellijBase(unrelatedPaths), 'list-sessions', '--short'], { env: unrelatedEnv, deadline });
  assert.ok(unrelatedAlive.stdout.split('\n').includes(ready.unrelatedZellij.sessionName),
    `unrelated Zellij did not survive Observer cleanup: ${JSON.stringify({ stdout: unrelatedAlive.stdout, stderr: unrelatedAlive.stderr, cleanupEvents })}`);
  const unrelatedTopologySurvived = await withinDeadline(waitFor(
    () => ready.unrelatedZellij.topology.every((record) => sameIdentityAlive(options.guardian, record, deadline)),
    `${definition.name} unrelated Zellij identity queries`,
    10000,
  ), deadline, `${definition.name} unrelated Zellij identity queries`);
  assert.equal(unrelatedTopologySurvived, true,
    `unrelated Zellij exact identities changed: ${JSON.stringify(ready.unrelatedZellij.topology)}`);
  const elapsedMs = Math.round(performance.now() - started);
  assert.ok(elapsedMs < 10000, `${definition.name} cleanup exceeded hard 10s bound: ${elapsedMs}ms`);
  const unrelatedStop = run(options.zellij, [...zellijBase(unrelatedPaths), 'kill-session', ready.unrelatedZellij.sessionName], { env: unrelatedEnv });
  assert.equal(unrelatedStop.status, 0, unrelatedStop.stderr);
  const tmuxStop = run(options.tmux, ['-S', ready.tmuxSocket, 'kill-server']);
  assert.equal(tmuxStop.status, 0, tmuxStop.stderr);

  const report = {
    name: definition.name,
    result: 'pass',
    elapsedMs,
    knownBadDetected: definition.knownBad,
    listenerClosed,
    sentinelTmuxSurvived: true,
    unrelatedZellijSurvived: true,
    unrelatedZellijTopology: ready.unrelatedZellij.topology,
    activeWatcherReceivedBytes: watcherBytes,
    activeWatcherMarker: watcherMarker,
    activeWatcherRenderedMarker: true,
    activeWatcherClosed: true,
    activeWatcherControlClosed: true,
    wholeTopology: ready.topology,
    wrapperMarkerRetentionMutantDetected: Boolean(definition.wrapperMarkerMutant),
    ownedBefore: ready.ownedBefore,
    cleanupEvents,
    privateRoots: ready.privateRoots,
    tokenFile: ready.tokenFile,
    port: ready.port,
    sessionName: ready.sessionName,
  };
  succeeded = true;
  return report;
  } finally {
    if (!succeeded) await cleanupFailedCase(options, caseName, child, childIdentity, ready, watcher);
  }
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--child') options.child = true;
    else if (argument === '--identity-oracle') options.identityOracle = true;
    else if (argument === '--known-bad') options.knownBad = true;
    else if (argument === '--restart-guardian') options.restartGuardian = true;
    else if (argument === '--wrapper-marker-mutant') options.wrapperMarkerMutant = true;
    else if (argument === '--wrapper-linger') options.wrapperLinger = true;
    else if (argument.startsWith('--')) options[argument.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++index];
  }
  return options;
}

const options = parseOptions(process.argv.slice(2));
if (options.identityOracle) {
  for (const key of ['guardian', 'pid', 'startSec', 'startUsec']) {
    if (!options[key]) throw new Error(`missing --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  const expected = {
    pid: Number(options.pid),
    startSec: Number(options.startSec),
    startUsec: Number(options.startUsec),
  };
  const deadline = performance.now() + Number(options.deadlineMs ?? 2000);
  emit({ event: 'identity-oracle', pid: expected.pid, state: sameIdentityState(options.guardian, expected, deadline) });
} else if (options.child) {
  try {
    await childMode(options);
  } catch (error) {
    cleanupFailedChildMode(options);
    throw error;
  }
} else {
  for (const key of ['runtimeRoot', 'zellij', 'guardian', 'markedExec', 'configFile', 'ptyMarkedExec', 'tmux', 'ptySpawn']) {
    if (!options[key]) throw new Error(`missing --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  const cases = [
    { name: 'abrupt', graceful: false },
    { name: 'graceful', graceful: true },
    { name: 'guardian-restart', graceful: false, restartGuardian: true },
    { name: 'known-bad', graceful: false, knownBad: true },
    { name: 'wrapper-marker-retained', graceful: false, wrapperLinger: true },
    { name: 'wrapper-marker-mutant', graceful: false, wrapperLinger: true, wrapperMarkerMutant: true },
  ];
  const selectedCases = options.case ? cases.filter((definition) => definition.name === options.case) : cases;
  assert.ok(selectedCases.length > 0, `unknown containment case: ${options.case}`);
  const results = [];
  for (const definition of selectedCases) {
    results.push(await runCase(options, definition));
  }
  const report = { result: 'pass', platform: `${process.platform}-${process.arch}`, cases: results };
  if (options.evidenceFile) {
    fs.writeFileSync(options.evidenceFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  emit(report);
}
