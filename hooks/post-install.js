#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/lib/auth.js';
import { HookInstaller } from '../src/lib/hook-installer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const dataDir = path.join(zylosDir, 'components', 'dashboard');
const configPath = path.join(dataDir, 'config.json');

fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

if (!fs.existsSync(configPath)) {
  const plaintext = crypto.randomBytes(16).toString('hex');
  const config = {
    port: 3470,
    host: '127.0.0.1',
    ingestToken: null,
    auth: {
      enabled: true,
      password: hashPassword(plaintext)
    }
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`\n  Dashboard password: ${plaintext}\n  Save this — it won't be shown again.\n`);
}

console.log(`dashboard data dir ready: ${dataDir}`);

const installer = new HookInstaller(projectRoot, zylosDir);
const result = installer.install();
console.log(`claude hooks: ${result.claude.added} added (${result.claude.total} events)`);
console.log(`codex hooks: ${result.codex.added} added (${result.codex.total} events)`);
if (result.statusline.installed) {
  console.log('claude statusline: installed');
} else if (result.statusline.reason) {
  console.log(`claude statusline: skipped (${result.statusline.reason})`);
}
