import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/lib/store.js';
import { Sanitizer } from '../src/lib/sanitizer.js';
import { CodexRolloutCollector } from '../src/lib/collectors/codex-rollout-collector.js';
import { DEFAULT_CODEX_MODEL_PRICES, DEFAULT_CODEX_PRIORITY_MODEL_PRICES } from '../src/lib/config.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-test-'));
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.resolve('test/fixtures/codex', name), 'utf8'));
}

test('Sanitizer preserves safe Codex locator metadata and strips raw payload fields', () => {
  const raw = fixture('pre-tool-use.json');
  const sanitizer = new Sanitizer('/tmp/zylos');
  const sanitized = sanitizer.sanitizeHookPayload('PreToolUse', raw);

  assert.equal(sanitized.session_id, 'codex-session-1');
  assert.equal(sanitized.metadata.turn_id, 'codex-turn-1');
  assert.equal(sanitized.metadata.transcript_path, '/tmp/zylos-dashboard-codex/rollout-codex-session-1.jsonl');
  assert.equal(sanitized.metadata.model, 'gpt-5.3-codex');
  assert.equal(sanitized.metadata.permission_mode, 'default');
  assert.equal(sanitized.metadata.tool_name, 'functions.exec_command');
  assert.equal(sanitized.metadata.tool_use_id, 'call-1');
  assert.equal(sanitized.metadata.tool_input, undefined);
  assert.equal(sanitized.metadata.prompt, undefined);
});

test('Store persists hook-derived Codex rollout path and cursor', () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'dashboard.db'));

  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: '/tmp/zylos-dashboard-codex/rollout-codex-session-1.jsonl',
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });
  store.upsertCodexRolloutCursor({
    transcriptPath: '/tmp/zylos-dashboard-codex/rollout-codex-session-1.jsonl',
    byteOffset: 42,
    sessionId: 'codex-session-1'
  });

  const mapping = store.latestCodexRolloutPath('codex');
  assert.equal(mapping.session_id, 'codex-session-1');
  assert.equal(mapping.transcript_path, '/tmp/zylos-dashboard-codex/rollout-codex-session-1.jsonl');

  const cursor = store.getCodexRolloutCursor(mapping.transcript_path);
  assert.equal(cursor.byte_offset, 42);
  assert.equal(cursor.session_id, 'codex-session-1');

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector reports unavailable without hook transcript path', () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'dashboard.db'));
  const collector = new CodexRolloutCollector(store, { modelPrices: {} });

  assert.equal(collector.collect(), 0);
  const health = store.getSourceHealth().find(h => h.name === 'codex_rollout');
  assert.equal(health.status, 'unavailable');
  assert.equal(health.extra.reason, 'no_hook_transcript_path');

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector ingests rollout fixture metrics from hook-derived path only', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  fs.copyFileSync(path.resolve('test/fixtures/codex/rollout.jsonl'), rolloutPath);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, {
    modelPrices: {
      'gpt-5.3-codex': { input: 2, output: 8, cacheRead: 0.5, cacheCreation: 2 }
    }
  });

  const written = collector.collect();
  assert.equal(written, 9);

  const context = store.queryMetrics({ name: 'context_pct' });
  assert.equal(context.length, 1);
  assert.equal(context[0].metric_value, 6);
  assert.equal(context[0].source, 'rollout');

  const rate = store.queryMetrics({ name: 'rate_limit' });
  assert.equal(rate[0].metric_value, 37.5);

  const weekly = store.queryMetrics({ name: 'rate_limit_7d' });
  assert.equal(weekly[0].metric_value, 12.25);

  const tokens = store.queryMetrics({ name: 'api_request_tokens' });
  assert.equal(tokens[0].runtime, 'codex');
  assert.equal(tokens[0].metric_value, 15000);
  assert.equal(tokens[0].dimensions.model, 'gpt-5.3-codex');
  assert.equal(tokens[0].dimensions.output, 800);
  assert.equal(tokens[0].dimensions.reasoning, 150);

  const cache = store.queryMetrics({ name: 'cache_hit_rate' });
  assert.equal(cache[0].metric_value, 0.2);

  const cost = store.queryMetrics({ name: 'api_request_cost' });
  assert.equal(cost.length, 1);
  assert.equal(cost[0].confidence, 'estimated');

  const ttft = store.queryMetrics({ name: 'ttft' });
  assert.equal(ttft[0].metric_value, 987);

  const duration = store.queryMetrics({ name: 'turn_duration' });
  assert.equal(duration[0].metric_value, 45123);

  const cursor = store.getCodexRolloutCursor(rolloutPath);
  assert.equal(cursor.byte_offset, fs.statSync(rolloutPath).size);

  assert.equal(collector.collect(), 0);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector backfills rate limits when cursor already passed initial rollout event', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  fs.copyFileSync(path.resolve('test/fixtures/codex/rollout.jsonl'), rolloutPath);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });
  store.upsertCodexRolloutCursor({
    transcriptPath: rolloutPath,
    byteOffset: fs.statSync(rolloutPath).size,
    sessionId: 'codex-session-1'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  assert.equal(collector.collect(), 2);

  const rate = store.queryMetrics({ name: 'rate_limit' });
  assert.equal(rate.length, 1);
  assert.equal(rate[0].metric_value, 37.5);
  const weekly = store.queryMetrics({ name: 'rate_limit_7d' });
  assert.equal(weekly.length, 1);
  assert.equal(weekly[0].metric_value, 12.25);

  assert.equal(collector.collect(), 0);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector skips cost when model price is missing', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  fs.copyFileSync(path.resolve('test/fixtures/codex/rollout.jsonl'), rolloutPath);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  collector.collect();

  assert.equal(store.queryMetrics({ name: 'api_request_tokens' }).length, 1);
  assert.equal(store.queryMetrics({ name: 'api_request_cost' }).length, 0);
  const health = store.getSourceHealth().find(h => h.name === 'codex_cost');
  assert.equal(health.status, 'unavailable');
  assert.equal(health.extra.reason, 'missing_model_price');

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector computes cost from default Codex runtime prices', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const fixtureText = fs.readFileSync(path.resolve('test/fixtures/codex/rollout.jsonl'), 'utf8')
    .replaceAll('gpt-5.3-codex', 'gpt-5.5');
  fs.writeFileSync(rolloutPath, fixtureText);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, {
    runtimeModelPrices: { codex: DEFAULT_CODEX_MODEL_PRICES }
  });
  collector.collect();

  const cost = store.queryMetrics({ name: 'api_request_cost' });
  assert.equal(cost.length, 1);
  assert.equal(cost[0].dimensions.model, 'gpt-5.5');
  assert.ok(Math.abs(cost[0].metric_value - 0.0855) < 0.000001);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector ingests assistant output text into timeline', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const assistantLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:04.000Z',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'I checked the code and found the missing path.' }]
    }
  });
  fs.writeFileSync(rolloutPath, `${assistantLine}\n`);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  let stateEvent = null;
  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  collector._onEvent = (event) => { stateEvent = event; };

  assert.equal(collector.collect(), 1);

  const events = store.queryEvents({ types: ['assistant_message'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].runtime, 'codex');
  assert.equal(events[0].event_type, 'assistant_message');
  assert.equal(events[0].category, 'assistant');
  assert.equal(events[0].summary, 'I checked the code and found the missing path.');
  assert.equal(events[0].metadata.phase, 'commentary');
  assert.equal(stateEvent.summary, events[0].summary);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector ingests user message text into timeline', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const userLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:04.000Z',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Please check the dashboard timeline.' }]
    }
  });
  fs.writeFileSync(rolloutPath, `${userLine}\n`);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  let stateEvent = null;
  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  collector._onEvent = (event) => { stateEvent = event; };

  assert.equal(collector.collect(), 1);

  const events = store.queryEvents({ types: ['user_message'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].runtime, 'codex');
  assert.equal(events[0].event_type, 'user_message');
  assert.equal(events[0].summary, 'Please check the dashboard timeline.');
  assert.equal(stateEvent.summary, events[0].summary);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector uses human-friendly summaries for shell and patch calls', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const shellLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:04.000Z',
    payload: {
      type: 'function_call',
      name: 'functions.exec_command',
      call_id: 'call-shell',
      arguments: JSON.stringify({ cmd: 'npm test', workdir: '/tmp/project' })
    }
  });
  const shellOutputLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:05.000Z',
    payload: { type: 'function_call_output', call_id: 'call-shell', output: 'ok' }
  });
  const patchLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:06.000Z',
    payload: {
      type: 'custom_tool_call',
      name: 'apply_patch',
      call_id: 'call-patch',
      input: '*** Begin Patch\n*** Update File: /Users/howard/zylos/workspace/zylos-dashboard/src/lib/store.js\n@@\n*** Add File: test/new-fixture.js\n+ok\n*** End Patch\n'
    }
  });
  const fallbackLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:07.000Z',
    payload: {
      type: 'function_call',
      name: 'functions.exec_command',
      call_id: 'call-fallback',
      arguments: JSON.stringify({ cmd: 'python scripts/do_custom_thing.py --token sk-abcdefghijklmnopqrstuvwxyz123456 --file /Users/howard/zylos/workspace/zylos-dashboard/src/index.js' })
    }
  });
  fs.writeFileSync(rolloutPath, `${shellLine}\n${shellOutputLine}\n${patchLine}\n${fallbackLine}\n`);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  assert.equal(collector.collect(), 4);

  const events = store.queryEvents({ limit: 10, order: 'asc' });
  assert.deepEqual(events.map(e => e.summary), [
    'Run verification: npm test',
    'Run verification: npm test',
    'Edit files: src/lib/store.js, test/new-fixture.js',
    'Run shell command: python scripts/do_custom_thing.py --token [REDACTED] --file zylos-dashboard/src/index.js'
  ]);
  assert.deepEqual(events.map(e => e.event_type), ['tool_call', 'tool_result', 'tool_call', 'tool_call']);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector computes cost from Codex priority prices when fast tier is recorded', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const fixtureText = fs.readFileSync(path.resolve('test/fixtures/codex/rollout.jsonl'), 'utf8')
    .replace('"model":"gpt-5.3-codex"', '"model":"gpt-5.3-codex","service_tier":"priority"');
  fs.writeFileSync(rolloutPath, fixtureText);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, {
    runtimeModelPrices: { codex: DEFAULT_CODEX_MODEL_PRICES },
    runtimeServiceTierModelPrices: { codex: { priority: DEFAULT_CODEX_PRIORITY_MODEL_PRICES } }
  });
  collector.collect();

  const cost = store.queryMetrics({ name: 'api_request_cost' });
  assert.equal(cost.length, 1);
  assert.equal(cost[0].dimensions.model, 'gpt-5.3-codex');
  assert.equal(cost[0].dimensions.service_tier, 'priority');
  assert.ok(Math.abs(cost[0].metric_value - 0.06545) < 0.000001);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
