#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const dataDir = path.join(zylosDir, 'components', 'dashboard');
const configPath = path.join(dataDir, 'config.json');

fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

if (!fs.existsSync(configPath)) {
  const config = {
    port: Number(process.env.DASHBOARD_PORT || 3470),
    host: '127.0.0.1',
    theme: process.env.DASHBOARD_THEME || 'default',
    refreshMs: 5000,
    zylosDir,
    auth: {
      enabled: false,
      bearerToken: null,
      allowUrlTokenOnLocalhost: false
    },
    retention: {
      metrics: 'full',
      logs: 'full',
      tracesSampleRate: 0.1,
      archiveAfterDays: 30
    }
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

console.log(`dashboard data dir ready: ${dataDir}`);
