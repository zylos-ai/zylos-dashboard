import assert from 'node:assert/strict';

const cdpPort = Number(process.argv[2] ?? 9222);
const pagePort = Number(process.argv[3]);
assert.ok(Number.isInteger(pagePort) && pagePort > 0, 'usage: cdp-websocket-audit.mjs <cdp-port> <page-port>');

const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json());
const target = targets.find((candidate) => candidate.type === 'page' && candidate.url.startsWith(`http://127.0.0.1:${pagePort}/`));
assert.ok(target?.webSocketDebuggerUrl, `no page target found for port ${pagePort}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const handshakes = new Map();
const websocketUrls = new Map();
function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
    return;
  }
  if (message.method === 'Network.webSocketCreated') {
    websocketUrls.set(message.params.requestId, message.params.url);
  }
  if (message.method === 'Network.webSocketWillSendHandshakeRequest') {
    const { requestId, request } = message.params;
    const url = websocketUrls.get(requestId) ?? '';
    if (!url.includes(`127.0.0.1:${pagePort}/ws/`)) return;
    const cookie = request.headers.Cookie ?? request.headers.cookie ?? '';
    handshakes.set(requestId, {
      url: url.replace(/web_client_id=[^&]+/, 'web_client_id=<redacted>'),
      cookieNames: cookie.split(';').map((part) => part.trim().split('=', 1)[0]).filter(Boolean),
      sessionTokenCount: cookie.split(';').filter((part) => part.trim().startsWith('session_token=')).length,
    });
    process.stdout.write(`${JSON.stringify({ event: 'request', ...handshakes.get(requestId) })}\n`);
  }
  if (message.method === 'Network.webSocketHandshakeResponseReceived') {
    const { requestId, response } = message.params;
    const handshake = handshakes.get(requestId);
    if (!handshake) return;
    process.stdout.write(`${JSON.stringify({ event: 'response', ...handshake, status: response.status })}\n`);
  }
});

await send('Network.enable');
await send('Page.reload', { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 4000));
socket.close();
