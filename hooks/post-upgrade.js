#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const dataDir = path.join(zylosDir, 'components', 'dashboard');
const configPath = path.join(dataDir, 'config.json');

fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

if (fs.existsSync(configPath)) {
  const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const next = {
    port: Number(process.env.DASHBOARD_PORT || current.port || 3470),
    host: current.host || '127.0.0.1',
    theme: current.theme || process.env.DASHBOARD_THEME || 'default',
    refreshMs: current.refreshMs || 5000,
    zylosDir: current.zylosDir || zylosDir,
    auth: {
      enabled: false,
      bearerToken: null,
      allowUrlTokenOnLocalhost: false,
      ...(current.auth || {})
    },
    retention: {
      metrics: 'full',
      logs: 'full',
      tracesSampleRate: 0.1,
      archiveAfterDays: 30,
      ...(current.retention || {})
    }
  };
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

console.log('dashboard config migration complete');
