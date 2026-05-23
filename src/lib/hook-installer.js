import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLAUDE_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest', 'SubagentStart', 'SubagentStop'];
const CODEX_HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest'];
const CODEX_HOOK_FEATURE = 'hooks';

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

export class HookInstaller {
  constructor(projectRoot, zylosDir) {
    this.projectRoot = projectRoot || path.resolve(__dirname, '..', '..');
    this.zylosDir = zylosDir || process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
    this.hookScript = path.join(this.projectRoot, 'src', 'lib', 'hook-ingest.cjs');
    this.statuslineScript = path.join(this.projectRoot, 'src', 'lib', 'statusline-ingest.cjs');
  }

  detectRuntime() {
    const rt = process.env.ZYLOS_RUNTIME;
    if (rt === 'claude' || rt === 'codex') return rt;
    return rt ? null : 'claude';
  }

  _command() {
    return `node ${this.hookScript}`;
  }

  _isOwn(command) {
    if (!command) return false;
    return command.includes(this.hookScript) ||
      (command.includes('hook-ingest.cjs') && command.includes('dashboard'));
  }

  // --- Claude Code ---

  _claudePath() {
    return path.join(this.zylosDir, '.claude', 'settings.json');
  }

  _readClaude() {
    try {
      return JSON.parse(fs.readFileSync(this._claudePath(), 'utf8'));
    } catch {
      return {};
    }
  }

  _writeClaude(settings) {
    const p = this._claudePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n');
  }

  installClaudeHooks() {
    const settings = this._readClaude();
    if (!settings.hooks) settings.hooks = {};

    const cmd = this._command();
    let added = 0;

    for (const event of CLAUDE_HOOK_EVENTS) {
      if (!Array.isArray(settings.hooks[event])) {
        settings.hooks[event] = [];
      }

      const existingGroup = settings.hooks[event].find(g =>
        g.hooks?.some(h => this._isOwn(h.command))
      );

      if (existingGroup) {
        for (const h of existingGroup.hooks) {
          if (this._isOwn(h.command)) {
            if (h.timeout !== 5 || h.async !== true) {
              h.timeout = 5;
              h.async = true;
              added++;
            }
          }
        }
        continue;
      }

      const entry = {
        hooks: [{ type: 'command', command: cmd, timeout: 5, async: true }]
      };
      if (TOOL_EVENTS.has(event)) entry.matcher = '';
      settings.hooks[event].push(entry);
      added++;
    }

    if (added > 0) this._writeClaude(settings);
    return { runtime: 'claude', added, total: CLAUDE_HOOK_EVENTS.length, path: this._claudePath() };
  }

  uninstallClaudeHooks() {
    const settings = this._readClaude();
    if (!settings.hooks) return { runtime: 'claude', removed: 0 };

    let removed = 0;
    for (const event of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[event])) continue;
      const before = settings.hooks[event].length;
      settings.hooks[event] = settings.hooks[event].filter(g =>
        !g.hooks?.some(h => this._isOwn(h.command))
      );
      removed += before - settings.hooks[event].length;
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }

    if (removed > 0) this._writeClaude(settings);
    return { runtime: 'claude', removed, path: this._claudePath() };
  }

  // --- Codex ---
  // Codex hooks.json uses the same nested format as Claude settings.json hooks.
  // Codex 0.130 skips command hooks marked async, so Dashboard hooks stay sync
  // and rely on hook-ingest.cjs to return quickly or spool on failure.

  _codexPath() {
    return path.join(os.homedir(), '.codex', 'hooks.json');
  }

  _codexConfigPath() {
    return path.join(os.homedir(), '.codex', 'config.toml');
  }

  _codexConfigPaths() {
    return Array.from(new Set([
      this._codexConfigPath(),
      path.join(this.zylosDir, '.codex', 'config.toml')
    ]));
  }

  _readCodex() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this._codexPath(), 'utf8'));
    } catch {
      return {};
    }
    if (!Array.isArray(raw)) return raw;
    // Migrate old flat-array format [{ event, command, ... }] to nested
    const config = { hooks: {} };
    for (const entry of raw) {
      if (!entry.event || !entry.command) continue;
      const event = entry.event;
      if (!config.hooks[event]) config.hooks[event] = [];
      const group = { hooks: [{ type: 'command', command: entry.command }] };
      if (entry.timeout != null) group.hooks[0].timeout = entry.timeout;
      if (entry.async != null) group.hooks[0].async = entry.async;
      if (TOOL_EVENTS.has(event)) group.matcher = '';
      config.hooks[event].push(group);
    }
    return config;
  }

  _writeCodex(config) {
    const p = this._codexPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
  }

  _enableCodexHookFeatureAtPath(p) {
    let text = '';
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      text = '';
    }

    const flagPattern = new RegExp(`^${CODEX_HOOK_FEATURE}\\s*=\\s*(true|false)\\s*$`, 'm');
    const existingFlag = flagPattern.exec(text);
    if (existingFlag?.[1] === 'true') {
      return { enabled: true, changed: false, path: p };
    }

    let next;
    if (existingFlag) {
      next = text.replace(flagPattern, `${CODEX_HOOK_FEATURE} = true`);
    } else if (/^\[features\]\s*$/m.test(text)) {
      next = text.replace(/^(\[features\]\s*)$/m, `$1\n${CODEX_HOOK_FEATURE} = true`);
    } else {
      const trimmed = text.replace(/\s*$/, '');
      next = `${trimmed}${trimmed ? '\n\n' : ''}[features]\n${CODEX_HOOK_FEATURE} = true\n`;
    }

    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, next.endsWith('\n') ? next : `${next}\n`);
    return { enabled: true, changed: true, path: p };
  }

  _enableCodexHookFeature() {
    const results = this._codexConfigPaths().map(p => this._enableCodexHookFeatureAtPath(p));
    return {
      enabled: results.every(r => r.enabled),
      changed: results.some(r => r.changed),
      path: results[0]?.path,
      paths: results.map(r => r.path),
      results
    };
  }

  _codexCommand() {
    return `ZYLOS_RUNTIME=codex ZYLOS_DIR=${this.zylosDir} node ${this.hookScript}`;
  }

  installCodexHooks() {
    const config = this._readCodex();
    if (!config.hooks) config.hooks = {};
    const feature = this._enableCodexHookFeature();

    const cmd = this._codexCommand();
    let added = 0;

    for (const event of CODEX_HOOK_EVENTS) {
      if (!Array.isArray(config.hooks[event])) {
        config.hooks[event] = [];
      }

      const existingGroup = config.hooks[event].find(g =>
        g.hooks?.some(h => this._isOwn(h.command))
      );

      if (existingGroup) {
        for (const h of existingGroup.hooks) {
          if (this._isOwn(h.command)) {
            const needsUpdate = h.timeout !== 5 || h.async !== undefined || h.command !== cmd;
            if (needsUpdate) {
              h.timeout = 5;
              delete h.async;
              h.command = cmd;
              added++;
            }
          }
        }
        continue;
      }

      const entry = {
        hooks: [{ type: 'command', command: cmd, timeout: 5 }]
      };
      if (TOOL_EVENTS.has(event)) entry.matcher = '';
      config.hooks[event].push(entry);
      added++;
    }

    if (added > 0) this._writeCodex(config);
    return { runtime: 'codex', added, total: CODEX_HOOK_EVENTS.length, path: this._codexPath(), feature };
  }

  uninstallCodexHooks() {
    const config = this._readCodex();
    if (!config.hooks) return { runtime: 'codex', removed: 0 };

    let removed = 0;
    for (const event of Object.keys(config.hooks)) {
      if (!Array.isArray(config.hooks[event])) continue;
      const before = config.hooks[event].length;
      config.hooks[event] = config.hooks[event].filter(g =>
        !g.hooks?.some(h => this._isOwn(h.command))
      );
      removed += before - config.hooks[event].length;
      if (config.hooks[event].length === 0) delete config.hooks[event];
    }

    if (removed > 0) this._writeCodex(config);
    return { runtime: 'codex', removed, path: this._codexPath() };
  }

  // --- StatusLine ---

  _isOwnStatusline(command) {
    if (!command) return false;
    return command.includes(this.statuslineScript) ||
      (command.includes('statusline-ingest.cjs') && command.includes('dashboard'));
  }

  installStatusline() {
    const settings = this._readClaude();
    const cmd = `node ${this.statuslineScript}`;

    if (settings.statusLine?.command && this._isOwnStatusline(settings.statusLine.command)) {
      return { installed: false, reason: 'already_installed', path: this._claudePath() };
    }

    if (settings.statusLine?.command && !this._isOwnStatusline(settings.statusLine.command)) {
      return { installed: false, reason: 'existing_statusline', path: this._claudePath() };
    }

    settings.statusLine = {
      type: 'command',
      command: cmd,
      refreshInterval: 5
    };

    this._writeClaude(settings);
    return { installed: true, path: this._claudePath() };
  }

  uninstallStatusline() {
    const settings = this._readClaude();
    if (!settings.statusLine || !this._isOwnStatusline(settings.statusLine.command)) {
      return { removed: false };
    }

    delete settings.statusLine;
    this._writeClaude(settings);
    return { removed: true, path: this._claudePath() };
  }

  // --- Combined ---

  install() {
    return {
      claude: this.installClaudeHooks(),
      codex: this.installCodexHooks(),
      statusline: this.installStatusline()
    };
  }

  uninstall() {
    return {
      claude: this.uninstallClaudeHooks(),
      codex: this.uninstallCodexHooks(),
      statusline: this.uninstallStatusline()
    };
  }
}
