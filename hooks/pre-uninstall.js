#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HookInstaller } from '../src/lib/hook-installer.js';
import { runObserverPreUninstall } from '../src/lib/observer-control.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const dataDir = process.env.ZYLOS_DASHBOARD_DATA_DIR || path.join(zylosDir, 'components', 'dashboard');

await runObserverPreUninstall({ dataDir, configPath: path.join(dataDir, 'config.json') });

const installer = new HookInstaller(projectRoot, zylosDir);
const result = installer.uninstall();

if (result.claude.removed > 0) console.log(`claude hooks: ${result.claude.removed} removed`);
if (result.codex.removed > 0) console.log(`codex hooks: ${result.codex.removed} removed`);
if (!result.claude.removed && !result.codex.removed) console.log('no dashboard hooks found to remove');
