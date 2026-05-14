import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const C4_CONTROL = path.join(os.homedir(), 'zylos', '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

export async function handleAction(action, body, config) {
  process.stderr.write(`[actions] ${action}${body ? ' ' + JSON.stringify(body) : ''}\n`);
  switch (action) {
    case 'interrupt': return interrupt();
    case 'restart-session': return restartSession(config);
    case 'switch-runtime': return switchRuntime(body, config);
    case 'switch-model': return switchModel(body, config);
    case 'switch-effort': return switchEffort(body, config);
    case 'upgrade-zylos': return upgradeZylos();
    case 'upgrade-cc': return upgradeCc();
    default: return { ok: false, error: 'unknown_action' };
  }
}

async function interrupt() {
  try {
    await execFileAsync('node', [C4_CONTROL, 'enqueue', '--content', '[KEYSTROKE]Escape', '--priority', '0', '--bypass-state'], { timeout: 5000 });
    return { ok: true, message: 'Interrupt signal sent' };
  } catch (err) {
    return { ok: false, error: 'interrupt_failed', message: err.message };
  }
}

async function restartSession(config) {
  const runtime = config.runtime || process.env.ZYLOS_RUNTIME || 'claude';
  const session = runtime === 'codex' ? 'codex-main' : 'claude-main';
  try {
    await execFileAsync('tmux', ['kill-session', '-t', session], { timeout: 5000 });
    return { ok: true, message: `Session "${session}" terminated. Activity monitor will restart it.` };
  } catch (err) {
    if (err.message?.includes('no server running') || err.message?.includes("can't find session")) {
      return { ok: true, message: 'No active session found. Activity monitor will start a new one.' };
    }
    return { ok: false, error: 'restart_failed', message: err.message };
  }
}

async function switchRuntime(body, config) {
  const target = body?.runtime;
  if (!target || !['claude', 'codex'].includes(target)) {
    return { ok: false, error: 'invalid_runtime', message: 'runtime must be "claude" or "codex"' };
  }

  const current = config.runtime || process.env.ZYLOS_RUNTIME || 'claude';
  if (target === current) {
    return { ok: false, error: 'already_active', message: `Already running ${target}` };
  }

  try {
    await execFileAsync('which', [target], { timeout: 3000 });
  } catch {
    return { ok: false, error: 'not_installed', message: `${target} CLI not found. Install it first.` };
  }

  const child = spawn('zylos', ['runtime', target], {
    detached: true, stdio: 'ignore', env: { ...process.env }
  });
  child.unref();

  return { ok: true, message: `Switching to ${target}. Dashboard will restart momentarily.`, detached: true };
}

async function switchModel(body, config) {
  const model = body?.model;
  if (!model || typeof model !== 'string') {
    return { ok: false, error: 'invalid_model', message: 'model is required' };
  }

  const runtime = config.runtime || process.env.ZYLOS_RUNTIME || 'claude';

  if (runtime === 'claude') {
    const settings = readSettings();
    const prev = settings.model;
    if (prev === model) {
      return { ok: false, error: 'already_set', message: `Model already set to ${model}` };
    }
    settings.model = model;
    writeSettings(settings);

    const session = 'claude-main';
    try {
      await execFileAsync('tmux', ['kill-session', '-t', session], { timeout: 5000 });
    } catch { /* session may not exist */ }

    return { ok: true, message: `Model changed to ${model}. Session restarting.`, previous: prev, requires_restart: true };
  }

  // Codex: placeholder
  return { ok: false, error: 'not_implemented', message: 'Model switch for Codex runtime not yet implemented' };
}

async function switchEffort(body, config) {
  const effort = body?.effort;
  const runtime = config.runtime || process.env.ZYLOS_RUNTIME || 'claude';

  if (runtime === 'claude') {
    const valid = ['low', 'medium', 'high', 'max'];
    if (!effort || !valid.includes(effort)) {
      return { ok: false, error: 'invalid_effort', message: `effort must be one of: ${valid.join(', ')}` };
    }

    const settings = readSettings();
    const prev = settings.effortLevel;
    if (prev === effort) {
      return { ok: false, error: 'already_set', message: `Effort already set to ${effort}` };
    }
    settings.effortLevel = effort;
    writeSettings(settings);

    try {
      await execFileAsync('tmux', ['kill-session', '-t', 'claude-main'], { timeout: 5000 });
    } catch { /* session may not exist */ }

    return { ok: true, message: `Effort changed to ${effort}. Session restarting.`, previous: prev, requires_restart: true };
  }

  // Codex: placeholder
  return { ok: false, error: 'not_implemented', message: 'Effort switch for Codex runtime not yet implemented' };
}

async function upgradeZylos() {
  const child = spawn('zylos', ['upgrade', '--self', '-y'], {
    detached: true, stdio: 'ignore', env: { ...process.env }
  });
  child.unref();

  return { ok: true, message: 'Upgrade started. All services will restart.', detached: true };
}

async function upgradeCc() {
  try {
    const { stdout, stderr } = await execFileAsync('claude', ['update'], { timeout: 60000 });
    const output = (stdout || '') + (stderr || '');
    return { ok: true, message: 'Claude Code updated. Restart session to apply.', output: output.trim(), requires_restart: true };
  } catch (err) {
    const fallbackMsg = err.stderr || err.stdout || err.message;
    return { ok: false, error: 'upgrade_failed', message: fallbackMsg };
  }
}

export function getActionsMeta(config) {
  const runtime = config.runtime || process.env.ZYLOS_RUNTIME || 'claude';

  const models = runtime === 'claude'
    ? [
        { id: 'claude-opus-4-6', label: 'Opus 4.6' },
        { id: 'claude-opus-4-6[1m]', label: 'Opus 4.6 (1M)' },
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
        { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }
      ]
    : [
        { id: 'gpt-5.4', label: 'GPT-5.4' },
        { id: 'o3', label: 'o3' },
        { id: 'o4-mini', label: 'o4-mini' }
      ];

  const efforts = runtime === 'claude'
    ? ['low', 'medium', 'high', 'max']
    : [];

  const settings = runtime === 'claude' ? readSettings() : {};

  return {
    runtime,
    current_model: settings.model || null,
    current_effort: settings.effortLevel || null,
    models,
    efforts
  };
}
