#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.ZYLOS_DATA_DIR
  || path.join(process.env.HOME, 'zylos/components/dashboard');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const COMPONENT_PREFIX = 'DASHBOARD_';

const DEFAULT_CONFIG = {
  port: 3470,
  host: '127.0.0.1'
};

const KEY_MAP = {
  port: 'port',
  host: 'host',
  ingest_token: 'ingestToken',
  spool_max_bytes: 'spoolMaxBytes',
  auth_password: ['auth', 'password']
};

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return { ...fallback };
    return { ...fallback, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (err) {
    throw new Error(`Failed to read ${filePath}: ${err.message}`);
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function configKeyFromName(name) {
  return name
    .replace(new RegExp(`^${COMPONENT_PREFIX}`), '')
    .toLowerCase();
}

function setNested(obj, keyPath, value) {
  if (Array.isArray(keyPath)) {
    let target = obj;
    for (let i = 0; i < keyPath.length - 1; i++) {
      if (!target[keyPath[i]] || typeof target[keyPath[i]] !== 'object') {
        target[keyPath[i]] = {};
      }
      target = target[keyPath[i]];
    }
    target[keyPath[keyPath.length - 1]] = value;
  } else {
    obj[keyPath] = value;
  }
}

try {
  const raw = (await readStdin()).trim();
  if (!raw) {
    throw new Error('Expected stdin JSON object with collected config values');
  }

  const collected = JSON.parse(raw);
  if (!collected || Array.isArray(collected) || typeof collected !== 'object') {
    throw new Error('Configure input must be a JSON object');
  }

  const config = readJsonFile(CONFIG_PATH, DEFAULT_CONFIG);
  for (const [name, value] of Object.entries(collected)) {
    if (value === undefined || value === null || value === '') continue;
    const stripped = configKeyFromName(name);
    const mapped = KEY_MAP[stripped];
    if (mapped) {
      const coerced = stripped === 'port' || stripped === 'spool_max_bytes'
        ? Number(value)
        : value;
      setNested(config, mapped, coerced);
    } else {
      config[stripped] = value;
    }
  }

  if (config.auth?.password && !config.auth.enabled) {
    config.auth.enabled = true;
  }

  writeJsonFile(CONFIG_PATH, config);
  console.log(`[configure] Wrote config to ${CONFIG_PATH}`);
} catch (err) {
  console.error(`[configure] ${err.message}`);
  process.exit(1);
}
