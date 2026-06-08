#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HookInstaller } from '../src/lib/hook-installer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const dataDir = path.join(zylosDir, 'components', 'dashboard');

fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

// Future version migrations go here.
// Example:
//   const configPath = path.join(dataDir, 'config.json');
//   if (fs.existsSync(configPath)) {
//     const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
//     // migrate fields...
//     fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
//   }

const installer = new HookInstaller(projectRoot, zylosDir);
const result = installer.install();
console.log(`claude hooks: ${result.claude.added} added (${result.claude.total} events)`);
console.log(`codex hooks: ${result.codex.added} added (${result.codex.total} events)`);
if (result.statusline.installed) {
  console.log('claude statusline: installed');
} else if (result.statusline.reason) {
  console.log(`claude statusline: skipped (${result.statusline.reason})`);
}

console.log('[post-upgrade] complete');
