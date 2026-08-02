import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyVersionUpdateFields,
  claudeModelMatchesRequested,
  claudeModelSelectionFromRuntime
} from '../src/lib/runtime-info.js';

test('runtime info exposes Codex latest and update when latest is newer than installed', () => {
  const info = applyVersionUpdateFields(
    { runtime: 'codex', codex_running: '0.129.0', codex_installed: '0.130.0' },
    { codex: '0.137.0' },
    { codexInstalledVersion: '0.130.0' }
  );

  assert.equal(info.codex_running, '0.129.0');
  assert.equal(info.codex_latest, '0.137.0');
  assert.equal(info.codex_update, '0.137.0');
});

test('runtime info compares Codex latest against installed, not running', () => {
  const info = applyVersionUpdateFields(
    { runtime: 'codex', codex_running: '0.129.0', codex_installed: '0.137.0' },
    { codex: '0.137.0' },
    { codexInstalledVersion: '0.137.0' }
  );

  assert.equal(info.codex_running, '0.129.0');
  assert.equal(info.codex_latest, '0.137.0');
  assert.equal(info.codex_update, undefined);
});

test('runtime info exposes Codex latest without update when installed is current', () => {
  const info = applyVersionUpdateFields(
    { runtime: 'codex', codex_installed: '0.137.0' },
    { codex: '0.137.0' },
    { codexInstalledVersion: '0.137.0' }
  );

  assert.equal(info.codex_latest, '0.137.0');
  assert.equal(info.codex_update, undefined);
});

test('runtime info omits Codex latest and update when latest check is unavailable', () => {
  const info = applyVersionUpdateFields(
    { runtime: 'codex', codex_installed: '0.130.0' },
    { codex: null },
    { codexInstalledVersion: '0.130.0' }
  );

  assert.equal(info.codex_latest, undefined);
  assert.equal(info.codex_update, undefined);
});

test('Claude model selection uses effective context window to resolve 1M suffix', () => {
  const models = [{ id: 'opus' }, { id: 'opus[1m]' }];

  assert.equal(claudeModelSelectionFromRuntime('opus[1m]', 200000, models), 'opus');
  assert.equal(claudeModelSelectionFromRuntime('opus', 1000000, models), 'opus[1m]');
  assert.equal(claudeModelMatchesRequested('opus[1m]', { model_id: 'opus[1m]', context_window_size: 200000 }, models), false);
  assert.equal(claudeModelMatchesRequested('opus[1m]', { model_id: 'opus', context_window_size: 1000000 }, models), true);
});
