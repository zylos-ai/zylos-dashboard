import { execFile, spawn } from 'node:child_process';
import https from 'node:https';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

function settingsPath(zylosDir) {
  return path.join(zylosDir, '.claude', 'settings.json');
}

function c4ControlPath(zylosDir) {
  return path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js');
}

const DEDUP_WINDOW_MS = 2000;
const recentInvocations = new Map();

function readSettings(zylosDir) {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(zylosDir), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(zylosDir, settings) {
  fs.writeFileSync(settingsPath(zylosDir), JSON.stringify(settings, null, 2) + '\n');
}

function log(reqId, msg) {
  process.stderr.write(`[actions ${reqId}] ${msg}\n`);
}

function dedupKey(action, body) {
  return `${action}:${JSON.stringify(body || {})}`;
}

function isDuplicate(action, body) {
  const key = dedupKey(action, body);
  const now = Date.now();
  for (const [k, ts] of recentInvocations) {
    if (now - ts > DEDUP_WINDOW_MS) recentInvocations.delete(k);
  }
  const prev = recentInvocations.get(key);
  if (prev && now - prev <= DEDUP_WINDOW_MS) return true;
  recentInvocations.set(key, now);
  return false;
}

export async function handleAction(action, body, config) {
  const reqId = crypto.randomBytes(3).toString('hex');
  const zylosDir = config.zylosDir || path.join(os.homedir(), 'zylos');
  log(reqId, `=> ${action} ${JSON.stringify(body || {})}`);

  if (isDuplicate(action, body)) {
    log(reqId, `<= deduped (same payload within ${DEDUP_WINDOW_MS}ms)`);
    return { ok: false, error: 'duplicate_request', message: 'Identical request received within dedup window; ignored.' };
  }

  let result;
  try {
    switch (action) {
      case 'interrupt': result = await interrupt(reqId, zylosDir); break;
      case 'restart-session': result = await restartSession(reqId, config); break;
      case 'switch-runtime': result = await switchRuntime(reqId, body, config); break;
      case 'switch-model': result = await switchModel(reqId, body, config, zylosDir); break;
      case 'switch-effort': result = await switchEffort(reqId, body, config, zylosDir); break;
      case 'set-threshold': result = await setThreshold(reqId, body, config, zylosDir); break;
      case 'upgrade-zylos': result = await upgradeZylos(reqId); break;
      case 'upgrade-cc': result = await upgradeCc(reqId); break;
      default: result = { ok: false, error: 'unknown_action' };
    }
  } catch (err) {
    log(reqId, `<= unhandled error: ${err.message}`);
    result = { ok: false, error: 'internal_error', message: err.message };
  }

  log(reqId, `<= ${result.ok ? 'ok' : 'fail'}${result.error ? ' ' + result.error : ''}${result.message ? ' | ' + result.message : ''}`);
  return result;
}

async function interrupt(reqId, zylosDir) {
  const c4Control = c4ControlPath(zylosDir);
  log(reqId, `enqueue control: [KEYSTROKE]Escape (priority=0, bypass-state) via ${c4Control}`);
  try {
    const { stdout, stderr } = await execFileAsync(
      'node',
      [c4Control, 'enqueue', '--content', '[KEYSTROKE]Escape', '--priority', '0', '--bypass-state', '--no-ack-suffix'],
      { timeout: 5000 }
    );
    const out = (stdout || '').trim() + (stderr ? ` | stderr: ${stderr.trim()}` : '');
    log(reqId, `c4-control done${out ? ': ' + out : ''}`);
    return { ok: true, message: 'Interrupt signal sent' };
  } catch (err) {
    log(reqId, `c4-control failed: ${err.message}`);
    return { ok: false, error: 'interrupt_failed', message: err.message };
  }
}

async function restartSession(reqId, config) {
  const runtime = config.runtime || process.env.ZYLOS_RUNTIME || 'claude';
  const session = runtime === 'codex' ? 'codex-main' : 'claude-main';
  log(reqId, `exec: tmux kill-session -t ${session}`);
  try {
    await execFileAsync('tmux', ['kill-session', '-t', session], { timeout: 5000 });
    log(reqId, `tmux session "${session}" killed`);
    return { ok: true, message: `Session "${session}" terminated. Activity monitor will restart it.` };
  } catch (err) {
    if (err.message?.includes('no server running') || err.message?.includes("can't find session")) {
      log(reqId, `tmux: no active session "${session}"`);
      return { ok: true, message: 'No active session found. Activity monitor will start a new one.' };
    }
    log(reqId, `tmux kill-session failed: ${err.message}`);
    return { ok: false, error: 'restart_failed', message: err.message };
  }
}

async function switchRuntime(reqId, body, config) {
  const target = body?.runtime;
  if (!target || !['claude', 'codex'].includes(target)) {
    return { ok: false, error: 'invalid_runtime', message: 'runtime must be "claude" or "codex"' };
  }

  const current = config.runtime || process.env.ZYLOS_RUNTIME || 'claude';
  if (target === current) {
    return { ok: false, error: 'already_active', message: `Already running ${target}` };
  }

  log(reqId, `runtime switch: ${current} → ${target}`);
  try {
    await execFileAsync('which', [target], { timeout: 3000 });
  } catch {
    log(reqId, `${target} CLI not found in PATH`);
    return { ok: false, error: 'not_installed', message: `${target} CLI not found. Install it first.` };
  }

  log(reqId, `spawn detached: zylos runtime ${target}`);
  const child = spawn('zylos', ['runtime', target], {
    detached: true, stdio: 'ignore', env: { ...process.env }
  });
  child.unref();

  return { ok: true, message: `Switching to ${target}. Dashboard will restart momentarily.`, detached: true };
}

async function switchModel(reqId, body, config, zylosDir) {
  const model = body?.model;
  if (!model || typeof model !== 'string') {
    return { ok: false, error: 'invalid_model', message: 'model is required' };
  }

  const runtime = config.runtime || process.env.ZYLOS_RUNTIME || 'claude';

  if (runtime === 'claude') {
    const settings = readSettings(zylosDir);
    const prev = settings.model;
    if (prev === model) {
      log(reqId, `no-op: settings.model already "${model}"`);
      return { ok: false, error: 'already_set', message: `Model already set to ${model}` };
    }
    settings.model = model;
    log(reqId, `write ${settingsPath(zylosDir)}: model "${prev ?? '(unset)'}" → "${model}"`);
    writeSettings(zylosDir, settings);

    return { ok: true, message: `Model changed to ${model}.`, previous: prev, requires_restart: true };
  }

  return { ok: false, error: 'not_implemented', message: 'Model switch for Codex runtime not yet implemented' };
}

function effortsForModel(model) {
  if (model === 'claude-opus-4-7' || model === 'claude-opus-4-7[1m]') {
    return ['low', 'medium', 'high', 'xhigh'];
  }
  return ['low', 'medium', 'high'];
}

async function switchEffort(reqId, body, config, zylosDir) {
  const effort = body?.effort;
  const runtime = config.runtime || process.env.ZYLOS_RUNTIME || 'claude';

  if (runtime === 'claude') {
    const settings = readSettings(zylosDir);
    const valid = effortsForModel(settings.model || '');
    if (!effort || !valid.includes(effort)) {
      return { ok: false, error: 'invalid_effort', message: `effort must be one of: ${valid.join(', ')}` };
    }

    const prev = settings.effortLevel;
    if (prev === effort) {
      log(reqId, `no-op: settings.effortLevel already "${effort}"`);
      return { ok: false, error: 'already_set', message: `Effort already set to ${effort}` };
    }
    settings.effortLevel = effort;
    log(reqId, `write ${settingsPath(zylosDir)}: effortLevel "${prev ?? '(unset)'}" → "${effort}"`);
    writeSettings(zylosDir, settings);

    return { ok: true, message: `Effort changed to ${effort}.`, previous: prev, requires_restart: true };
  }

  return { ok: false, error: 'not_implemented', message: 'Effort switch for Codex runtime not yet implemented' };
}

function fetchLatestGitHubTag(repo) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'zylos-dashboard', Accept: 'application/vnd.github.v3+json' },
      timeout: 10000,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`GitHub API ${res.statusCode}`));
        try {
          const tag = JSON.parse(data).tag_name;
          resolve(tag ? tag.replace(/^v/, '') : null);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('GitHub API timeout')); });
  });
}

async function upgradeZylos(reqId) {
  let currentVersion;
  try {
    const { stdout } = await execFileAsync('zylos', ['--version'], { timeout: 5000 });
    currentVersion = (stdout || '').trim();
  } catch {
    currentVersion = null;
  }

  let latestVersion;
  try {
    latestVersion = await fetchLatestGitHubTag('zylos-ai/zylos-core');
  } catch (err) {
    log(reqId, `version check failed: ${err.message}, proceeding with upgrade`);
  }

  if (currentVersion && latestVersion && currentVersion === latestVersion) {
    log(reqId, `already up to date: v${currentVersion}`);
    return { ok: false, error: 'already_up_to_date', message: `Already on the latest version (v${currentVersion}).` };
  }

  const upgradeMsg = latestVersion && currentVersion
    ? `Upgrading v${currentVersion} → v${latestVersion}. All services will restart.`
    : 'Upgrade started. All services will restart.';

  log(reqId, `spawn detached: zylos upgrade --self -y (${currentVersion || '?'} → ${latestVersion || '?'})`);
  const child = spawn('zylos', ['upgrade', '--self', '-y'], {
    detached: true, stdio: 'ignore', env: { ...process.env }
  });
  child.unref();

  return { ok: true, message: upgradeMsg, detached: true };
}

async function upgradeCc(reqId) {
  log(reqId, `exec: claude update`);
  try {
    const { stdout, stderr } = await execFileAsync('claude', ['update'], { timeout: 60000 });
    const output = (stdout || '') + (stderr || '');
    log(reqId, `claude update done (${output.trim().slice(0, 200)})`);
    return { ok: true, message: 'Claude Code updated. Restart session to apply.', output: output.trim(), requires_restart: true };
  } catch (err) {
    const fallbackMsg = err.stderr || err.stdout || err.message;
    log(reqId, `claude update failed: ${(fallbackMsg || '').slice(0, 200)}`);
    return { ok: false, error: 'upgrade_failed', message: fallbackMsg };
  }
}

async function setThreshold(reqId, body, config, zylosDir) {
  const value = parseInt(body?.value, 10);
  if (!value || value < 10 || value > 95) {
    return { ok: false, error: 'invalid_value', message: 'Threshold must be between 10 and 95' };
  }
  const runtime = config.runtime || process.env.ZYLOS_RUNTIME || 'claude';
  const key = runtime === 'codex' ? 'codex_new_session_threshold' : 'new_session_threshold';
  log(reqId, `exec: zylos config set ${key} ${value}`);
  try {
    const { stdout } = await execFileAsync('zylos', ['config', 'set', key, String(value)], { timeout: 5000 });
    log(reqId, `threshold set: ${stdout.trim()}`);
    return { ok: true, message: `New session threshold set to ${value}%` };
  } catch (err) {
    log(reqId, `set threshold failed: ${err.message}`);
    return { ok: false, error: 'set_failed', message: err.message };
  }
}

export function getActionsMeta(config, runtimeInfo) {
  const runtime = config.runtime || process.env.ZYLOS_RUNTIME || 'claude';

  const models = runtime === 'claude'
    ? [
        { id: 'claude-opus-4-7' },
        { id: 'claude-opus-4-7[1m]' },
        { id: 'claude-opus-4-6' },
        { id: 'claude-opus-4-6[1m]' },
        { id: 'claude-sonnet-4-6' }
      ]
    : [
        { id: 'gpt-5.4', label: 'GPT-5.4' },
        { id: 'o3', label: 'o3' },
        { id: 'o4-mini', label: 'o4-mini' }
      ];

  const efforts_by_model = runtime === 'claude'
    ? {
        'claude-opus-4-7': effortsForModel('claude-opus-4-7'),
        'claude-opus-4-7[1m]': effortsForModel('claude-opus-4-7[1m]'),
        '*': ['low', 'medium', 'high']
      }
    : {};

  const zylosDir = config.zylosDir || path.join(os.homedir(), 'zylos');
  const settings = runtime === 'claude' ? readSettings(zylosDir) : {};

  const thresholdKey = runtime === 'codex' ? 'codex_new_session_threshold' : 'new_session_threshold';
  const defaultThreshold = runtime === 'codex' ? 75 : 70;
  const newSessionThreshold = parseInt(config[thresholdKey], 10) || defaultThreshold;

  return {
    runtime,
    current_model: settings.model || null,
    current_effort: runtimeInfo?.effort || settings.effortLevel || null,
    models,
    efforts_by_model,
    new_session_threshold: newSessionThreshold
  };
}
