import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { IngestQueue } from '../src/lib/ingest-queue.js';
import { IngestHandler } from '../src/lib/ingest-handler.js';
import { SpoolDrainer } from '../src/lib/spool-drainer.js';

const HOOK_SCRIPT = path.resolve('src/lib/hook-ingest.cjs');

function blockFor(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* deliberately hold the loop */ }
}

function eventBody(n) {
  return { ingest_id: `evt-${n}`, hook_event_name: 'PostToolUse', session_id: 's1' };
}

function until(cond, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('until() timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function makeHandler(queue) {
  const store = {
    insertEvent: () => ({ inserted: true }),
    upsertSourceHealth: () => {}
  };
  const sanitizer = {
    sanitizeHookPayload: (_name, body) => ({
      session_id: body.session_id,
      summary: 'Bash: echo',
      duration_ms: 1,
      metadata: '{}'
    })
  };
  const handler = new IngestHandler(store, sanitizer, null, {});
  if (queue) handler.attachQueue(queue);
  return handler;
}

async function withServer(routes, fn) {
  const server = http.createServer((req, res) => {
    const route = routes[new URL(req.url, 'http://x').pathname];
    if (route) route(req, res);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

// Stub store with real ingest_id dedup semantics, for driving the real
// SpoolDrainer in round-trip tests.
function dedupStore() {
  const seen = new Set();
  return {
    inserts: seen,
    insertEvent: event => {
      if (seen.has(event.ingest_id)) return { inserted: false };
      seen.add(event.ingest_id);
      return { inserted: true };
    },
    upsertSourceHealth: () => {}
  };
}

test('queue ACKs before processing: push returns immediately, drain runs off-tick (#260)', async () => {
  const processed = [];
  const queue = new IngestQueue({ process: body => processed.push(body.ingest_id) });
  const handler = makeHandler(queue);

  await withServer({ '/ingest': (req, res) => handler.handle(req, res) }, async base => {
    const resp = await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(eventBody(1))
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { ok: true, queued: true });
  });

  // Direct push is synchronous and never invokes processFn on the same tick.
  assert.equal(queue.push(eventBody(2)), true);
  assert.ok(processed.length <= 1, 'second event must not process synchronously on push');

  await until(() => queue.snapshot().processed_total === 2);
  assert.deepEqual(processed, ['evt-1', 'evt-2']);
});

test('queue preserves FIFO order across batch boundaries (#260)', async () => {
  const processed = [];
  const queue = new IngestQueue({ process: body => processed.push(body.ingest_id), batchSize: 5 });
  const ids = [];
  for (let i = 0; i < 12; i++) {
    ids.push(`evt-${i}`);
    queue.push(eventBody(i));
  }
  await until(() => queue.snapshot().processed_total === 12);
  assert.deepEqual(processed, ids);
  assert.equal(queue.depth, 0);
  assert.equal(queue.snapshot().max_depth_seen, 12);
});

test('HTTP stays responsive while 100 blocking events drain (#260)', async () => {
  const queue = new IngestQueue({ process: () => blockFor(5), batchSize: 5 });

  await withServer({
    '/ping': (_req, res) => { res.writeHead(200); res.end('pong'); }
  }, async base => {
    for (let i = 0; i < 100; i++) queue.push(eventBody(i));
    // 100 events x 5ms each = ~500ms of synchronous work. With batch yields,
    // a concurrent request must complete long before the queue is empty.
    const resp = await fetch(`${base}/ping`);
    assert.equal(resp.status, 200);
    const { processed_total } = queue.snapshot();
    assert.ok(processed_total < 100,
      `ping resolved only after full drain (processed=${processed_total}) — batches are not yielding`);
    await until(() => queue.snapshot().processed_total === 100);
  });
});

test('full queue answers 503 queue_full so the hook falls back to its spool (#260)', async () => {
  // maxDepth boundary at queue level: third push over a depth-2 queue refuses.
  const idle = new IngestQueue({ process: () => {}, maxDepth: 2 });
  idle.draining = true; // hold the drain so depth is deterministic
  assert.equal(idle.push(eventBody(1)), true);
  assert.equal(idle.push(eventBody(2)), true);
  assert.equal(idle.push(eventBody(3)), false);
  assert.equal(idle.snapshot().dropped_total, 1);
  idle.draining = false;

  // Handler level: a refused push surfaces as HTTP 503 { error: 'queue_full' }.
  const full = new IngestQueue({ process: () => {}, maxDepth: 0 });
  const handler = makeHandler(full);
  await withServer({ '/ingest': (req, res) => handler.handle(req, res) }, async base => {
    const resp = await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(eventBody(1))
    });
    assert.equal(resp.status, 503);
    assert.deepEqual(await resp.json(), { error: 'queue_full' });
  });
});

test('shutdown dump round-trips through the real SpoolDrainer with ingest_id dedup (#260)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-queue-'));
  const config = { dataDir };
  const store = dedupStore();
  const sanitizer = {
    sanitizeHookPayload: (_name, body) => ({
      session_id: body.session_id, summary: 's', duration_ms: 1, metadata: '{}'
    })
  };
  const drainer = new SpoolDrainer(store, sanitizer, config);

  const queue = new IngestQueue({ process: () => {}, spoolPath: drainer.spoolPath });
  // Pushing schedules a drain on the next tick; dumping on the same tick
  // models shutdown racing ahead of processing.
  for (let i = 0; i < 4; i++) queue.push(eventBody(i));
  assert.equal(queue.dumpToSpool(), 4);
  assert.equal(queue.depth, 0);

  const first = drainer.drainToDb();
  assert.equal(first.processed, 4);
  assert.equal(first.errors, 0);
  assert.equal(store.inserts.size, 4);

  // Replaying the same events (e.g. hook spooled a 503'd event the queue had
  // already seen) must dedup on ingest_id, not double-insert.
  for (let i = 0; i < 4; i++) queue.push(eventBody(i));
  queue.dumpToSpool();
  const second = drainer.drainToDb();
  assert.equal(second.processed, 0);
  assert.equal(second.duplicates, 4);
  assert.equal(store.inserts.size, 4);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('backpressure end-to-end: real hook spools on 503 and the drainer replays it (#260)', async () => {
  // Full chain with the production pieces: hook-ingest.cjs posts → handler
  // with a full queue answers 503 → hook appends to its spool → SpoolDrainer
  // replays into the store. No stubs on the durability path.
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-queue-e2e-'));
  const dataDir = path.join(zylosDir, 'components', 'dashboard');
  fs.mkdirSync(path.join(dataDir, 'spool'), { recursive: true });

  const fullQueue = new IngestQueue({ process: () => {}, maxDepth: 0 });
  const handler = makeHandler(fullQueue);

  await withServer({ '/api/ingest': (req, res) => handler.handle(req, res) }, async base => {
    const { port } = new URL(base);
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: Number(port) }));

    const hook = await new Promise(resolve => {
      const child = spawn('node', [HOOK_SCRIPT], {
        // Widen the hook's suicide timer and POST abort so a loaded test
        // machine can't pre-empt the POST→503→spool chain this test exists
        // to prove (the 500ms/200ms production defaults raced node startup).
        env: {
          ...process.env,
          ZYLOS_DIR: zylosDir,
          ZYLOS_HOOK_EXIT_MS: '15000',
          ZYLOS_HOOK_POST_TIMEOUT_MS: '5000'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      child.on('close', code => resolve({ code }));
      child.stdin.write(JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: 'e2e-session',
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' }
      }));
      child.stdin.end();
    });
    assert.equal(hook.code, 0);
  });

  assert.equal(fullQueue.snapshot().dropped_total, 1, 'handler must have refused the push');

  const store = dedupStore();
  const sanitizer = {
    sanitizeHookPayload: (_name, body) => ({
      session_id: body.session_id, summary: 's', duration_ms: 1, metadata: '{}'
    })
  };
  const drainer = new SpoolDrainer(store, sanitizer, { dataDir });
  const spooled = fs.readFileSync(drainer.spoolPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(spooled.length, 1, '503 must land exactly one record in the hook spool');
  assert.equal(JSON.parse(spooled[0]).hook_event_name, 'PostToolUse');

  const result = drainer.drainToDb();
  assert.equal(result.processed, 1);
  assert.equal(result.errors, 0);
  assert.equal(store.inserts.size, 1);

  fs.rmSync(zylosDir, { recursive: true, force: true });
});

test('processing failure routes the event to the spool for replay (#260)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-queue-'));
  const store = dedupStore();
  const sanitizer = {
    sanitizeHookPayload: (_name, body) => ({
      session_id: body.session_id, summary: 's', duration_ms: 1, metadata: '{}'
    })
  };
  const drainer = new SpoolDrainer(store, sanitizer, { dataDir });

  const logs = [];
  const queue = new IngestQueue({
    process: body => { if (body.ingest_id === 'evt-1') throw new Error('boom'); },
    spoolPath: drainer.spoolPath,
    log: line => logs.push(line)
  });
  for (let i = 0; i < 3; i++) queue.push(eventBody(i));
  await until(() => {
    const s = queue.snapshot();
    return s.processed_total + s.failed_total === 3;
  });
  assert.equal(queue.snapshot().failed_total, 1);
  assert.ok(logs.some(l => l.includes('process error')));

  // Only the failed body lands in the spool, and the drainer replays it.
  const lines = fs.readFileSync(drainer.spoolPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).ingest_id, 'evt-1');
  const result = drainer.drainToDb();
  assert.equal(result.processed, 1);
  assert.ok(store.inserts.has('evt-1'));

  fs.rmSync(dataDir, { recursive: true, force: true });
});
