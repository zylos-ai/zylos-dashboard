import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { ObserverService, OBSERVER_WEBSOCKET_PROTOCOL } from '../src/lib/observer-service.js';
import { connectObserverWebSocket } from '../src/lib/observer-websocket.js';

const LEASE_ID = 'a'.repeat(32);

function fixture({ authEnabled = true, deferUpstream = false } = {}) {
  const context = { kind: 'cookie', principalId: 'browser', scope: 'admin' };
  const apiContext = { kind: 'api', principalId: 'api-admin', scope: 'admin' };
  const readContext = { kind: 'api', principalId: 'api-read', scope: 'read' };
  const containment = {
    active: { generation: 7, port: 1234, sessionName: 'observer-test', tokenFile: '/private/token' },
    async reconcilePersisted() { return []; },
  };
  const coordinator = {
    async reconcileStartup() { return { state: 'installed', desired: { enabled: true } }; },
    async status() { return { state: 'installed', binaryPath: '/private/zellij', desired: { enabled: true } }; },
  };
  const manager = {
    validateLease(id, supplied) {
      if (id !== LEASE_ID) throw Object.assign(new Error('missing'), { code: 'lease_not_found' });
      assert.equal(supplied.scope, 'admin');
      return { id, preset: 'standard', generation: 7 };
    },
    async createLease() { return { id: LEASE_ID, preset: 'standard', generation: 7 }; },
    renewLease() { return { id: LEASE_ID, preset: 'standard', generation: 7 }; },
    releaseLease() { return { released: true }; },
    setPreset(_id, _context, preset) { return { id: LEASE_ID, preset, generation: 7 }; },
    async shutdown() { return { stopped: true }; },
  };
  const authGate = {
    enabled: authEnabled,
    resolveAuthContext(req) {
      if (req.headers.cookie === 'admin=1') return context;
      if (req.headers.authorization === 'Bearer admin-token') return apiContext;
      if (req.headers.authorization === 'Bearer read-token') return readContext;
      return null;
    },
    revalidateAuthContext(value) { return value; },
  };
  const upstreams = [];
  let resolveConnect;
  const connectGate = deferUpstream ? new Promise((resolve) => { resolveConnect = resolve; }) : null;
  const upstreamFactory = () => {
    const upstream = {
      closed: false,
      async connect(callbacks) {
        this.callbacks = callbacks;
        if (connectGate) await connectGate;
        return this;
      },
      resize(preset) { this.preset = preset; return true; },
      close() { this.closed = true; },
    };
    upstreams.push(upstream);
    return upstream;
  };
  const service = new ObserverService({ coordinator, containment, manager, authGate, upstreamFactory });
  return { service, upstreams, resolveConnect };
}

async function waitUntil(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition did not become true');
}

async function startHttp(service) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!await service.handle(req, res, url)) {
      res.writeHead(404).end();
    }
  });
  server.on('upgrade', (req, socket, head) => service.handleUpgrade(req, socket, head));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('Observer HTTP surface fails closed without Dashboard authentication', async () => {
  const { service } = fixture({ authEnabled: false });
  const app = await startHttp(service);
  try {
    const response = await fetch(`${app.origin}/api/observer/status`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'auth_required' });
  } finally { await app.close(); }
});

test('cookie lifecycle requires exact Origin and frame requires the bound lease header', async () => {
  const { service } = fixture();
  const app = await startHttp(service);
  try {
    const missingOrigin = await fetch(`${app.origin}/api/observer/leases`, {
      method: 'POST', headers: { Cookie: 'admin=1' },
    });
    assert.equal(missingOrigin.status, 403);
    const lease = await fetch(`${app.origin}/api/observer/leases`, {
      method: 'POST', headers: { Cookie: 'admin=1', Origin: app.origin },
    });
    assert.equal(lease.status, 201);
    assert.equal((await lease.json()).id, LEASE_ID);

    const missingLease = await fetch(`${app.origin}/observer/frame`, { headers: { Cookie: 'admin=1' } });
    assert.equal(missingLease.status, 404);
    const frame = await fetch(`${app.origin}/observer/frame`, {
      headers: { Cookie: 'admin=1', 'X-Observer-Lease': LEASE_ID },
    });
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get('x-frame-options'), 'SAMEORIGIN');
    const html = await frame.text();
    assert.match(html, /sandbox|observer-init/);
    assert.match(html, /connect-src 'none'/);
    assert.doesNotMatch(html, /session_token|auth_token/);
  } finally { await app.close(); }
});

test('exact Observer upgrade authenticates before upstream and rejects browser input', async () => {
  const { service, upstreams } = fixture();
  const app = await startHttp(service);
  let socket;
  try {
    socket = await connectObserverWebSocket({
      port: app.server.address().port,
      path: '/observer/stream',
      headers: {
        Cookie: 'admin=1',
        Origin: app.origin,
        'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${LEASE_ID}`,
      },
    });
    assert.equal(upstreams.length, 1);
    const messages = [];
    socket.on('message', (value) => messages.push(value));
    upstreams[0].callbacks.onDisplay(Buffer.from('safe display'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(messages.some((value) => Buffer.isBuffer(value) && value.toString() === 'safe display'));
    socket.sendText('keyboard input');
    await new Promise((resolve) => socket.once('close', resolve));
    assert.equal(upstreams[0].closed, true);
  } finally {
    await service.shutdown();
    socket?.destroy();
    await app.close();
  }
});

test('all non-allowlisted WebSocket paths are rejected without upstream allocation', async () => {
  const { service, upstreams } = fixture();
  const app = await startHttp(service);
  try {
    await assert.rejects(connectObserverWebSocket({
      port: app.server.address().port,
      path: '/observer/assets/xterm.js',
      headers: {
        Cookie: 'admin=1', Origin: app.origin,
        'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${LEASE_ID}`,
      },
    }), /rejected \(404\)/);
    assert.equal(upstreams.length, 0);
  } finally { await app.close(); }
});

test('admin bearer uses the explicit no-Origin path while cookie precedence still requires Origin', async () => {
  const { service } = fixture();
  const app = await startHttp(service);
  let socket;
  try {
    const lease = await fetch(`${app.origin}/api/observer/leases`, {
      method: 'POST', headers: { Authorization: 'Bearer admin-token' },
    });
    assert.equal(lease.status, 201);
    const frame = await fetch(`${app.origin}/observer/frame`, {
      headers: { Authorization: 'Bearer admin-token', 'X-Observer-Lease': LEASE_ID },
    });
    assert.equal(frame.status, 200);
    const readOnly = await fetch(`${app.origin}/api/observer/leases`, {
      method: 'POST', headers: { Authorization: 'Bearer read-token' },
    });
    assert.equal(readOnly.status, 403);
    const cookieWins = await fetch(`${app.origin}/api/observer/leases`, {
      method: 'POST', headers: { Cookie: 'admin=1', Authorization: 'Bearer admin-token' },
    });
    assert.equal(cookieWins.status, 403);
    socket = await connectObserverWebSocket({
      port: app.server.address().port,
      path: '/observer/stream',
      headers: {
        Authorization: 'Bearer admin-token',
        'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${LEASE_ID}`,
      },
    });
    assert.equal(socket.closed, false);
  } finally {
    await service.shutdown();
    socket?.destroy();
    await app.close();
  }
});

test('lease release closes a pending upstream connection before WebSocket admission', async () => {
  const { service, upstreams, resolveConnect } = fixture({ deferUpstream: true });
  const app = await startHttp(service);
  try {
    const upgrade = assert.rejects(connectObserverWebSocket({
      port: app.server.address().port,
      path: '/observer/stream',
      headers: {
        Cookie: 'admin=1', Origin: app.origin,
        'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${LEASE_ID}`,
      },
    }));
    await waitUntil(() => upstreams.length === 1 && service.streams.size === 1);
    const release = await fetch(`${app.origin}/api/observer/leases/${LEASE_ID}/release`, {
      method: 'POST', headers: { Cookie: 'admin=1', Origin: app.origin },
    });
    assert.equal(release.status, 200);
    resolveConnect();
    await upgrade;
    assert.equal(upstreams[0].closed, true);
    assert.equal(service.streams.size, 0);
  } finally { await app.close(); }
});
