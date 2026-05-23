import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CLAUDE_MODEL_PRICES = {
  'claude-opus-4': { input: 5, output: 25, cacheRead: 0.50, cacheCreation: 10 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.30, cacheCreation: 6 },
  'claude-haiku-4': { input: 1, output: 5, cacheRead: 0.10, cacheCreation: 2 }
};

export const DEFAULT_CODEX_MODEL_PRICES = {
  // Standard API pricing per 1M tokens. OpenAI bills uncached/cache-write input
  // at input price and cached input at the cached-input price.
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.50, cacheCreation: 5 },
  'gpt-5.4-mini': { input: 0.75, output: 4.50, cacheRead: 0.075, cacheCreation: 0.75 },
  'gpt-5.4-nano': { input: 0.20, output: 1.25, cacheRead: 0.02, cacheCreation: 0.20 },
  'gpt-5.4': { input: 2.50, output: 15, cacheRead: 0.25, cacheCreation: 2.50 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175, cacheCreation: 1.75 },
  'gpt-5.2-codex': { input: 1.75, output: 14, cacheRead: 0.175, cacheCreation: 1.75 },
  'gpt-5.1-codex-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheCreation: 0.25 },
  'gpt-5.1-codex-max': { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 1.25 },
  'gpt-5.1-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 1.25 },
  'gpt-5-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 1.25 },
  'codex-mini-latest': { input: 1.50, output: 6, cacheRead: 0.375, cacheCreation: 1.50 },
  'gpt-5.2-chat-latest': { input: 1.75, output: 14, cacheRead: 0.175, cacheCreation: 1.75 },
  'gpt-5.2': { input: 1.75, output: 14, cacheRead: 0.175, cacheCreation: 1.75 },
  'gpt-5.1-chat-latest': { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 1.25 },
  'gpt-5.1': { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 1.25 },
  'gpt-5-chat-latest': { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 1.25 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheCreation: 0.25 },
  'gpt-5-nano': { input: 0.05, output: 0.40, cacheRead: 0.005, cacheCreation: 0.05 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 1.25 }
};

export const DEFAULT_CODEX_PRIORITY_MODEL_PRICES = {
  // OpenAI Priority processing prices per 1M tokens. Codex /fast maps to the
  // priority service tier for models that expose a Fast tier in Codex metadata.
  'gpt-5.5': { input: 12.50, output: 75, cacheRead: 1.25, cacheCreation: 12.50 },
  'gpt-5.4-mini': { input: 1.50, output: 9, cacheRead: 0.15, cacheCreation: 1.50 },
  'gpt-5.4': { input: 5, output: 30, cacheRead: 0.50, cacheCreation: 5 },
  'gpt-5.3-codex': { input: 3.50, output: 28, cacheRead: 0.35, cacheCreation: 3.50 }
};

export const DEFAULT_RUNTIME_MODEL_PRICES = {
  claude: DEFAULT_CLAUDE_MODEL_PRICES,
  codex: DEFAULT_CODEX_MODEL_PRICES
};

export const DEFAULT_RUNTIME_SERVICE_TIER_MODEL_PRICES = {
  codex: {
    priority: DEFAULT_CODEX_PRIORITY_MODEL_PRICES
  }
};

export const DEFAULT_RUNTIME_FAST_MODE_MULTIPLIERS = {
  claude: 6
};

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
    zylosDir,
    dataDir,
    auth: {
      enabled: true,
      password: null,
      allowUrlTokenOnLocalhost: false
    },
    runtimeModelPrices: DEFAULT_RUNTIME_MODEL_PRICES,
    runtimeServiceTierModelPrices: DEFAULT_RUNTIME_SERVICE_TIER_MODEL_PRICES,
    runtimeFastModeMultipliers: DEFAULT_RUNTIME_FAST_MODE_MULTIPLIERS
  };

  let loaded = {};
  try {
    if (fs.existsSync(configPath)) {
      loaded = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (err) {
    loaded = { configError: err.message };
  }

  const runtimeModelPrices = {
    claude: {
      ...DEFAULT_CLAUDE_MODEL_PRICES,
      ...(loaded.runtimeModelPrices?.claude || loaded.modelPrices || {})
    },
    codex: {
      ...DEFAULT_CODEX_MODEL_PRICES,
      ...(loaded.runtimeModelPrices?.codex || {})
    }
  };
  const runtimeFastModeMultipliers = {
    ...DEFAULT_RUNTIME_FAST_MODE_MULTIPLIERS,
    ...(loaded.runtimeFastModeMultipliers || {}),
    claude: Number(loaded.runtimeFastModeMultipliers?.claude ?? loaded.fastModeMultiplier ?? DEFAULT_RUNTIME_FAST_MODE_MULTIPLIERS.claude)
  };
  const loadedServiceTierPrices = loaded.runtimeServiceTierModelPrices || {};
  const runtimeServiceTierModelPrices = {
    ...loadedServiceTierPrices,
    codex: {
      ...(loadedServiceTierPrices.codex || {}),
      priority: {
        ...DEFAULT_CODEX_PRIORITY_MODEL_PRICES,
        ...(loadedServiceTierPrices.codex?.priority || {})
      }
    }
  };

  return {
    ...defaults,
    ...loaded,
    port: Number(loaded.port || defaults.port),
    host: loaded.host || defaults.host,
    zylosDir: loaded.zylosDir || defaults.zylosDir,
    dataDir,
    auth: {
      ...defaults.auth,
      ...(loaded.auth || {})
    },
    runtimeModelPrices,
    runtimeServiceTierModelPrices,
    modelPrices: runtimeModelPrices.claude,
    runtimeFastModeMultipliers,
    fastModeMultiplier: runtimeFastModeMultipliers.claude,
    configPath,
    configError: loaded.configError || null
  };
}

export function modelPricesForRuntime(config, runtime = config?.runtime, serviceTier = 'standard') {
  const rt = runtime === 'codex' ? 'codex' : 'claude';
  const tier = normalizeServiceTier(serviceTier);
  if (rt === 'codex' && tier === 'priority') {
    return config?.runtimeServiceTierModelPrices?.codex?.priority || DEFAULT_CODEX_PRIORITY_MODEL_PRICES;
  }
  return config?.runtimeModelPrices?.[rt] || config?.modelPrices || {};
}

export function fastModeMultiplierForRuntime(config, runtime = config?.runtime) {
  const rt = runtime === 'codex' ? 'codex' : 'claude';
  return config?.runtimeFastModeMultipliers?.[rt] ?? (rt === 'claude' ? config?.fastModeMultiplier : null) ?? null;
}

export function normalizeServiceTier(serviceTier) {
  if (serviceTier === 'fast' || serviceTier === 'priority') return 'priority';
  return 'standard';
}

export function ensureDataDirs(config = loadConfig()) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, 'spool'), { recursive: true });
}

export function publicDir() {
  return path.resolve(new URL('../../public', import.meta.url).pathname);
}
