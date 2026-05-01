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
    port: Number(process.env.DASHBOARD_PORT || 3470),
    host: process.env.DASHBOARD_HOST || '127.0.0.1',
    theme: process.env.DASHBOARD_THEME || 'default',
    refreshMs: 5000,
    zylosDir,
    dataDir,
    auth: {
      enabled: false,
      bearerToken: null,
      allowUrlTokenOnLocalhost: false
    }
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
    port: Number(process.env.DASHBOARD_PORT || loaded.port || defaults.port),
    host: process.env.DASHBOARD_HOST || loaded.host || defaults.host,
    theme: process.env.DASHBOARD_THEME || loaded.theme || defaults.theme,
    zylosDir: loaded.zylosDir || defaults.zylosDir,
    dataDir,
    auth: {
      ...defaults.auth,
      ...(loaded.auth || {})
    },
    configPath,
    configError: loaded.configError || null
  };
}

export function ensureDataDirs(config = loadConfig()) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, 'logs'), { recursive: true });
}

export function publicDir() {
  return path.resolve(new URL('../../public', import.meta.url).pathname);
}
