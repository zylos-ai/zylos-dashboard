import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConversationCollector } from '../src/lib/collectors/conversation-collector.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'conv-collector-test-'));
}

function makeJsonlLine(uuid, opts = {}) {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: opts.timestamp || '2026-05-17T10:00:00.000Z',
    sessionId: opts.sessionId || 'test-session-123',
    message: {
      model: opts.model || 'claude-opus-4-6',
      content: opts.content || [{ type: 'text', text: 'Hello world' }],
      usage: opts.usage ?? {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 2000
      }
    }
  });
}

function makeMockStore() {
  const metrics = [];
  const events = [];
  const health = {};
  return {
    metrics,
    events,
    health,
    insertEvent(event) {
      const exists = events.find(e => e.ingest_id === event.ingest_id);
      if (exists) return { inserted: false };
      events.push(event);
      return { inserted: true, event_seq: events.length };
    },
    insertMetric(point) {
      metrics.push(point);
    },
    upsertSourceHealth(name, signalType, status, extra) {
      health[`${name}:${signalType}`] = { status, extra };
    },
    db: {
      prepare(sql) {
        return {
          get(param) {
            if (sql.includes('byte_offset')) return null;
            if (sql.includes('jsonl_usage')) {
              // Check if this uuid exists in metrics
              if (param && typeof param === 'string') {
                const uuidMatch = param.match(/"uuid":"([^"]+)"/);
                if (uuidMatch) {
                  const uuid = uuidMatch[1];
                  const exists = metrics.find(m =>
                    m.source === 'jsonl_usage' &&
                    m.metric_name === 'api_request_tokens' &&
                    m.dimensions?.uuid === uuid
                  );
                  return exists ? { '1': 1 } : undefined;
                }
              }
              return undefined;
            }
            return { seq: 0 };
          }
        };
      }
    }
  };
}

function makeCollector(store, tmpDir, sessionId = 'test-session-123') {
  const config = {
    zylosDir: tmpDir,
    homeDir: tmpDir,
    modelPrices: {
      'claude-opus-4': { input: 5, output: 25, cacheRead: 0.50, cacheCreation: 10 },
      'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.30, cacheCreation: 6 }
    }
  };
  const stateEngine = { getCurrentSessionId: () => sessionId };
  const collector = new ConversationCollector(store, config, { stateEngine });

  const zylosResolved = fs.realpathSync(tmpDir);
  const projectSlug = '-' + zylosResolved.replace(/\//g, '-').replace(/^-/, '');
  const projectDir = path.join(tmpDir, '.claude', 'projects', projectSlug);
  fs.mkdirSync(projectDir, { recursive: true });

  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
  return { collector, config, jsonlPath, projectDir };
}

test('extracts usage metrics from assistant messages', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  fs.writeFileSync(jsonlPath, makeJsonlLine('uuid-1') + '\n');
  collector.collect();

  const tokenMetrics = store.metrics.filter(m => m.metric_name === 'api_request_tokens');
  assert.equal(tokenMetrics.length, 1);
  assert.equal(tokenMetrics[0].metric_value, 100 + 5000 + 2000); // totalInput
  assert.equal(tokenMetrics[0].dimensions.input, 100);
  assert.equal(tokenMetrics[0].dimensions.output, 50);
  assert.equal(tokenMetrics[0].dimensions.cache_read, 5000);
  assert.equal(tokenMetrics[0].dimensions.cache_creation, 2000);
  assert.equal(tokenMetrics[0].dimensions.model, 'claude-opus-4-6');
  assert.equal(tokenMetrics[0].dimensions.uuid, 'uuid-1');

  const costMetrics = store.metrics.filter(m => m.metric_name === 'api_request_cost');
  assert.equal(costMetrics.length, 1);
  // (100 * 5 + 50 * 25 + 5000 * 0.50 + 2000 * 10) / 1_000_000
  const expectedCost = (500 + 1250 + 2500 + 20000) / 1_000_000;
  assert.ok(Math.abs(costMetrics[0].metric_value - expectedCost) < 0.000001);

  const cacheMetrics = store.metrics.filter(m => m.metric_name === 'cache_hit_rate');
  assert.equal(cacheMetrics.length, 1);
  assert.ok(Math.abs(cacheMetrics[0].metric_value - 5000 / 7100) < 0.0001);

  fs.rmSync(tmpDir, { recursive: true });
});

test('extracts usage even when no text content (tool_use only)', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  const line = makeJsonlLine('uuid-2', {
    content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }],
    usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 }
  });
  fs.writeFileSync(jsonlPath, line + '\n');
  collector.collect();

  const tokenMetrics = store.metrics.filter(m => m.metric_name === 'api_request_tokens');
  assert.equal(tokenMetrics.length, 1);
  assert.equal(tokenMetrics[0].metric_value, 200 + 1000 + 500);

  // No assistant_message event since there's no text
  assert.equal(store.events.length, 0);

  fs.rmSync(tmpDir, { recursive: true });
});

test('assistant summaries redact before truncation', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);
  const text = `${'x'.repeat(430)} sk-abcdefghijklmnopqrstuvwxyz123456 user@example.com ${'tail '.repeat(80)}`;

  fs.writeFileSync(jsonlPath, makeJsonlLine('uuid-redact-summary', {
    content: [{ type: 'text', text }]
  }) + '\n');
  collector.collect();

  assert.equal(store.events.length, 1);
  assert.ok(store.events[0].summary.length <= 500);
  assert.ok(!store.events[0].summary.includes('sk-'));
  assert.ok(!store.events[0].summary.includes('user@example.com'));
  assert.ok(store.events[0].summary.includes('[REDACTED]'));
  assert.ok(store.events[0].summary.includes('[EMAIL]'));

  fs.rmSync(tmpDir, { recursive: true });
});

test('does not double-count on re-read of same data', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  fs.writeFileSync(jsonlPath, makeJsonlLine('uuid-3') + '\n');
  collector.collect();
  collector.collect(); // second call should not duplicate

  const tokenMetrics = store.metrics.filter(m => m.metric_name === 'api_request_tokens');
  assert.equal(tokenMetrics.length, 1);

  fs.rmSync(tmpDir, { recursive: true });
});

test('offset persistence prevents duplication on restart', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  fs.writeFileSync(jsonlPath, makeJsonlLine('uuid-4') + '\n');
  collector.collect();

  assert.equal(store.metrics.filter(m => m.metric_name === 'api_request_tokens').length, 1);

  // Simulate restart: create new collector with same store (which has persisted offset)
  const persistedOffset = store.health['conversation_reader:byte_offset'];
  assert.ok(persistedOffset);
  assert.ok(persistedOffset.extra.offset > 0);

  // New collector that reads the persisted offset
  const store2 = makeMockStore();
  store2.db = {
    prepare(sql) {
      return {
        get(param) {
          if (sql.includes('byte_offset')) {
            return { extra: JSON.stringify(persistedOffset.extra) };
          }
          if (sql.includes('jsonl_usage')) return undefined;
          return { seq: 0 };
        }
      };
    }
  };
  const { collector: collector2 } = makeCollector(store2, tmpDir);
  collector2._restoreOffset();
  collector2.collect();

  // No new metrics since offset was restored past existing data
  assert.equal(store2.metrics.filter(m => m.metric_name === 'api_request_tokens').length, 0);

  fs.rmSync(tmpDir, { recursive: true });
});

test('uuid dedup prevents double-counting on crash recovery replay', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  fs.writeFileSync(jsonlPath, makeJsonlLine('uuid-replay') + '\n');
  collector.collect();

  assert.equal(store.metrics.filter(m => m.metric_name === 'api_request_tokens').length, 1);

  // Simulate crash recovery: offset NOT persisted (simulating crash before persist)
  // Create new collector at offset 0 (as if no offset was saved)
  const store2 = makeMockStore();
  // Pre-seed store2's metrics with existing data (simulating DB survived the crash)
  store2.metrics.push(...store.metrics);
  store2.db = {
    prepare(sql) {
      return {
        get(param) {
          if (sql.includes('byte_offset')) return null; // no persisted offset (crash)
          if (sql.includes('jsonl_usage')) {
            // Check against pre-seeded metrics
            if (param && typeof param === 'string') {
              const uuidMatch = param.match(/"uuid":"([^"]+)"/);
              if (uuidMatch) {
                const uuid = uuidMatch[1];
                const exists = store2.metrics.find(m =>
                  m.source === 'jsonl_usage' &&
                  m.metric_name === 'api_request_tokens' &&
                  m.dimensions?.uuid === uuid
                );
                return exists ? { '1': 1 } : undefined;
              }
            }
            return undefined;
          }
          return { seq: 0 };
        }
      };
    }
  };
  const { collector: collector2 } = makeCollector(store2, tmpDir);
  collector2.collect();

  // uuid-replay should NOT be double-counted because dedup check finds it
  const tokenMetrics = store2.metrics.filter(m => m.metric_name === 'api_request_tokens');
  assert.equal(tokenMetrics.length, 1); // still just 1, not 2

  fs.rmSync(tmpDir, { recursive: true });
});

test('unknown model writes token metrics but skips cost', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  const line = makeJsonlLine('uuid-5', { model: 'claude-unknown-99' });
  fs.writeFileSync(jsonlPath, line + '\n');
  collector.collect();

  const tokenMetrics = store.metrics.filter(m => m.metric_name === 'api_request_tokens');
  assert.equal(tokenMetrics.length, 1);

  const costMetrics = store.metrics.filter(m => m.metric_name === 'api_request_cost');
  assert.equal(costMetrics.length, 0);

  fs.rmSync(tmpDir, { recursive: true });
});

test('handles malformed JSON lines gracefully', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  const content = [
    '{invalid json',
    makeJsonlLine('uuid-6'),
    '',
    '{"type": "user", "uuid": "uuid-7"}',
    makeJsonlLine('uuid-8')
  ].join('\n') + '\n';

  fs.writeFileSync(jsonlPath, content);
  collector.collect();

  const tokenMetrics = store.metrics.filter(m => m.metric_name === 'api_request_tokens');
  assert.equal(tokenMetrics.length, 2); // uuid-6 and uuid-8 only

  fs.rmSync(tmpDir, { recursive: true });
});

test('partial trailing line is not consumed', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  // Write a complete line + an incomplete line (no trailing newline)
  const content = makeJsonlLine('uuid-9') + '\n' + '{"type": "assistant", "incomplete...';
  fs.writeFileSync(jsonlPath, content);
  collector.collect();

  const tokenMetrics = store.metrics.filter(m => m.metric_name === 'api_request_tokens');
  assert.equal(tokenMetrics.length, 1); // only uuid-9

  // Now complete the line
  const completeLine = makeJsonlLine('uuid-10');
  fs.writeFileSync(jsonlPath, makeJsonlLine('uuid-9') + '\n' + completeLine + '\n');
  collector.collect();

  const tokenMetrics2 = store.metrics.filter(m => m.metric_name === 'api_request_tokens');
  assert.equal(tokenMetrics2.length, 2); // uuid-9 + uuid-10

  fs.rmSync(tmpDir, { recursive: true });
});

test('missing usage field does not crash', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  const line = JSON.stringify({
    type: 'assistant',
    uuid: 'uuid-11',
    timestamp: '2026-05-17T10:00:00.000Z',
    sessionId: 'test-session-123',
    message: {
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'No usage field' }]
    }
  });

  fs.writeFileSync(jsonlPath, line + '\n');
  collector.collect();

  // Text event written, no metrics
  assert.equal(store.events.length, 1);
  assert.equal(store.metrics.length, 0);

  fs.rmSync(tmpDir, { recursive: true });
});

test('session file switch resets offset', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();

  const config = {
    zylosDir: tmpDir,
    homeDir: tmpDir,
    modelPrices: {
      'claude-opus-4': { input: 5, output: 25, cacheRead: 0.50, cacheCreation: 10 }
    }
  };

  let currentSession = 'session-a';
  const stateEngine = { getCurrentSessionId: () => currentSession };
  const collector = new ConversationCollector(store, config, { stateEngine });

  const zylosResolved = fs.realpathSync(tmpDir);
  const projectSlug = '-' + zylosResolved.replace(/\//g, '-').replace(/^-/, '');
  const projectDir = path.join(tmpDir, '.claude', 'projects', projectSlug);
  fs.mkdirSync(projectDir, { recursive: true });

  // Write session A
  const pathA = path.join(projectDir, 'session-a.jsonl');
  fs.writeFileSync(pathA, makeJsonlLine('uuid-a1', { sessionId: 'session-a' }) + '\n');
  collector.collect();

  assert.equal(store.metrics.filter(m => m.metric_name === 'api_request_tokens').length, 1);

  // Switch to session B
  currentSession = 'session-b';
  const pathB = path.join(projectDir, 'session-b.jsonl');
  fs.writeFileSync(pathB, makeJsonlLine('uuid-b1', { sessionId: 'session-b' }) + '\n');
  collector.collect();

  assert.equal(store.metrics.filter(m => m.metric_name === 'api_request_tokens').length, 2);

  // Session A data doesn't leak into session B
  const sessionBMetrics = store.metrics.filter(m => m.session_id === 'session-b');
  assert.equal(sessionBMetrics.length, 3); // tokens + cache_hit_rate + cost

  fs.rmSync(tmpDir, { recursive: true });
});

test('cache rate formula: cache_read / (input + cache_read + cache_creation)', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  const line = makeJsonlLine('uuid-rate', {
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 1000
    }
  });
  fs.writeFileSync(jsonlPath, line + '\n');
  collector.collect();

  const cacheMetric = store.metrics.find(m => m.metric_name === 'cache_hit_rate');
  // cache_read / (input + cache_read + cache_creation) = 8000 / (1000 + 8000 + 1000) = 0.8
  assert.ok(Math.abs(cacheMetric.metric_value - 0.8) < 0.0001);

  fs.rmSync(tmpDir, { recursive: true });
});
