import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 10_000;
const DEFAULT_RETRY_MS = 20;

export class ConfigMutationError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ConfigMutationError';
    this.code = code;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readLockOwner(lockPath) {
  try {
    const value = JSON.parse(await fs.promises.readFile(path.join(lockPath, 'owner.json'), 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

async function recoverStaleLock(lockPath, staleLockMs, now = Date.now()) {
  let stat;
  try {
    stat = await fs.promises.lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (now - stat.mtimeMs < staleLockMs) return false;
  const owner = await readLockOwner(lockPath);
  if (!owner || isProcessAlive(Number(owner.pid))) return false;
  const quarantinePath = `${lockPath}.stale-${crypto.randomBytes(12).toString('hex')}`;
  try {
    await fs.promises.rename(lockPath, quarantinePath);
    const [movedStat, movedOwner] = await Promise.all([
      fs.promises.lstat(quarantinePath),
      readLockOwner(quarantinePath),
    ]);
    if (movedStat.dev !== stat.dev || movedStat.ino !== stat.ino ||
        movedOwner?.nonce !== owner.nonce || isProcessAlive(Number(movedOwner.pid))) {
      try { await fs.promises.rename(quarantinePath, lockPath); } catch {}
      return false;
    }
    await fs.promises.rm(quarantinePath, { recursive: true });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
}

async function acquireLock(configPath, options) {
  const lockPath = `${configPath}.lock`;
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  const owner = {
    pid: process.pid,
    createdAt: Date.now(),
    nonce: crypto.randomBytes(12).toString('hex'),
  };

  while (true) {
    try {
      await fs.promises.mkdir(lockPath, { mode: 0o700 });
      await fs.promises.writeFile(
        path.join(lockPath, 'owner.json'),
        `${JSON.stringify(owner)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      return { lockPath, owner };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        try { await fs.promises.rm(lockPath, { recursive: true }); } catch {}
        throw new ConfigMutationError('lock_failed', `Failed to acquire config lock: ${error.message}`, error);
      }
      await recoverStaleLock(lockPath, staleLockMs);
      if (Date.now() >= deadline) {
        throw new ConfigMutationError('lock_timeout', `Timed out waiting for config lock: ${configPath}`);
      }
      await delay(Math.min(retryMs, Math.max(1, deadline - Date.now())));
    }
  }
}

async function releaseLock(lock) {
  const current = await readLockOwner(lock.lockPath);
  if (current?.nonce !== lock.owner.nonce) return;
  try {
    await fs.promises.rm(lock.lockPath, { recursive: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function readConfig(configPath) {
  let raw;
  try {
    raw = await fs.promises.readFile(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new ConfigMutationError('read_failed', `Failed to read config: ${error.message}`, error);
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('root must be a JSON object');
    }
    return value;
  } catch (error) {
    throw new ConfigMutationError('invalid_config', `Invalid existing config: ${error.message}`, error);
  }
}

async function writeConfig(configPath, config) {
  const directory = path.dirname(configPath);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(configPath)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporaryPath, configPath);
    await fs.promises.chmod(configPath, 0o600);
    const directoryHandle = await fs.promises.open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    try { await handle?.close(); } catch {}
    try { await fs.promises.unlink(temporaryPath); } catch {}
    throw new ConfigMutationError('write_failed', `Failed to write config: ${error.message}`, error);
  }
}

export async function mutateConfig(configPath, mutator, options = {}) {
  if (typeof mutator !== 'function') throw new TypeError('mutator must be a function');
  const lock = await acquireLock(configPath, options);
  try {
    const config = await readConfig(configPath);
    const result = await mutator(config);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new ConfigMutationError('invalid_mutation', 'Config mutation must preserve an object root');
    }
    await writeConfig(configPath, config);
    return { config, result };
  } finally {
    await releaseLock(lock);
  }
}
