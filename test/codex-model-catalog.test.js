import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getActionsMeta, handleAction } from '../src/lib/actions.js';
import { getCodexModels, codexEffortsForModel } from '../src/lib/codex-models.js';
import { codexRuntimeFields } from '../src/lib/runtime-info.js';

test('runtime identity and effort do not borrow configuration or catalog defaults', () => {
  assert.deepEqual(codexRuntimeFields(null, { model: 'gpt-5.6-sol', effort: 'high' }), {
    model: null, model_id: null, effort: null, service_tier: null,
    configured_model: 'gpt-5.6-sol', configured_effort: 'high',
  });
  const fields = codexRuntimeFields({ model_id: 'relay-custom', reasoning_effort: 'max', service_tier: 'priority' }, {
    model: 'gpt-5.6-sol', effort: 'low',
  });
  assert.equal(fields.model, 'relay-custom');
  assert.equal(fields.model_id, 'relay-custom');
  assert.equal(fields.effort, 'max');
  assert.equal(fields.service_tier, 'priority');
});

test('catalog is independent of cache existence, corruption and replacement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-catalog-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try {
    const expected = getActionsMeta({ runtime: 'codex', zylosDir: dir }, {});
    assert.equal(expected.current_model, null);
    assert.equal(expected.current_effort, null);
    for (const contents of ['{broken', JSON.stringify({ models: [{ slug: 'fake', supported_reasoning_levels: [{ effort: 'invented' }] }] })]) {
      fs.writeFileSync(path.join(dir, 'models_cache.json'), contents);
      assert.deepEqual(getActionsMeta({ runtime: 'codex', zylosDir: dir }, {}), expected);
    }
    assert.deepEqual(codexEffortsForModel('fake'), []);
    const models = getCodexModels();
    models[0].efforts.push('invented');
    assert.ok(!codexEffortsForModel(models[0].id).includes('invented'));
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown or unset configured model rejects effort mutation without writing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-unknown-effort-'));
  try {
    fs.mkdirSync(path.join(dir, '.codex'));
    const configPath = path.join(dir, '.codex', 'config.toml');
    for (const model of [null, 'relay-custom']) {
      const original = model ? `model = "${model}"\n` : '# unset\n';
      fs.writeFileSync(configPath, original);
      const result = await handleAction('switch-effort', { effort: model ? 'max' : 'high' }, { runtime: 'codex', zylosDir: dir });
      assert.equal(result.error, 'unknown_model_capabilities');
      assert.equal(fs.readFileSync(configPath, 'utf8'), original);
      const meta = getActionsMeta({ runtime: 'codex', zylosDir: dir }, { model_id: 'runtime-custom', effort: 'ultra' });
      assert.equal(meta.current_model, model);
      assert.equal(meta.current_effort, null);
      assert.equal(meta.running_effort, 'ultra');
      assert.deepEqual(meta.efforts_by_model['runtime-custom'], []);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('production source has no client model cache reader', () => {
  const root = new URL('../src/', import.meta.url);
  for (const entry of fs.readdirSync(root, { recursive: true })) {
    if (!/\.(?:js|cjs)$/.test(entry)) continue;
    assert.doesNotMatch(fs.readFileSync(new URL(entry, root), 'utf8'), /models_cache\.json|readCodexModels/);
  }
});
