import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { publicDir } from '../src/lib/config.js';
import { FleetProxy } from '../src/lib/fleet-proxy.js';

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

test('fleet proxy serves hub static frontend under agent prefix without secrets', async () => {
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: 'http://remote.invalid', read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/`);
    assert.equal(resp.status, 200);
    const body = await resp.text();
    assert.match(body, /\/fleet\/Remote\/_assets/);
    assert.equal(body.includes('zylos_ak_secret'), false);
    assert.equal(body.includes('zylos_st_secret'), false);
  } finally {
    await hub.close();
  }
});

test('fleet proxy prefixes rewritten paths with the reverse-proxy base path (#159)', async () => {
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: 'http://remote.invalid', read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    // Caddy forwards /dashboard/fleet/Remote/ as /fleet/Remote/ with this header.
    const resp = await fetch(`${hub.origin}/fleet/Remote/`, {
      headers: { 'x-forwarded-prefix': '/dashboard' }
    });
    assert.equal(resp.status, 200);
    const body = await resp.text();
    // Browser-facing asset/API paths must carry the /dashboard prefix so the
    // browser requests stay under /dashboard/* (the only route Caddy proxies).
    assert.match(body, /\/dashboard\/fleet\/Remote\/_assets/);
    // And must NOT emit the bare /fleet/Remote/_assets path that 404s at root.
    assert.equal(/["'(]\/fleet\/Remote\/_assets/.test(body), false);
  } finally {
    await hub.close();
  }
});

test('fleet proxy injects session token for API and keeps token out of client response', async () => {
  let seenAuth = null;
  const remote = await listen((req, res) => {
    seenAuth = req.headers.authorization;
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'bad=secret' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/state?x=1`);
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('set-cookie'), null);
    assert.equal(seenAuth, 'Bearer zylos_st_secret');
    const body = await resp.text();
    assert.match(body, /"ok":true/);
    assert.equal(body.includes('zylos_st_secret'), false);
    assert.equal(body.includes('zylos_ak_secret'), false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy blocks reflected session token in proxied response body', async () => {
  const remote = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ reflected: req.headers.authorization }));
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_reflected_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/debug-echo`);
    assert.equal(resp.status, 502);
    const body = await resp.text();
    assert.match(body, /secret_leak_blocked/);
    assert.equal(body.includes('Bearer'), false);
    assert.equal(body.includes('zylos_st_'), false);
    assert.equal(body.includes('zylos_ak_'), false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy blocks reflected session token in proxied response headers', async () => {
  const remote = await listen((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-echo-auth': req.headers.authorization
    });
    res.end(JSON.stringify({ ok: true }));
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'opaque-session-token' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/header-echo`);
    assert.equal(resp.status, 502);
    assert.equal(resp.headers.get('x-echo-auth'), null);
    const body = await resp.text();
    assert.match(body, /secret_leak_blocked/);
    assert.equal(body.includes('opaque-session-token'), false);
    assert.equal(body.includes('Bearer'), false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy blocks reflected session token in HEAD response headers', async () => {
  const remote = await listen((req, res) => {
    res.writeHead(204, { 'x-echo-auth': req.headers.authorization });
    res.end();
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'opaque-head-token' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/header-echo`, { method: 'HEAD' });
    assert.equal(resp.status, 502);
    assert.equal(resp.headers.get('x-echo-auth'), null);
    assert.equal(await resp.text(), '');
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy refreshes token once when upstream returns 401', async () => {
  const seenAuth = [];
  const remote = await listen((req, res) => {
    seenAuth.push(req.headers.authorization);
    if (seenAuth.length === 1) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'expired' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const tokenRequests = [];
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: {
      getSessionToken: async (_name, options = {}) => {
        tokenRequests.push(options.force ? 'force' : 'cached');
        return options.force ? 'zylos_st_refreshed' : 'zylos_st_cached';
      }
    }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/state`);
    assert.equal(resp.status, 200);
    assert.deepEqual(tokenRequests, ['cached', 'force']);
    assert.deepEqual(seenAuth, ['Bearer zylos_st_cached', 'Bearer zylos_st_refreshed']);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy rejects unsafe API methods before reaching upstream', async () => {
  let remoteHit = false;
  const remote = await listen((_req, res) => {
    remoteHit = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/state`, {
      method: 'PUT',
      body: 'this body must not be proxied'
    });
    assert.equal(resp.status, 403);
    assert.equal(remoteHit, false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy forwards SSE and blocks action POSTs read-only', async () => {
  let sseAuth = null;
  let actionHit = false;
  const remote = await listen((req, res) => {
    if (req.url === '/api/stream') {
      sseAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: state_change\ndata: {"ok":true}\n\n');
      return;
    }
    if (req.url.startsWith('/api/actions/')) actionHit = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const sse = await fetch(`${hub.origin}/fleet/Remote/api/stream`);
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get('content-type'), /text\/event-stream/);
    assert.equal(await sse.text(), 'event: state_change\ndata: {"ok":true}\n\n');
    assert.equal(sseAuth, 'Bearer zylos_st_secret');

    const action = await fetch(`${hub.origin}/fleet/Remote/api/actions/upgrade-cc`, { method: 'POST' });
    assert.equal(action.status, 403);
    assert.equal(actionHit, false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy blocks split session token in SSE chunks', async () => {
  const remote = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: debug\ndata: {"token":"zylos_');
    setTimeout(() => {
      res.end('st_split_secret"}\n\n');
    }, 5);
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/stream`);
    assert.equal(resp.status, 200);
    const body = await resp.text();
    assert.match(body, /secret_leak_blocked/);
    assert.equal(body.includes('zylos_st_'), false);
    assert.equal(body.includes('Bearer'), false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy blocks long opaque session token split beyond default SSE tail', async () => {
  const token = `opaque-${'x'.repeat(220)}-secret`;
  const remote = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: debug\ndata: {"token":"${token.slice(0, 170)}`);
    setTimeout(() => {
      res.end(`${token.slice(170)}"}\n\n`);
    }, 5);
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => token }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/stream`);
    assert.equal(resp.status, 200);
    const body = await resp.text();
    assert.match(body, /secret_leak_blocked/);
    assert.equal(body.includes(token), false);
    assert.equal(body.includes(token.slice(0, 170)), false);
    assert.equal(body.includes(token.slice(170)), false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy blocks reflected session token in SSE response headers', async () => {
  const remote = await listen((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-echo-auth': req.headers.authorization
    });
    res.end('event: state_change\ndata: {"ok":true}\n\n');
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'opaque-sse-token' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/stream`);
    assert.equal(resp.status, 502);
    assert.equal(resp.headers.get('x-echo-auth'), null);
    const body = await resp.text();
    assert.match(body, /secret_leak_blocked/);
    assert.equal(body.includes('opaque-sse-token'), false);
    assert.equal(body.includes('Bearer'), false);
  } finally {
    await hub.close();
    await remote.close();
  }
});
