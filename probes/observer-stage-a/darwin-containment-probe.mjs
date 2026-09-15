import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function identity(guardian, pid) {
  const result = run(guardian, ['identity', String(pid)]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function census(guardian, marker) {
  const result = run(guardian, ['census', marker]);
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
    layoutFile: path.join(caseRoot, 'read-only-tmux-layout.kdl'),
    socketRoot,
    tmuxSocket,
    tokenFile: path.join(caseRoot, 'read-only-token.txt'),
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

  const client = spawn(options.ptyMarkedExec, [
    paths.markerFile,
    options.zellij,
    ...zellijBase(paths),
    '--session', sessionName,
  ], {
    env,
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

  const readOnlyPane = run(options.zellij, [
    ...zellijBase(paths),
    '--session', sessionName,
    'run', '--',
    options.tmux, '-S', paths.tmuxSocket, 'attach-session', '-r', '-t', 'agent-sentinel',
  ], { env });
  assert.equal(readOnlyPane.status, 0, readOnlyPane.stderr);

  const token = run(options.zellij, [...zellijBase(paths), 'web', '--create-read-only-token'], { env });
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
    tokenFile: paths.tokenFile,
    ownedBefore,
    processPids: { client: client.pid, webLauncher: web.pid },
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

async function runCase(options, definition) {
  const caseName = `${definition.name}-${process.pid}`;
  const child = spawn(process.execPath, [
    new URL(import.meta.url).pathname,
    '--child',
    '--case-name', caseName,
    ...(definition.knownBad ? ['--known-bad'] : []),
    ...(definition.restartGuardian ? ['--restart-guardian'] : []),
    '--runtime-root', options.runtimeRoot,
    '--zellij', options.zellij,
    '--guardian', options.guardian,
    '--marked-exec', options.markedExec,
    '--config-file', options.configFile,
    '--pty-marked-exec', options.ptyMarkedExec,
    '--tmux', options.tmux,
  ], { stdio: ['inherit', 'pipe', 'inherit'] });
  child.stdout.setEncoding('utf8');
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const ready = await waitFor(() => {
    const records = parseChildOutput(output);
    return records.find((record) => record.event === 'ready');
  }, `${definition.name} readiness`, 20000);

  const started = performance.now();
  child.kill(definition.graceful ? 'SIGTERM' : 'SIGKILL');
  await once(child, 'close');

  if (definition.graceful) {
    await waitFor(() => parseChildOutput(output).some((record) => record.event === 'graceful-complete'), 'graceful completion');
  }

  let cleanupEvents = parseChildOutput(output);
  let after = census(options.guardian, ready.marker);
  if (definition.knownBad) {
    assert.ok(after.count > 0, 'known-bad control did not leave a detectable detached process');
    const cleanup = run(options.guardian, [
      'reconcile', String(ready.parent.pid),
      String(ready.parent.startSec), String(ready.parent.startUsec),
      ready.marker, '9000',
    ]);
    assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.stdout);
    cleanupEvents = cleanupEvents.concat(parseChildOutput(cleanup.stdout));
    after = census(options.guardian, ready.marker);
  } else {
    await waitFor(() => {
      after = census(options.guardian, ready.marker);
      return after.count === 0;
    }, `${definition.name} owned-process cleanup`, 10000);
  }

  const elapsedMs = Math.round(performance.now() - started);
  assert.equal(after.count, 0, JSON.stringify(after));
  const tmuxAlive = run(options.tmux, ['-S', ready.tmuxSocket, 'has-session', '-t', 'agent-sentinel']);
  assert.equal(tmuxAlive.status, 0, 'sentinel Agent tmux did not survive Observer cleanup');
  const listenerClosed = await new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: ready.port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
  });
  assert.equal(listenerClosed, true, 'Observer listener survived cleanup');
  const tmuxStop = run(options.tmux, ['-S', ready.tmuxSocket, 'kill-server']);
  assert.equal(tmuxStop.status, 0, tmuxStop.stderr);

  return {
    name: definition.name,
    result: 'pass',
    elapsedMs,
    knownBadDetected: definition.knownBad,
    listenerClosed,
    sentinelTmuxSurvived: true,
    ownedBefore: ready.ownedBefore,
    cleanupEvents,
    privateRoots: ready.privateRoots,
    tokenFile: ready.tokenFile,
    port: ready.port,
    sessionName: ready.sessionName,
  };
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--child') options.child = true;
    else if (argument === '--known-bad') options.knownBad = true;
    else if (argument === '--restart-guardian') options.restartGuardian = true;
    else if (argument.startsWith('--')) options[argument.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++index];
  }
  return options;
}

const options = parseOptions(process.argv.slice(2));
if (options.child) {
  await childMode(options);
} else {
  for (const key of ['runtimeRoot', 'zellij', 'guardian', 'markedExec', 'configFile', 'ptyMarkedExec', 'tmux']) {
    if (!options[key]) throw new Error(`missing --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  const cases = [
    { name: 'abrupt', graceful: false },
    { name: 'graceful', graceful: true },
    { name: 'guardian-restart', graceful: false, restartGuardian: true },
    { name: 'known-bad', graceful: false, knownBad: true },
  ];
  const results = [];
  for (const definition of cases) {
    results.push(await runCase(options, definition));
  }
  const report = { result: 'pass', platform: `${process.platform}-${process.arch}`, cases: results };
  if (options.evidenceFile) {
    fs.writeFileSync(options.evidenceFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  emit(report);
}
