import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getActionsMeta, handleAction } from '../src/lib/actions.js';

async function withCodexHome(fn) {
  const prev = process.env.CODEX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-codex-actions-'));
  process.env.CODEX_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('getActionsMeta exposes model and effort controls for Codex runtime', () => withCodexHome((dir) => {
  fs.writeFileSync(path.join(dir, 'config.toml'), 'model = "gpt-5.4"\nmodel_reasoning_effort = "high"\n');
  fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify({
    models: [{
      slug: 'gpt-5.4',
      visibility: 'list',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }]
    }]
  }));

  const meta = getActionsMeta({ runtime: 'codex', codex_new_session_threshold: '75' }, {});

  assert.equal(meta.runtime, 'codex');
  assert.deepEqual(meta.models, [{ id: 'gpt-5.4' }]);
  assert.deepEqual(meta.efforts_by_model['gpt-5.4'], ['low', 'medium', 'high']);
  assert.equal(meta.current_model, 'gpt-5.4');
  assert.equal(meta.current_effort, 'high');
  assert.equal(meta.new_session_threshold, 75);
}));

test('getActionsMeta keeps Claude model and effort controls for Claude runtime', () => {
  const meta = getActionsMeta(
    { runtime: 'claude', new_session_threshold: '36', zylosDir: '/tmp/zylos-dashboard-missing' },
    { effort: 'medium' }
  );

  assert.equal(meta.runtime, 'claude');
  assert.ok(meta.models.length > 0);
  assert.ok(Object.keys(meta.efforts_by_model).length > 0);
  assert.equal(meta.current_effort, 'medium');
  assert.equal(meta.new_session_threshold, 36);
});

test('handleAction stores Codex model and effort in config.toml', async () => {
  await withCodexHome(async (dir) => {
    fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify({
      models: [{
        slug: 'gpt-5.5',
        visibility: 'list',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'xhigh' }]
      }]
    }));

    const modelResult = await handleAction('switch-model', { model: 'gpt-5.5' }, { runtime: 'codex' });
    assert.equal(modelResult.ok, true);
    const effortResult = await handleAction('switch-effort', { effort: 'xhigh' }, { runtime: 'codex' });
    assert.equal(effortResult.ok, true);

    const config = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
    assert.match(config, /^model = "gpt-5\.5"$/m);
    assert.match(config, /^model_reasoning_effort = "xhigh"$/m);
  });
});

test('handleAction upgrades Codex CLI under Codex runtime', async () => {
  const prevPath = process.env.PATH;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-codex-upgrade-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  const marker = path.join(dir, 'updated.txt');
  const codexBin = path.join(binDir, 'codex');
  fs.writeFileSync(codexBin, `#!/bin/sh\nif [ "$1" = "update" ]; then echo updated > ${JSON.stringify(marker)}; echo "codex updated"; exit 0; fi\nexit 2\n`);
  fs.chmodSync(codexBin, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;

  try {
    const result = await handleAction('upgrade-cc', {}, { runtime: 'codex' });
    assert.equal(result.ok, true);
    assert.equal(result.messageKey, 'result.codex_updated');
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'updated');
  } finally {
    process.env.PATH = prevPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
