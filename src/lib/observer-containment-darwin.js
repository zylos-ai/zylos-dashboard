import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const OWNERSHIP_QUIET_MS = 1_000;
const OWNERSHIP_POLL_MS = 100;
const MAX_OUTPUT = 128 * 1024;

export class ObserverContainmentError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ObserverContainmentError';
    this.code = code;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function privateDirectory(directory) {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ObserverContainmentError('unsafe_runtime_root', `Unsafe Observer runtime directory: ${directory}`);
  }
  await fs.promises.chmod(directory, 0o700);
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  await fs.promises.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await fs.promises.rename(temporaryPath, filePath);
  await fs.promises.chmod(filePath, 0o600);
}

function cleanGuardianEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (key.startsWith('ZYLOS_GUARDIAN_TEST_') || key.startsWith('ZYLOS_PTY_MARKER_TEST_')) delete result[key];
  }
  return result;
}

async function validatePersistedSocketRoot(state) {
  const { socketRoot, socketOwnerFile, parent, nonce, marker, root } = state;
  const expectedOwnerFile = path.join(socketRoot || '', '.observer-owner.json');
  if (typeof socketRoot !== 'string' || path.dirname(socketRoot) !== '/tmp' ||
      path.resolve(socketRoot) !== socketRoot ||
      !new RegExp(`^zobs-${parent?.pid}-[0-9a-f]{10}$`).test(path.basename(socketRoot)) ||
      socketOwnerFile !== expectedOwnerFile) {
    throw new Error('socket root does not match the exact managed /tmp contract');
  }
  const [rootStat, ownerStat] = await Promise.all([
    fs.promises.lstat(socketRoot),
    fs.promises.lstat(expectedOwnerFile),
  ]);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && rootStat.uid !== process.getuid()) ||
      !ownerStat.isFile() || ownerStat.isSymbolicLink() || (ownerStat.mode & 0o077) !== 0) {
    throw new Error('socket root is not an owned private directory');
  }
  const owner = JSON.parse(await fs.promises.readFile(expectedOwnerFile, 'utf8'));
  if (owner.nonce !== nonce || owner.marker !== marker || owner.root !== root || owner.socketRoot !== socketRoot) {
    throw new Error('socket root ownership record does not match the generation');
  }
}

async function waitFor(check, label, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new ObserverContainmentError('startup_timeout', `${label} did not become ready`, lastError);
}

async function findFreePort() {
  const server = net.createServer();
  server.unref();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function listenerOpen(port, timeoutMs = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(Math.max(1, timeoutMs), () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function remainingMs(deadline) {
  return Math.max(0, Math.floor(deadline - performance.now()));
}

function captureChild(child) {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { if (stdout.length < MAX_OUTPUT) stdout += chunk; });
  child.stderr?.on('data', (chunk) => { if (stderr.length < MAX_OUTPUT) stderr += chunk; });
  return { stdout: () => stdout, stderr: () => stderr };
}

function waitForCleanExit(child, timeoutMs) {
  const observed = childProcessState.get(child);
  if (observed?.error) return Promise.reject(observed.error);
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error(`guardian exit ${child.exitCode ?? child.signalCode}`));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('guardian cleanup timeout'));
    }, timeoutMs);
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(`guardian exit ${code ?? signal}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

const childProcessState = new WeakMap();

export class DarwinObserverContainment extends EventEmitter {
  constructor({
    dataDir,
    helperDir = path.resolve(new URL('../../assets/observer/darwin-arm64', import.meta.url).pathname),
    zellijConfig = path.resolve(new URL('../../assets/observer/zellij-config.kdl', import.meta.url).pathname),
    tmuxPath = 'tmux',
    tmuxSocket = null,
    exec = execFileAsync,
    spawnImpl = spawn,
    platform = process.platform,
    arch = process.arch,
    guardianOutput = 'managed-file',
    cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
    ownershipQuietMs = OWNERSHIP_QUIET_MS,
    ownershipPollMs = OWNERSHIP_POLL_MS,
  }) {
    super();
    this.runtimeRoot = path.join(dataDir, 'observer', 'runtime', 'generations');
    this.helperDir = helperDir;
    this.zellijConfig = zellijConfig;
    this.tmuxPath = tmuxPath;
    this.tmuxSocket = tmuxSocket;
    this.exec = exec;
    this.spawn = spawnImpl;
    this.platform = platform;
    this.arch = arch;
    this.guardianOutput = guardianOutput;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    this.ownershipQuietMs = ownershipQuietMs;
    this.ownershipPollMs = ownershipPollMs;
    this.active = null;
    this._stopping = null;
  }

  get helperPaths() {
    return {
      guardian: path.join(this.helperDir, 'darwin-guardian'),
      markedExec: path.join(this.helperDir, 'marked-exec'),
      ptyMarkedExec: path.join(this.helperDir, 'pty-marked-exec'),
    };
  }

  async verifyHelperManifest() {
    const manifestPath = path.join(this.helperDir, 'manifest.json');
    const manifestStat = await fs.promises.lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw new ObserverContainmentError('invalid_helper_manifest', 'Observer helper manifest is unsafe');
    }
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    if (manifest.schema !== 1 || manifest.platform !== 'darwin-arm64') {
      throw new ObserverContainmentError('invalid_helper_manifest', 'Observer helper manifest does not match this platform');
    }
    for (const [name, filePath] of Object.entries({
      'darwin-guardian': this.helperPaths.guardian,
      'marked-exec': this.helperPaths.markedExec,
      'pty-marked-exec': this.helperPaths.ptyMarkedExec,
    })) {
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
        throw new ObserverContainmentError('invalid_helper', `Observer helper is not an executable regular file: ${name}`);
      }
      if (await sha256File(filePath) !== manifest.binaries?.[name]?.sha256) {
        throw new ObserverContainmentError('invalid_helper', `Observer helper digest mismatch: ${name}`);
      }
    }
    return this.helperPaths;
  }

  async verifyHelpers() {
    if (this.platform !== 'darwin' || this.arch !== 'arm64') {
      throw new ObserverContainmentError('unsupported_platform', `Unsupported containment platform: ${this.platform}-${this.arch}`);
    }
    return this.verifyHelperManifest();
  }

  async _run(file, args, options = {}) {
    return this.exec(file, args, {
      encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, ...options,
    });
  }

  async _identity(pid) {
    const result = await this._run(this.helperPaths.guardian, ['identity', String(pid)], {
      env: cleanGuardianEnvironment(),
    });
    return JSON.parse(result.stdout.trim());
  }

  _tmuxArgs(...args) {
    return [...(this.tmuxSocket ? ['-S', this.tmuxSocket] : []), ...args];
  }

  async _privateEnvironment(root, socketRoot) {
    const home = path.join(root, 'home');
    const config = path.join(root, 'config');
    const data = path.join(root, 'data');
    const temporary = path.join(root, 'tmp');
    for (const directory of [root, home, config, data, temporary, socketRoot]) await privateDirectory(directory);
    for (const directory of [
      path.join(home, 'Library'),
      path.join(home, 'Library', 'Application Support'),
      path.join(home, 'Library', 'Application Support', 'org.Zellij-Contributors.Zellij'),
      path.join(home, 'Library', 'Caches'),
      path.join(home, 'Library', 'Caches', 'org.Zellij-Contributors.Zellij'),
    ]) await privateDirectory(directory);
    return {
      ...cleanGuardianEnvironment(),
      HOME: home,
      TMPDIR: `${temporary}/`,
      ZELLIJ_SOCKET_DIR: socketRoot,
      ZELLIJ_CONFIG_DIR: config,
      TERM: 'xterm-256color',
    };
  }

  _monitorChild(active, role, child) {
    const state = { error: null, reported: false };
    childProcessState.set(child, state);
    const report = (error) => {
      if (state.reported) return;
      state.reported = true;
      state.error = error;
      if (this.active === active && !active.stopping) this.emit('failure', error);
    };
    child.on('error', (error) => {
      report(new ObserverContainmentError(
        'child_error', `Observer ${role} process failed: ${error.message}`, error,
      ));
    });
    child.once('exit', (code, signal) => {
      report(new ObserverContainmentError(
        'child_exit', `Observer ${role} exited unexpectedly: ${code ?? signal}`,
      ));
    });
    return child;
  }

  _waitForCleanExit(child, timeoutMs) {
    return waitForCleanExit(child, timeoutMs);
  }

  async startGeneration({ generation, binaryPath, runtime }) {
    if (this.active) {
      if (this.active.generation === generation) return this.active;
      throw new ObserverContainmentError('generation_active', 'Another Observer generation is still active');
    }
    await this.verifyHelpers();
    const target = runtime === 'codex' ? 'codex-main' : runtime === 'claude' ? 'claude-main' : null;
    if (!target) throw new ObserverContainmentError('unsupported_runtime', `Unsupported Observer runtime: ${runtime}`);
    await this._run(this.tmuxPath, this._tmuxArgs('has-session', '-t', target));

    const nonce = `${generation}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const root = path.join(this.runtimeRoot, nonce);
    // Zellij derives several socket names below this root. Darwin's short Unix
    // socket limit requires the accepted, fixed /tmp strategy from Stage A.
    const socketRoot = path.join('/tmp', `zobs-${process.pid}-${crypto.randomBytes(5).toString('hex')}`);
    const env = await this._privateEnvironment(root, socketRoot);
    const markerFile = path.join(root, 'ownership.marker');
    const stateFile = path.join(root, 'state.json');
    const layoutFile = path.join(root, 'readonly-tmux.kdl');
    const tokenFile = path.join(root, 'read-only-token');
    const guardianLog = path.join(root, 'guardian.log');
    const socketOwnerFile = path.join(socketRoot, '.observer-owner.json');
    const marker = `fdpath:${markerFile}`;
    const sessionName = `observer-${nonce}`.slice(0, 40);
    const port = await findFreePort();
    await fs.promises.writeFile(markerFile, `${nonce}\n`, { flag: 'wx', mode: 0o600 });
    await fs.promises.writeFile(socketOwnerFile, `${JSON.stringify({ nonce, marker, root, socketRoot })}\n`, {
      flag: 'wx', mode: 0o600,
    });
    const tmuxArgs = this._tmuxArgs('attach-session', '-r', '-t', target);
    const layout = `layout {\n  pane command=${JSON.stringify(this.tmuxPath)} focus=true {\n    args ${tmuxArgs.map((value) => JSON.stringify(value)).join(' ')}\n  }\n}\n`;
    await fs.promises.writeFile(layoutFile, layout, { flag: 'wx', mode: 0o600 });
    const parent = await this._identity(process.pid);
    const persisted = {
      schema: 1, generation, nonce, parent, marker, markerFile, root, socketRoot, socketOwnerFile,
      sessionName, port, target, state: 'starting',
    };
    await writeJsonAtomic(stateFile, persisted);

    const guardianLogFd = this.guardianOutput === 'managed-file' ? fs.openSync(guardianLog, 'a', 0o600) : null;
    let guardian;
    try {
      guardian = this.spawn(this.helperPaths.guardian, [
        'watch', '3', String(process.pid), String(parent.startSec), String(parent.startUsec), marker, '9000',
      ], {
        env: cleanGuardianEnvironment(),
        stdio: this.guardianOutput === 'managed-file'
          ? ['ignore', guardianLogFd, guardianLogFd, 'pipe']
          : ['ignore', 'pipe', 'pipe', 'pipe'],
      });
    } finally {
      if (guardianLogFd !== null) fs.closeSync(guardianLogFd);
    }
    const active = {
      ...persisted, stateFile, tokenFile, env, guardian, guardianLiveness: guardian.stdio[3],
      client: null, web: null, stopping: false,
    };
    this.active = active;
    this._monitorChild(active, 'guardian', guardian);
    try {
      await delay(250);
      if (guardian.exitCode !== null || guardian.signalCode !== null) {
        throw new Error(`guardian exited during startup: ${guardian.exitCode ?? guardian.signalCode}`);
      }
      active.client = this.spawn(this.helperPaths.ptyMarkedExec, [
        markerFile, binaryPath, '--data-dir', path.join(root, 'data'), '--config', this.zellijConfig,
        '--new-session-with-layout', layoutFile, '--session', sessionName,
      ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      this._monitorChild(active, 'client', active.client);
      const clientOutput = captureChild(active.client);
      await waitFor(async () => {
        if (active.client.exitCode !== null) {
          throw new Error(clientOutput.stderr() || clientOutput.stdout() || `client exited ${active.client.exitCode}`);
        }
        const result = await this._run(binaryPath, [
          '--data-dir', path.join(root, 'data'), '--config', this.zellijConfig,
          'list-sessions', '--short',
        ], { env });
        return result.stdout.split('\n').includes(sessionName);
      }, 'Observer Zellij session');

      const token = await this._run(binaryPath, [
        '--data-dir', path.join(root, 'data'), '--config', this.zellijConfig,
        'web', '--create-read-only-token',
      ], { env });
      await fs.promises.writeFile(tokenFile, token.stdout, { flag: 'wx', mode: 0o600 });
      active.web = this.spawn(this.helperPaths.markedExec, [
        markerFile, binaryPath, '--data-dir', path.join(root, 'data'), '--config', this.zellijConfig,
        'web', '--start', '--ip', '127.0.0.1', '--port', String(port),
      ], { env, stdio: 'ignore' });
      this._monitorChild(active, 'web', active.web);
      await waitFor(() => listenerOpen(port), 'Observer loopback listener');
      persisted.state = 'active';
      persisted.guardianPid = guardian.pid;
      persisted.clientPid = active.client.pid;
      persisted.webPid = active.web.pid;
      await writeJsonAtomic(stateFile, persisted);
      active.state = 'active';
      return active;
    } catch (error) {
      try { await this.stopGeneration({ reason: 'startup_failure' }); } catch {}
      throw error instanceof ObserverContainmentError
        ? error
        : new ObserverContainmentError('startup_failed', `Observer generation failed to start: ${error.message}`, error);
    }
  }

  async _census(marker, deadline = null) {
    const timeout = deadline === null ? COMMAND_TIMEOUT_MS : remainingMs(deadline);
    if (timeout <= 0) throw new ObserverContainmentError('cleanup_timeout', 'Observer cleanup deadline expired');
    try {
      const result = await this._run(this.helperPaths.guardian, ['census', marker], {
        env: cleanGuardianEnvironment(),
        timeout: Math.min(COMMAND_TIMEOUT_MS, timeout),
      });
      return { count: 0, output: result.stdout };
    } catch (error) {
      if (error?.code === 2) {
        const output = error.stdout || '';
        const count = Number(output.trim().split('\n').map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).find((event) => event?.event === 'count')?.count);
        return { count, output };
      }
      if (deadline !== null && remainingMs(deadline) <= 0) {
        throw new ObserverContainmentError('cleanup_timeout', 'Observer cleanup deadline expired', error);
      }
      throw new ObserverContainmentError('census_failed', 'Observer ownership census failed closed', error);
    }
  }

  async _fallbackCleanup(active, deadline = performance.now() + this.cleanupTimeoutMs) {
    const timeout = remainingMs(deadline);
    if (timeout <= 0) throw new ObserverContainmentError('cleanup_timeout', 'Observer cleanup deadline expired');
    const guardian = this.spawn(this.helperPaths.guardian, [
      'watch', '3', String(process.pid), String(active.parent.startSec), String(active.parent.startUsec),
      active.marker, String(timeout),
    ], { env: cleanGuardianEnvironment(), stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    this._monitorChild(active, 'fallback guardian', guardian);
    guardian.stdio[3].end();
    try {
      await this._waitForCleanExit(guardian, Math.max(1, remainingMs(deadline)));
    } catch (error) {
      if (remainingMs(deadline) <= 0) {
        throw new ObserverContainmentError('cleanup_timeout', 'Observer cleanup deadline expired', error);
      }
      throw error;
    }
  }

  async _confirmStableEmpty(active, deadline = performance.now() + this.cleanupTimeoutMs) {
    let emptySince = null;
    let lastCount = 0;
    let lastCensusError = null;
    while (performance.now() < deadline) {
      let census;
      try {
        census = await this._census(active.marker, deadline);
        lastCensusError = null;
      } catch (error) {
        if (error?.code !== 'census_failed') throw error;
        lastCensusError = error;
        emptySince = null;
        const retryPause = Math.min(this.ownershipPollMs, remainingMs(deadline));
        if (retryPause > 0) await delay(retryPause);
        continue;
      }
      lastCount = census.count;
      if (census.count === 0) {
        emptySince ??= performance.now();
        if (performance.now() - emptySince >= this.ownershipQuietMs) return;
      } else {
        emptySince = null;
        await this._fallbackCleanup(active, deadline);
      }
      const pause = Math.min(this.ownershipPollMs, remainingMs(deadline));
      if (pause > 0) await delay(pause);
    }
    if (lastCensusError) {
      throw new ObserverContainmentError(
        'census_failed',
        'Observer ownership census did not recover before the cleanup deadline',
        lastCensusError,
      );
    }
    throw new ObserverContainmentError(
      'cleanup_timeout',
      `Observer cleanup deadline expired before a stable empty ownership census (last count: ${lastCount})`,
    );
  }

  stopGeneration(options = {}) {
    if (this._stopping) return this._stopping;
    this._stopping = this._stopGeneration(options).finally(() => { this._stopping = null; });
    return this._stopping;
  }

  async _stopGeneration({ reason = 'stop' } = {}) {
    const active = this.active;
    if (!active) return { stopped: true, reason, count: 0 };
    active.stopping = true;
    const startedAt = performance.now();
    const deadline = startedAt + this.cleanupTimeoutMs;
    try { active.guardianLiveness?.end(); } catch {}
    if (active.guardian) {
      try { await this._waitForCleanExit(active.guardian, Math.max(1, remainingMs(deadline))); }
      catch { await this._fallbackCleanup(active, deadline); }
    } else {
      await this._fallbackCleanup(active, deadline);
    }
    await this._confirmStableEmpty(active, deadline);
    const listenerBudget = remainingMs(deadline);
    if (listenerBudget <= 0) throw new ObserverContainmentError('cleanup_timeout', 'Observer cleanup deadline expired');
    if (await listenerOpen(active.port, listenerBudget)) {
      throw new ObserverContainmentError('listener_survived', 'Observer loopback listener survived cleanup');
    }
    await validatePersistedSocketRoot(active);
    await fs.promises.rm(active.socketRoot, { recursive: true, force: true });
    await fs.promises.rm(active.root, { recursive: true, force: true });
    this.active = null;
    return { stopped: true, reason, count: 0, elapsedMs: Math.round(performance.now() - startedAt) };
  }

  async reconcilePersisted() {
    let entries;
    try {
      entries = await fs.promises.readdir(this.runtimeRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    await this.verifyHelpers();
    const results = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const root = path.join(this.runtimeRoot, entry.name);
      let state;
      try {
        const deadline = performance.now() + this.cleanupTimeoutMs;
        const statePath = path.join(root, 'state.json');
        const stat = await fs.promises.lstat(statePath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe state');
        state = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
        if (state.root !== root || state.markerFile !== path.join(root, 'ownership.marker') ||
            state.marker !== `fdpath:${state.markerFile}`) {
          throw new Error('state paths do not match managed generation');
        }
        await validatePersistedSocketRoot(state);
        const reconcileBudget = remainingMs(deadline);
        if (reconcileBudget <= 0) throw new ObserverContainmentError('cleanup_timeout', 'Observer cleanup deadline expired');
        try {
          await this._run(this.helperPaths.guardian, [
            'reconcile', String(state.parent.pid), String(state.parent.startSec), String(state.parent.startUsec),
            state.marker, String(reconcileBudget),
          ], { env: cleanGuardianEnvironment(), timeout: reconcileBudget });
        } catch (error) {
          if (error?.code !== 4) throw error;
          throw new Error('recorded producer is still alive');
        }
        await this._confirmStableEmpty(state, deadline);
        const listenerBudget = remainingMs(deadline);
        if (listenerBudget <= 0) throw new ObserverContainmentError('cleanup_timeout', 'Observer cleanup deadline expired');
        if (await listenerOpen(Number(state.port), listenerBudget)) throw new Error('listener survived reconciliation');
        await fs.promises.rm(state.socketRoot, { recursive: true, force: true });
        await fs.promises.rm(root, { recursive: true, force: true });
        results.push({ generation: state.generation, reconciled: true });
      } catch (error) {
        throw new ObserverContainmentError('reconcile_failed', `Observer generation reconciliation failed: ${entry.name}: ${error.message}`, error);
      }
    }
    return results;
  }
}
