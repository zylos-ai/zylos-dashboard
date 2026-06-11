import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateApiKey, hashApiKey } from '../src/lib/auth.js';
import { Store } from '../src/lib/store.js';

function writeConfig(zylosDir, password = 'secret', extra = {}) {
  const configDir = path.join(zylosDir, 'components', 'dashboard');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), `${JSON.stringify({
    auth: {
      enabled: true,
      password
    },
    ...extra
  }, null, 2)}\n`);
}

async function makeServerWithDir(zylosDir) {
  const previousZylosDir = process.env.ZYLOS_DIR;
  const previousPort = process.env.DASHBOARD_PORT;
  process.env.ZYLOS_DIR = zylosDir;
  process.env.DASHBOARD_PORT = '0';

  const moduleUrl = new URL(`../src/index.js?test=${Date.now()}-${Math.random()}`, import.meta.url);
  const { createServer } = await import(moduleUrl.href);

  process.env.ZYLOS_DIR = previousZylosDir;
  process.env.DASHBOARD_PORT = previousPort;
  if (previousZylosDir == null) delete process.env.ZYLOS_DIR;
  if (previousPort == null) delete process.env.DASHBOARD_PORT;

  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    server,
    zylosDir
  };
}

async function makeServer() {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir);
  return makeServerWithDir(zylosDir);
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

function form(body) {
  return new URLSearchParams(body);
}

test('auth protects API and renders proxy-prefixed login URLs', async () => {
  const { origin, server } = await makeServer();
  try {
    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200);

    const unauthed = await fetch(`${origin}/`, { redirect: 'manual' });
    assert.equal(unauthed.status, 302);

    const prefixed = await fetch(`${origin}/`, {
      headers: { 'X-Forwarded-Prefix': '/dashboard' },
      redirect: 'manual'
    });
    assert.equal(prefixed.status, 302);
    assert.equal(prefixed.headers.get('location'), '/dashboard/login?next=%2Fdashboard%2F');

    const login = await fetch(`${origin}/login?next=%2Fdashboard%2F`, {
      headers: { 'X-Forwarded-Prefix': '/dashboard' },
      redirect: 'manual'
    });
    assert.equal(login.status, 200);
    const body = await login.text();
    assert.match(body, /action="\/dashboard\/login"/);
    assert.match(body, /Zylos/);
    assert.match(body, /name="next" value="\/dashboard\/"/);
  } finally {
    await closeServer(server);
  }
});

test('login sets secure cookie and authenticated requests can reach API and SSE', async () => {
  const { origin, server } = await makeServer();
  try {
    const login = await fetch(`${origin}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Forwarded-Prefix': '/dashboard'
      },
      body: form({ password: 'secret', next: '/dashboard/' }),
      redirect: 'manual'
    });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get('location'), '/dashboard/');

    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /__Host-zylos_dashboard_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);

    const health = await fetch(`${origin}/api/health`, {
      headers: { Cookie: cookie }
    });
    assert.equal(health.status, 200);
    const json = await health.json();
    assert.equal(json.ok, true);
  } finally {
    await closeServer(server);
  }
});

test('logout requires same-origin POST and respects forwarded prefix', async () => {
  const { origin, server } = await makeServer();
  try {
    const login = await fetch(`${origin}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ password: 'secret' }),
      redirect: 'manual'
    });
    const cookie = login.headers.get('set-cookie');

    const missingCsrf = await fetch(`${origin}/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual'
    });
    assert.equal(missingCsrf.status, 403);

    const logout = await fetch(`${origin}/logout`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'X-Forwarded-Prefix': '/dashboard'
      },
      redirect: 'manual'
    });
    assert.equal(logout.status, 302);
    assert.equal(logout.headers.get('location'), '/dashboard/login');
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  } finally {
    await closeServer(server);
  }
});

test('unsafe forwarded prefixes fall back to direct root paths', async () => {
  const { origin, server } = await makeServer();
  try {
    const login = await fetch(`${origin}/login`, {
      headers: { 'X-Forwarded-Prefix': '/dashboard?next=//evil.test' },
      redirect: 'manual'
    });
    assert.equal(login.status, 200);
    const body = await login.text();
    assert.match(body, /action="\/login"/);
    assert.match(body, /Zylos/);
    assert.doesNotMatch(body, /evil\.test/);
  } finally {
    await closeServer(server);
  }
});

test('session cookie survives server restart (SQLite persistence)', async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir);

  const { origin: origin1, server: server1 } = await makeServerWithDir(zylosDir);
  let cookie;
  try {
    const login = await fetch(`${origin1}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ password: 'secret' }),
      redirect: 'manual'
    });
    assert.equal(login.status, 302);
    cookie = login.headers.get('set-cookie');
    assert.ok(cookie);

    const api1 = await fetch(`${origin1}/api/state`, { headers: { Cookie: cookie } });
    assert.equal(api1.status, 200);
  } finally {
    await closeServer(server1);
  }

  const { origin: origin2, server: server2 } = await makeServerWithDir(zylosDir);
  try {
    const api2 = await fetch(`${origin2}/api/state`, { headers: { Cookie: cookie } });
    assert.equal(api2.status, 200, 'session should survive restart');

    const unauthed = await fetch(`${origin2}/api/state`);
    assert.equal(unauthed.status, 401, 'request without cookie should be rejected');
  } finally {
    await closeServer(server2);
  }
});

test('/api/state exposes stable agent identity without fleet secrets', async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir, 'secret', {
    auth: { enabled: false },
    agent: { name: 'Jinglever', id: 'jinglever-main' },
    fleet: {
      agents: [
        {
          name: 'Remote',
          base_url: 'https://remote.example.test/dashboard',
          read_api_key: 'zylos_ak_secret'
        }
      ]
    }
  });

  const { origin, server } = await makeServerWithDir(zylosDir);
  try {
    const resp = await fetch(`${origin}/api/state`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.agent.name, 'Jinglever');
    assert.equal(body.agent.id, 'jinglever-main');
    // Identity now also carries the deterministic mascot tint color/hue.
    assert.equal(typeof body.agent.color, 'string');
    assert.equal(typeof body.agent.hue, 'number');
    assert.equal(typeof body.new_session_threshold, 'number');
    assert.ok(body.runtime_info && typeof body.runtime_info === 'object');
    assert.ok(body.system_metrics && typeof body.system_metrics === 'object');
    assert.ok(Object.hasOwn(body.system_metrics, 'cpu_pct'));
    assert.ok(Object.hasOwn(body.system_metrics, 'mem_pct'));
    assert.ok(Object.hasOwn(body.system_metrics, 'disk_pct'));
    assert.ok(Object.hasOwn(body, 'session_cost'));
    assert.ok(Object.hasOwn(body, 'daily_cost'));
    assert.ok(Object.hasOwn(body, 'weekly_cost'));
    assert.ok(Object.hasOwn(body, 'context_pct'));
    assert.equal(JSON.stringify(body).includes('zylos_ak_secret'), false);
    assert.equal(JSON.stringify(body).includes('read_api_key'), false);
  } finally {
    await closeServer(server);
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('/api/fleet self record includes cost tiers from DB (#174)', async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir, 'secret', { auth: { enabled: false } });

  const { origin, server } = await makeServerWithDir(zylosDir);
  try {
    const dbPath = path.join(zylosDir, 'components', 'dashboard', 'dashboard.db');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO metric_points (timestamp, metric_name, metric_value, dimensions, source, confidence)
      VALUES (?, 'usage_event', 1000, ?, 'jsonl_usage', 'actual')`).run(now, JSON.stringify({ cost: 2.34 }));
    db.close();

    const resp = await fetch(`${origin}/api/fleet`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    const self = body.agents.find(a => a.self === true);
    assert.ok(self, 'self record must exist');
    assert.equal(typeof self.daily_cost, 'number');
    assert.ok(self.daily_cost > 0, `daily_cost should be positive, got ${self.daily_cost}`);
  } finally {
    await closeServer(server);
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('/api/stream accepts Bearer API session and emits initial fleet_state', async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir, 'secret', {
    auth: { enabled: true, password: 'secret' },
    agent: { name: 'Jinglever' }
  });

  const { origin, server } = await makeServerWithDir(zylosDir);
  try {
    const dbPath = path.join(zylosDir, 'components', 'dashboard', 'dashboard.db');
    const store = new Store(dbPath);
    const apiKey = generateApiKey();
    store.insertApiKey({ name: 'test-key', keyHash: hashApiKey(apiKey), scope: 'read' });
    store.close();

    const tokenResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    assert.equal(tokenResp.status, 200);
    const { token } = await tokenResp.json();

    const controller = new AbortController();
    const streamResp = await fetch(`${origin}/api/stream`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    assert.equal(streamResp.status, 200);
    const reader = streamResp.body.getReader();
    const decoder = new TextDecoder();
    let body = '';
    while (!body.includes('event: fleet_state')) {
      const { value, done } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
    controller.abort();
    try { reader.releaseLock(); } catch { /* already released */ }
    assert.match(body, /event: fleet_state/);
    const dataLine = body.split('\n').find(line => line.startsWith('data: '));
    assert.ok(dataLine, 'fleet_state should include a data line');
    const payload = JSON.parse(dataLine.slice('data: '.length));
    assert.equal(payload.agent.name, 'Jinglever');
    assert.ok(Object.hasOwn(payload, 'context_pct'));
    assert.ok(Object.hasOwn(payload, 'session_cost'));
    assert.ok(Object.hasOwn(payload, 'system_metrics'));
    assert.equal(body.includes(apiKey), false);
    assert.equal(body.includes(token), false);
  } finally {
    await closeServer(server);
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('proxied remote writes require consumer admin API scope or browser session', async () => {
  let actionHits = 0;
  const remote = await listen((req, res) => {
    if (req.url === '/api/auth/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        token: 'zylos_st_remote_admin',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        scope: 'admin'
      }));
      return;
    }
    if (req.url === '/api/actions/interrupt') {
      actionHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir, 'secret', {
    auth: { enabled: true, password: 'secret' },
    fleet: {
      agents: [
        { name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_remote' }
      ]
    }
  });

  const { origin, server } = await makeServerWithDir(zylosDir);
  try {
    const dbPath = path.join(zylosDir, 'components', 'dashboard', 'dashboard.db');
    const store = new Store(dbPath);
    const readKey = generateApiKey();
    const adminKey = generateApiKey();
    store.insertApiKey({ name: 'read-key', keyHash: hashApiKey(readKey), scope: 'read' });
    store.insertApiKey({ name: 'admin-key', keyHash: hashApiKey(adminKey), scope: 'admin' });
    store.close();

    const readTokenResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readKey}` }
    });
    const adminTokenResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}` }
    });
    const { token: readToken } = await readTokenResp.json();
    const { token: adminToken } = await adminTokenResp.json();

    const readWrite = await fetch(`${origin}/fleet/Remote/api/actions/interrupt`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readToken}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    assert.equal(readWrite.status, 403);
    assert.deepEqual(await readWrite.json(), { error: 'insufficient_scope', required: 'admin' });
    assert.equal(actionHits, 0);

    const adminWrite = await fetch(`${origin}/fleet/Remote/api/actions/interrupt`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    assert.equal(adminWrite.status, 200);
    assert.equal(actionHits, 1);

    const login = await fetch(`${origin}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ password: 'secret', next: '/' }),
      redirect: 'manual'
    });
    const cookie = login.headers.get('set-cookie');
    const browserWrite = await fetch(`${origin}/fleet/Remote/api/actions/interrupt`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    assert.equal(browserWrite.status, 200);
    assert.equal(actionHits, 2);
  } finally {
    await closeServer(server);
    await remote.close();
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('/api/fleet exposes safe records without registry secrets', async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir, 'secret', {
    auth: { enabled: false },
    fleet: {
      agents: [
        {
          name: 'Remote',
          base_url: 'https://remote.example.test/dashboard',
          read_api_key: 'zylos_ak_secret'
        }
      ]
    }
  });

  const { origin, server } = await makeServerWithDir(zylosDir);
  try {
    const resp = await fetch(`${origin}/api/fleet`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    // Self record is always injected first, followed by external agents.
    assert.equal(body.count, 2);
    assert.equal(body.agents[0].self, true);
    assert.equal(body.agents[1].self, false);
    assert.equal(body.agents[1].name, 'Remote');
    assert.equal(body.agents[1].health_reason, 'not_polled');
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('zylos_ak_secret'), false);
    assert.equal(serialized.includes('read_api_key'), false);
    assert.equal(serialized.includes('read_session_token'), false);
  } finally {
    await closeServer(server);
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('ingest endpoints reject proxied requests', async () => {
  const { origin, server } = await makeServer();
  try {
    // Direct local request (no proxy header) should be accepted
    const direct = await fetch(`${origin}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'Stop', ingest_id: 'test-1' })
    });
    assert.equal(direct.status, 200);

    // Proxied request (with X-Forwarded-Prefix) should be rejected
    const proxied = await fetch(`${origin}/api/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Prefix': '/dashboard'
      },
      body: JSON.stringify({ hook_event_name: 'Stop', ingest_id: 'test-2' })
    });
    assert.equal(proxied.status, 404, 'proxied ingest should be rejected');

    // Same for statusline endpoint
    const proxiedSl = await fetch(`${origin}/api/ingest/statusline`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Prefix': '/dashboard'
      },
      body: JSON.stringify({ metrics: [] })
    });
    assert.equal(proxiedSl.status, 404, 'proxied statusline ingest should be rejected');
  } finally {
    await closeServer(server);
  }
});
