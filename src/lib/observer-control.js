import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DarwinObserverContainment } from './observer-containment-darwin.js';
import { ObserverCoordinator } from './observer-coordinator.js';
import { ObserverInstaller } from './observer-installer.js';
import { observerPaths } from './observer-paths.js';

const MAX_MESSAGE_BYTES = 4 * 1024;
const CONNECT_TIMEOUT_MS = 2_000;
const OPERATION_TIMEOUT_MS = 15_000;
const INCOMPLETE_LOCK_STALE_MS = 10_000;

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

async function readOwner(lockPath) {
  try {
    const stat = await fs.promises.lstat(lockPath);
    const ownerPath = stat.isDirectory() && !stat.isSymbolicLink()
      ? path.join(lockPath, 'owner.json')
      : lockPath;
    const value = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

async function writeOwner(lockPath, owner) {
  await fs.promises.writeFile(lockPath, `${JSON.stringify(owner)}\n`, {
    flag: 'wx', mode: 0o600,
  });
}

async function recoverIncompleteLock(lockPath, staleMs, now = Date.now()) {
  let stat;
  try { stat = await fs.promises.lstat(lockPath); } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  if (stat.isSymbolicLink() || now - stat.mtimeMs < staleMs) return false;
  const quarantinePath = path.join(path.dirname(lockPath), `.stale-${crypto.randomBytes(12).toString('hex')}`);
  try {
    await fs.promises.rename(lockPath, quarantinePath);
    const movedStat = await fs.promises.lstat(quarantinePath);
    if (movedStat.dev !== stat.dev || movedStat.ino !== stat.ino) {
      try { await fs.promises.rename(quarantinePath, lockPath); } catch {}
      return false;
    }
    const movedOwner = await readOwner(quarantinePath);
    if (movedOwner && isProcessAlive(Number(movedOwner.pid))) {
      try { await fs.promises.rename(quarantinePath, lockPath); } catch {}
      return false;
    }
    await fs.promises.rm(quarantinePath, { recursive: movedStat.isDirectory(), force: true });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
}

async function acquireCoordinatorLock(controlRoot, { timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  await fs.promises.mkdir(controlRoot, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(controlRoot, 0o700);
  const lockPath = path.join(controlRoot, 'coordinator.lock');
  const owner = { pid: process.pid, nonce: crypto.randomBytes(16).toString('hex'), createdAt: Date.now() };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      await writeOwner(lockPath, owner);
      return {
        owner,
        lockPath,
        async release() {
          const current = await readOwner(lockPath);
          if (current?.nonce === owner.nonce) await fs.promises.unlink(lockPath);
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const staleOwner = await readOwner(lockPath);
      if (staleOwner && isProcessAlive(Number(staleOwner.pid))) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      if (await recoverIncompleteLock(lockPath, INCOMPLETE_LOCK_STALE_MS)) continue;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw Object.assign(new Error('Observer coordinator is already active'), { code: 'coordinator_active' });
}

function controlSocketPath(dataDir) {
  const key = crypto.createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 20);
  return path.join('/tmp', `zobs-ctl-${key}.sock`);
}

function readLine(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Observer control timeout')); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error('Observer control closed')); };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_MESSAGE_BYTES) { cleanup(); reject(new Error('Observer control message too large')); return; }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      cleanup();
      resolve(JSON.parse(buffer.subarray(0, newline).toString('utf8')));
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

export class ObserverControlServer {
  constructor({ dataDir, onPreUninstall }) {
    this.dataDir = dataDir;
    this.onPreUninstall = onPreUninstall;
    this.socketPath = controlSocketPath(dataDir);
    this.server = null;
    this.lock = null;
    this._starting = null;
  }

  async start() {
    if (this.server) return;
    if (this._starting) return this._starting;
    this._starting = (async () => {
      const controlRoot = observerPaths(this.dataDir).control;
      this.lock = await acquireCoordinatorLock(controlRoot);
      try {
        try { await fs.promises.unlink(this.socketPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        this.server = net.createServer((socket) => {
          readLine(socket, CONNECT_TIMEOUT_MS).then(async (message) => {
            if (message?.action !== 'pre-uninstall' || Object.keys(message).length !== 1) {
              throw Object.assign(new Error('invalid control action'), { code: 'invalid_action' });
            }
            await this.onPreUninstall();
            socket.end(`${JSON.stringify({ ok: true })}\n`);
          }).catch((error) => {
            if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: false, error: error.code || 'control_failed' })}\n`);
          });
        });
        await new Promise((resolve, reject) => {
          this.server.once('error', reject);
          this.server.listen(this.socketPath, resolve);
        });
        await fs.promises.chmod(this.socketPath, 0o600);
      } catch (error) {
        try { this.server?.close(); } catch {}
        this.server = null;
        await this.lock?.release();
        this.lock = null;
        throw error;
      }
    })().finally(() => { this._starting = null; });
    return this._starting;
  }

  async close() {
    if (this._starting) await this._starting;
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    try { await fs.promises.unlink(this.socketPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await this.lock?.release();
    this.lock = null;
  }
}

async function requestRunningProducer(dataDir) {
  const socket = net.createConnection(controlSocketPath(dataDir));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('Observer control connect timeout')); }, CONNECT_TIMEOUT_MS);
    socket.once('connect', () => { clearTimeout(timeout); resolve(); });
    socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
  socket.write(`${JSON.stringify({ action: 'pre-uninstall' })}\n`);
  const response = await readLine(socket, OPERATION_TIMEOUT_MS);
  socket.end();
  if (response?.ok !== true) throw Object.assign(new Error('Running Observer coordinator rejected teardown'), {
    code: response?.error || 'control_failed',
  });
  return { mode: 'online' };
}

export async function runObserverPreUninstall({ dataDir, configPath }) {
  try {
    return await requestRunningProducer(dataDir);
  } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error?.code)) throw error;
  }
  const paths = observerPaths(dataDir);
  const lock = await acquireCoordinatorLock(paths.control, { timeoutMs: OPERATION_TIMEOUT_MS });
  try {
    const installer = new ObserverInstaller({ dataDir });
    const containment = new DarwinObserverContainment({ dataDir });
    const coordinator = new ObserverCoordinator({
      configPath,
      installer,
      teardown: ({ reason }) => containment.stopGeneration({ reason }),
    });
    await containment.reconcilePersisted();
    await coordinator.reconcileStartup();
    await coordinator.uninstall();
    return { mode: 'offline' };
  } finally {
    await lock.release();
  }
}
