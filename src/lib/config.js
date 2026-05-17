import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function getZylosDir() {
  return process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
}

export function getDataDir(zylosDir = getZylosDir()) {
  return path.join(zylosDir, 'components', 'dashboard');
}

export function loadConfig() {
  const zylosDir = getZylosDir();
  const dataDir = getDataDir(zylosDir);
  const configPath = path.join(dataDir, 'config.json');
  const defaults = {
    port: 3470,
    host: '127.0.0.1',
    theme: 'default',
    refreshMs: 5000,
    zylosDir,
    dataDir,
    auth: {
      enabled: true,
      password: null,
      allowUrlTokenOnLocalhost: false
    },
    modelPrices: {
      'claude-opus-4': { input: 5, output: 25, cacheRead: 0.50, cacheCreation: 10 },
      'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.30, cacheCreation: 6 },
      'claude-haiku-4': { input: 1, output: 5, cacheRead: 0.10, cacheCreation: 2 }
    },
    fastModeMultiplier: 6
  };

  let loaded = {};
  try {
    if (fs.existsSync(configPath)) {
      loaded = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (err) {
    loaded = { configError: err.message };
  }

  return {
    ...defaults,
    ...loaded,
    port: Number(loaded.port || defaults.port),
    host: loaded.host || defaults.host,
    theme: loaded.theme || defaults.theme,
    zylosDir: loaded.zylosDir || defaults.zylosDir,
    dataDir,
    auth: {
      ...defaults.auth,
      ...(loaded.auth || {})
    },
    modelPrices: {
      ...defaults.modelPrices,
      ...(loaded.modelPrices || {})
    },
    fastModeMultiplier: Number(loaded.fastModeMultiplier ?? defaults.fastModeMultiplier),
    configPath,
    configError: loaded.configError || null
  };
}

export function ensureDataDirs(config = loadConfig()) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, 'spool'), { recursive: true });
}

export function publicDir() {
  return path.resolve(new URL('../../public', import.meta.url).pathname);
}
