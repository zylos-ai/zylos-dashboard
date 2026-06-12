import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
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

test('fleet proxy standalone HTML resolves admin access before injection', async () => {
  const tokenRequests = [];
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: 'http://remote.invalid', read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: {
      getSessionToken: async (name) => {
        tokenRequests.push(name);
        return 'zylos_st_secret';
      },
      getAgentAccess: () => 'admin'
    }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/`);
    assert.equal(resp.status, 200);
    const body = await resp.text();
    assert.match(body, /data-remote-access="admin"/);
    assert.deepEqual(tokenRequests, ['Remote']);
  } finally {
    await hub.close();
  }
});

test('fleet proxy standalone HTML falls back to read when access cannot be resolved', async () => {
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: 'http://remote.invalid', read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: {
      getSessionToken: async () => {
        const err = new Error('auth_failed');
        err.status = 403;
        throw err;
      },
      getAgentAccess: () => 'admin'
    }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/`);
    assert.equal(resp.status, 200);
    const body = await resp.text();
    assert.match(body, /data-remote-access="read"/);
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

test('fleet proxy strips content-encoding from compressed upstream responses (#255)', async () => {
  // A Cloudflare-fronted producer compresses JSON. undici fetch inside the
  // proxy auto-decompresses the body, so the forwarded response must not
  // carry the upstream content-encoding header — browsers would otherwise
  // try to decode plain bytes and fail every remote data request.
  let upstreamAcceptEncoding;
  const remote = await listen((req, res) => {
    upstreamAcceptEncoding = req.headers['accept-encoding'];
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync(JSON.stringify({ state: 'IDLE', context_pct: 33 })));
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
      headers: { 'accept-encoding': 'gzip, deflate, br' }
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('content-encoding'), null);
    const body = await resp.json();
    assert.equal(body.state, 'IDLE');
    assert.equal(body.context_pct, 33);
    // The browser's accept-encoding must not be forwarded verbatim — undici
    // negotiates its own so that auto-decompression stays deterministic.
    assert.notEqual(upstreamAcceptEncoding, 'gzip, deflate, br');
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

test('fleet proxy forwards SSE and whitelisted action POSTs with body', async () => {
  let sseAuth = null;
  let actionAuth = null;
  let actionBody = null;
  let actionContentType = null;
  const remote = await listen((req, res) => {
    if (req.url === '/api/stream') {
      sseAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: state_change\ndata: {"ok":true}\n\n');
      return;
    }
    if (req.url.startsWith('/api/actions/')) {
      actionAuth = req.headers.authorization;
      actionContentType = req.headers['content-type'];
      req.setEncoding('utf8');
      req.on('data', chunk => { actionBody = `${actionBody || ''}${chunk}`; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
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

    const action = await fetch(`${hub.origin}/fleet/Remote/api/actions/upgrade-cc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'now' })
    });
    assert.equal(action.status, 200);
    assert.deepEqual(await action.json(), { ok: true });
    assert.equal(actionAuth, 'Bearer zylos_st_secret');
    assert.equal(actionContentType, 'application/json');
    assert.equal(actionBody, '{"mode":"now"}');
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy keeps non-whitelisted writes read-only', async () => {
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
    const token = await fetch(`${hub.origin}/fleet/Remote/api/auth/token`, { method: 'POST' });
    assert.equal(token.status, 403);
    const del = await fetch(`${hub.origin}/fleet/Remote/api/settings`, { method: 'DELETE' });
    assert.equal(del.status, 403);
    assert.equal(remoteHit, false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy fail-closes consumer-local fleet management endpoints without touching upstream', async () => {
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
    const cases = [
      [`${hub.origin}/fleet/Remote/api/fleet/agents`, { method: 'GET' }],
      [`${hub.origin}/fleet/Remote/api/fleet/agents`, { method: 'POST', body: '{}' }],
      [`${hub.origin}/fleet/Remote/api/fleet/agents/test`, { method: 'POST', body: '{}' }],
      [`${hub.origin}/fleet/Remote/api/agent/name`, { method: 'PUT', body: '{}' }],
      [`${hub.origin}/fleet/Remote/api/fleet/agents%2Ftest`, { method: 'POST', body: '{}' }],
      [`${hub.origin}/fleet/Remote/api/fleet%2Fagents`, { method: 'GET' }],
      [`${hub.origin}/fleet/Remote/api%2Fagent%2Fname`, { method: 'PUT', body: '{}' }],
      [`${hub.origin}/fleet/Remote/api/keys`, { method: 'GET' }],
      [`${hub.origin}/fleet/Remote/api/keys`, { method: 'POST', body: '{}' }],
      [`${hub.origin}/fleet/Remote/api/keys/producer-read`, { method: 'DELETE' }],
      [`${hub.origin}/fleet/Remote/api/keys%2Fproducer-read`, { method: 'DELETE' }],
      [`${hub.origin}/fleet/Remote/api%2Fkeys`, { method: 'GET' }]
    ];
    for (const [url, init] of cases) {
      const resp = await fetch(url, init);
      assert.equal(resp.status, 403);
      assert.deepEqual(await resp.json(), { error: 'local_endpoint_not_proxyable' });
    }
    assert.equal(remoteHit, false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy allows admin memory GETs and validates memory query paths consumer-side', async () => {
  const seen = [];
  const remote = await listen((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, method: req.method, url: req.url }));
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
    const tree = await fetch(`${hub.origin}/fleet/Remote/api/memory/tree`);
    assert.equal(tree.status, 200);
    assert.deepEqual(await tree.json(), { ok: true, method: 'GET', url: '/api/memory/tree' });

    const nested = await fetch(`${hub.origin}/fleet/Remote/api/memory/file?path=reference%2Fprojects.md`);
    assert.equal(nested.status, 200);
    assert.deepEqual(await nested.json(), { ok: true, method: 'GET', url: '/api/memory/file?path=reference%2Fprojects.md' });

    const put = await fetch(`${hub.origin}/fleet/Remote/api/memory/file?path=identity.md`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '# Identity\n', sha256: 'a'.repeat(64) })
    });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { ok: true, method: 'PUT', url: '/api/memory/file?path=identity.md' });

    const expandedPut = await fetch(`${hub.origin}/fleet/Remote/api/memory/file?path=identity.md`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '\n'.repeat(1024 * 1024), sha256: 'a'.repeat(64) })
    });
    assert.equal(expandedPut.status, 200);
    assert.deepEqual(await expandedPut.json(), { ok: true, method: 'PUT', url: '/api/memory/file?path=identity.md' });

    const unsafe = await fetch(`${hub.origin}/fleet/Remote/api/memory/file?path=..%2Fstate.md`);
    assert.equal(unsafe.status, 400);
    assert.deepEqual(await unsafe.json(), { error: 'invalid_memory_path' });

    const unsafePut = await fetch(`${hub.origin}/fleet/Remote/api/memory/file?path=..%2Fstate.md`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(unsafePut.status, 400);
    assert.deepEqual(await unsafePut.json(), { error: 'invalid_memory_path' });

    const write = await fetch(`${hub.origin}/fleet/Remote/api/memory/file?path=identity.md`, {
      method: 'POST',
      body: '{}'
    });
    assert.equal(write.status, 403);
    assert.deepEqual(await write.json(), { error: 'read_only_proxy' });

    assert.deepEqual(seen, [
      { method: 'GET', url: '/api/memory/tree' },
      { method: 'GET', url: '/api/memory/file?path=reference%2Fprojects.md' },
      { method: 'PUT', url: '/api/memory/file?path=identity.md' },
      { method: 'PUT', url: '/api/memory/file?path=identity.md' }
    ]);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy keeps encoded slash fail-closed for memory URL path', async () => {
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
    for (const url of [
      `${hub.origin}/fleet/Remote/api%2Fmemory/tree`,
      `${hub.origin}/fleet/Remote/api/memory%2Ftree`
    ]) {
      const resp = await fetch(url);
      assert.equal(resp.status, 403);
      assert.deepEqual(await resp.json(), { error: 'local_endpoint_not_proxyable' });
    }
    assert.equal(remoteHit, false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy passes through upstream insufficient_scope for whitelisted writes', async () => {
  const remote = await listen((_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'insufficient_scope', required: 'admin' }));
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
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(resp.status, 403);
    assert.deepEqual(await resp.json(), { error: 'insufficient_scope', required: 'admin' });
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy refreshes token once for write 401 and reuses the request body', async () => {
  const seenAuth = [];
  const seenBodies = [];
  let actionExecutions = 0;
  const remote = await listen((req, res) => {
    seenAuth.push(req.headers.authorization);
    if (seenAuth.length === 1) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'expired' }));
      return;
    }
    req.setEncoding('utf8');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      actionExecutions += 1;
      seenBodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
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
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/actions/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"reason":"test"}'
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(tokenRequests, ['cached', 'force']);
    assert.deepEqual(seenAuth, ['Bearer zylos_st_cached', 'Bearer zylos_st_refreshed']);
    assert.equal(actionExecutions, 1);
    assert.deepEqual(seenBodies, ['{"reason":"test"}']);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy rejects oversized write bodies before upstream', async () => {
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
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/actions/interrupt`, {
      method: 'POST',
      body: 'x'.repeat(1024 * 1024 + 1)
    });
    assert.equal(resp.status, 413);
    assert.equal(remoteHit, false);
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
