import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { WsClient } from './ws-client.mjs';

const MAX_BODY_BYTES = 4096;
const MAX_DISPLAY_MESSAGE_BYTES = 256 * 1024;
const MAX_RING_BYTES = 1024 * 1024;
const PRESETS = new Map([
  ['80x21', { cols: 80, rows: 21 }],
  ['110x30', { cols: 110, rows: 30 }],
  ['140x40', { cols: 140, rows: 40 }],
]);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    assert.ok(argv[index].startsWith('--') && argv[index + 1], `invalid argument ${argv[index] ?? ''}`);
    result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}

function readAuthToken(file) {
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/^token_[0-9]+:\s*([0-9a-f-]{36})(?:\s|$)/m);
  assert.ok(match, 'auth token file did not contain the expected token record');
  return match[1];
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, description, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    try {
      const value = check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

function tmuxRun(args, options = {}) {
  const result = spawnSync(args.tmux, ['-S', args['tmux-socket'], ...options.argv], {
    encoding: options.encoding ?? 'utf8',
    timeout: 3000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function tmuxClients(args) {
  const output = tmuxRun(args, {
    argv: ['list-clients', '-t', args['tmux-target'], '-F', '#{client_pid}\t#{client_readonly}\t#{session_name}'],
  });
  return output.trim().split('\n').filter(Boolean).map((line) => {
    const [pid, readOnly, session] = line.split('\t');
    return { pid: Number(pid), readOnly: readOnly === '1', session };
  });
}

function capturePane(args) {
  return tmuxRun(args, {
    argv: ['capture-pane', '-p', '-J', '-t', args['tmux-target']],
  });
}

async function readBody(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(body);
}

function sendHtml(response, html, headers = {}) {
  const body = Buffer.from(html);
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(body);
}

function cookieValue(request, name) {
  const cookie = request.headers.cookie ?? '';
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function parentDocument() {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Observer Stage A broker probe</title>
<style>
  :root { color-scheme: dark; font: 14px system-ui; background: #10151c; color: #e6edf3; }
  body { margin: 0; padding: 18px; } h1 { margin: 0 0 12px; font-size: 18px; }
  #controls { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
  button { padding:7px 10px; border:1px solid #3d5268; border-radius:6px; background:#182433; color:inherit; }
  #status { white-space:pre-wrap; overflow-wrap:anywhere; padding:10px; background:#0b1118; border:1px solid #243447; border-radius:6px; margin-bottom:12px; }
  iframe { box-sizing:border-box; width:100%; height:560px; border:1px solid #3d5268; border-radius:8px; background:#0a0f14; }
</style>
<h1>Dashboard-owned broker → opaque renderer</h1>
<div id="controls">
  <button id="positive">Authenticated parent mutation (positive control)</button>
  <button id="input">Attempt input through read-only watcher</button>
  <button data-preset="80x21">80×21</button><button data-preset="110x30">110×30</button><button data-preset="140x40">140×40</button>
</div>
<div id="status">starting</div>
<iframe id="renderer" title="Opaque terminal renderer" sandbox="allow-scripts"></iframe>
<script type="module">
const frame = document.getElementById('renderer');
const statusNode = document.getElementById('status');
const evidence = { directNetworkBlocked: null, forgedWindowRejected: 0, forgedPortRejected: 0, frameReady: false, renderMessages: 0 };
const channel = new MessageChannel();
const textEncoder = new TextEncoder();
let messageWindowStart = performance.now();
let messagesThisWindow = 0;
let frameMessageWindowStart = performance.now();
let frameMessagesThisWindow = 0;
function structuredCloneSize(value, limit = 4096) {
  const pending = [value];
  const seen = new Set();
  let size = 0;
  while (pending.length && size <= limit) {
    const item = pending.pop();
    if (item == null) { size += 1; continue; }
    if (typeof item === 'boolean') { size += 1; continue; }
    if (typeof item === 'number') { size += 8; continue; }
    if (typeof item === 'string') { size += textEncoder.encode(item).byteLength; continue; }
    if (typeof item !== 'object' || seen.has(item)) return limit + 1;
    seen.add(item);
    if (item instanceof ArrayBuffer) { size += item.byteLength; continue; }
    // Structured clone allocates the full backing buffer, not only the view.
    // Count conservatively: repeated views may overcount, but can never hide an
    // allocation that the browser already performed before this handler runs.
    if (ArrayBuffer.isView(item)) { size += item.buffer.byteLength; continue; }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return limit + 1;
    for (const [key, child] of Object.entries(item)) {
      size += textEncoder.encode(key).byteLength;
      pending.push(child);
    }
  }
  return size;
}
function allowedFrameMessage(message) {
  const keys = Object.keys(message).sort();
  if (message.type === 'ready') return keys.length === 1 && keys[0] === 'type';
  return message.type === 'probe' &&
    typeof message.directNetworkBlocked === 'boolean' &&
    keys.length === 2 && keys[0] === 'directNetworkBlocked' && keys[1] === 'type';
}
function renderStatus(server = {}) { statusNode.textContent = JSON.stringify({ ...evidence, ...server }, null, 2); }
window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow) return;
  if (event.data?.type === 'admin_mutation') { evidence.forgedWindowRejected++; renderStatus(); }
});
channel.port1.onmessage = (event) => {
  const message = event.data;
  const now = performance.now();
  if (now - frameMessageWindowStart >= 1000) { frameMessageWindowStart = now; frameMessagesThisWindow = 0; }
  if (++frameMessagesThisWindow > 20) { evidence.frameRateLimited = (evidence.frameRateLimited ?? 0) + 1; renderStatus(); return; }
  if (!message || typeof message !== 'object') return;
  if (structuredCloneSize(message) > 4096) {
    evidence.frameOversizeRejected = (evidence.frameOversizeRejected ?? 0) + 1;
    if (ArrayBuffer.isView(message?.bytes) && message.bytes.byteLength <= 1 && message.bytes.buffer.byteLength >= 1024 * 1024) {
      evidence.frameLargeBackingRejected = (evidence.frameLargeBackingRejected ?? 0) + 1;
    }
    renderStatus(); return;
  }
  if (!allowedFrameMessage(message)) { evidence.forgedPortRejected++; renderStatus(); return; }
  if (message.type === 'ready') evidence.frameReady = true;
  else if (message.type === 'probe' && typeof message.directNetworkBlocked === 'boolean') evidence.directNetworkBlocked = message.directNetworkBlocked;
  channel.port1.postMessage({ type: 'probeResult', forgedRejected: evidence.forgedPortRejected > 0 });
  renderStatus();
};
const frameHtml = await fetch('/frame-document', { credentials: 'include' }).then(r => r.text());
frame.addEventListener('load', () => frame.contentWindow.postMessage({ type: 'observer-init' }, '*', [channel.port2]), { once: true });
frame.srcdoc = frameHtml;

async function pumpEvents() {
  const events = await fetch('/events', { credentials: 'include' });
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split('\\n'); pending = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const now = performance.now();
      if (now - messageWindowStart >= 1000) { messageWindowStart = now; messagesThisWindow = 0; }
      if (++messagesThisWindow > 100) continue;
      const item = JSON.parse(line);
      if (item.type !== 'display' || typeof item.data !== 'string' || item.data.length > 350000) continue;
      const bytes = Uint8Array.from(atob(item.data), c => c.charCodeAt(0));
      if (bytes.byteLength > 262144) continue;
      evidence.renderMessages++;
      channel.port1.postMessage({ type: 'render', bytes: bytes.buffer }, [bytes.buffer]);
    }
  }
}
document.getElementById('positive').onclick = async () => { await fetch('/admin/sentinel', { method:'POST', credentials:'include' }); await poll(); };
document.getElementById('input').onclick = async () => { await fetch('/probe/upstream-input', { method:'POST', credentials:'include' }); await poll(); };
for (const button of document.querySelectorAll('[data-preset]')) button.onclick = async () => {
  const preset = button.dataset.preset;
  await fetch('/preset', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:JSON.stringify({preset}) });
  channel.port1.postMessage({ type:'preset', preset }); await poll();
};
async function poll() { const server = await fetch('/status', {credentials:'include'}).then(r=>r.json()); renderStatus(server); }
setInterval(poll, 500); poll(); pumpEvents();
</script>`;
}

function frameDocument(xtermJs, xtermCss) {
  const safeJs = xtermJs.replaceAll('</script', '<\\/script');
  return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-stage-a'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<style>html,body,#terminal{width:100%;height:100%;margin:0;background:#0a0f14;overflow:hidden}${xtermCss}</style>
<div id="terminal"></div>
<script nonce="stage-a">${safeJs}</script>
<script nonce="stage-a">
const term = new Terminal({ cols:80, rows:21, disableStdin:true, cursorBlink:false, convertEol:false, theme:{background:'#0a0f14'} });
term.open(document.getElementById('terminal'));
const presets = { '80x21':[80,21], '110x30':[110,30], '140x40':[140,40] };
let port = null;
function initialize(event) {
  if (event.source !== parent || event.data?.type !== 'observer-init' || event.ports.length !== 1 || port) return;
  port = event.ports[0];
  removeEventListener('message', initialize);
  port.onmessage = ({data}) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'render' && data.bytes instanceof ArrayBuffer && data.bytes.byteLength <= 262144) term.write(new Uint8Array(data.bytes));
    else if (data.type === 'preset' && presets[data.preset]) term.resize(...presets[data.preset]);
    else if (data.type === 'shutdown') { term.dispose(); port.close(); }
  };
  port.start();
  port.postMessage({type:'ready'});
  parent.postMessage({type:'admin_mutation'}, '*');
  port.postMessage({type:'admin_mutation', path:'/admin/sentinel', method:'POST'});
  port.postMessage({type:'oversized', bytes:new ArrayBuffer(5000)});
  port.postMessage({type:'oversized-view', bytes:new Uint8Array(new ArrayBuffer(1024 * 1024), 0, 1)});
  fetch('/admin/sentinel', {method:'POST', credentials:'include'})
    .then(() => port.postMessage({type:'probe', directNetworkBlocked:false}))
    .catch(() => {
      port.postMessage({type:'probe', directNetworkBlocked:true});
      for (let index = 0; index < 25; index++) port.postMessage({type:'unknown', index});
    });
}
addEventListener('message', initialize);
</script>`;
}

const args = parseArgs(process.argv.slice(2));
const upstreamPort = Number(args['upstream-port']);
assert.ok(Number.isInteger(upstreamPort) && upstreamPort > 0, '--upstream-port is required');
assert.ok(args.session && args['token-file'] && args['xterm-js'] && args['xterm-css'] &&
  args.tmux && args['tmux-socket'] && args['tmux-target'] && args['expected-upstream-readonly'],
  'missing required argument');
assert.ok(args['expected-upstream-readonly'] === 'true' || args['expected-upstream-readonly'] === 'false',
  '--expected-upstream-readonly must be true or false');
const expectedUpstreamReadOnly = args['expected-upstream-readonly'] === 'true';
const authToken = readAuthToken(args['token-file']);
const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
const login = await fetch(`${upstreamOrigin}/command/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ auth_token: authToken, remember_me: false }),
  signal: AbortSignal.timeout(5000),
});
assert.equal(login.status, 200, `upstream login failed (${login.status})`);
const upstreamCookie = login.headers.get('set-cookie')?.split(';', 1)[0];
assert.ok(upstreamCookie?.startsWith('session_token='), 'upstream did not return a session cookie');
const sessionResponse = await fetch(`${upstreamOrigin}/session?session=${encodeURIComponent(args.session)}&welcome=false`, {
  method: 'POST', headers: { Cookie: upstreamCookie, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
});
assert.equal(sessionResponse.status, 200, `upstream session bootstrap failed (${sessionResponse.status})`);
const boot = await sessionResponse.json();
assert.equal(boot.is_read_only, expectedUpstreamReadOnly, 'upstream read-only mode does not match the oracle case');
assert.equal(boot.session_name, args.session, 'upstream selected an unexpected session');
const initialClients = tmuxClients(args);
assert.equal(initialClients.length, 1, `expected one exact tmux client: ${JSON.stringify(initialClients)}`);
assert.equal(initialClients[0].session, args['tmux-target'], 'tmux client selected an unexpected target');
assert.equal(initialClients[0].readOnly, expectedUpstreamReadOnly,
  `tmux client read-only state mismatch: ${JSON.stringify(initialClients[0])}`);

const control = await new WsClient({
  port: upstreamPort,
  path: `/ws/control?web_client_id=${encodeURIComponent(boot.web_client_id)}`,
  cookie: upstreamCookie,
}).connect();
const terminal = await new WsClient({
  port: upstreamPort,
  path: `/ws/terminal/${encodeURIComponent(args.session)}?web_client_id=${encodeURIComponent(boot.web_client_id)}&rows=21&cols=80`,
  cookie: upstreamCookie,
}).connect();

const adminSecret = crypto.randomBytes(32).toString('base64url');
const streams = new Set();
const displayRing = [];
let ringBytes = 0;
let sentinel = 0;
let preset = '80x21';
let inputProbeSent = false;
let inputProbe = null;
let brokerOrigin = null;
let renderedProbeBytes = Buffer.alloc(0);

function emitDisplay(message) {
  const payload = Buffer.isBuffer(message) ? message : Buffer.from(message);
  if (payload.length > MAX_DISPLAY_MESSAGE_BYTES) return;
  renderedProbeBytes = Buffer.concat([renderedProbeBytes, payload]);
  if (renderedProbeBytes.length > 256 * 1024) renderedProbeBytes = renderedProbeBytes.subarray(renderedProbeBytes.length - 256 * 1024);
  const line = `${JSON.stringify({ type: 'display', data: payload.toString('base64') })}\n`;
  const bytes = Buffer.byteLength(line);
  displayRing.push(line); ringBytes += bytes;
  while (ringBytes > MAX_RING_BYTES && displayRing.length > 1) ringBytes -= Buffer.byteLength(displayRing.shift());
  for (const stream of streams) stream.write(line);
}

async function runInputOracle() {
  assert.equal(inputProbe, null, 'input oracle may only run once');
  const marker = `__OBSERVER_CR_${crypto.randomBytes(8).toString('hex')}__`;
  const paneBefore = capturePane(args);
  const paneHashBefore = crypto.createHash('sha256').update(paneBefore).digest('hex');
  const clientsBefore = tmuxClients(args);
  assert.equal(clientsBefore.length, 1, `tmux client count changed: ${JSON.stringify(clientsBefore)}`);
  assert.equal(clientsBefore[0].readOnly, expectedUpstreamReadOnly,
    `tmux client mode changed before input: ${JSON.stringify(clientsBefore[0])}`);

  terminal.sendText(`printf '${marker}\\n'\r`);
  inputProbeSent = true;

  if (expectedUpstreamReadOnly) {
    await delay(750);
  } else {
    await waitFor(() => capturePane(args).includes(marker), 'writable pane marker');
    await waitFor(() => renderedProbeBytes.includes(Buffer.from(marker)), 'writable rendered marker');
  }

  const paneAfter = capturePane(args);
  const paneHashAfter = crypto.createHash('sha256').update(paneAfter).digest('hex');
  const paneApplied = paneAfter.includes(marker);
  const rendered = renderedProbeBytes.includes(Buffer.from(marker));
  if (expectedUpstreamReadOnly) {
    assert.equal(paneHashAfter, paneHashBefore, 'read-only upstream mutated the tmux pane');
    assert.equal(paneApplied, false, 'read-only upstream applied the marker command');
    assert.equal(rendered, false, 'read-only upstream rendered the marker command');
  } else {
    assert.notEqual(paneHashAfter, paneHashBefore, 'writable upstream did not mutate the tmux pane');
    assert.equal(paneApplied, true, 'writable upstream did not apply the marker command');
    assert.equal(rendered, true, 'writable upstream did not render the marker command');
  }
  inputProbe = {
    marker,
    expectedReadOnly: expectedUpstreamReadOnly,
    actualClientReadOnly: clientsBefore[0].readOnly,
    clientPid: clientsBefore[0].pid,
    paneHashBefore,
    paneHashAfter,
    paneApplied,
    rendered,
    actualCrByteSent: true,
    result: 'pass',
  };
  return inputProbe;
}
terminal.on('message', emitDisplay);
terminal.on('error', (error) => process.stderr.write(`${JSON.stringify({ event:'upstream-error', channel:'terminal', message:error.message })}\n`));
control.on('error', (error) => process.stderr.write(`${JSON.stringify({ event:'upstream-error', channel:'control', message:error.message })}\n`));

const xtermJs = fs.readFileSync(args['xterm-js'], 'utf8');
const xtermCss = fs.readFileSync(args['xterm-css'], 'utf8');
const frameHtml = frameDocument(xtermJs, xtermCss);
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, brokerOrigin);
    if (request.method === 'GET' && url.pathname === '/') {
      sendHtml(response, parentDocument(), {
        'Set-Cookie': `probe_admin=${adminSecret}; HttpOnly; SameSite=Strict; Path=/`,
        'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      });
      return;
    }
    if (cookieValue(request, 'probe_admin') !== adminSecret) { sendJson(response, 401, { error:'unauthorized' }); return; }
    if (request.method === 'GET' && url.pathname === '/frame-document') { sendHtml(response, frameHtml); return; }
    if (request.method === 'GET' && url.pathname === '/events') {
      response.writeHead(200, { 'Content-Type':'application/x-ndjson', 'Cache-Control':'no-store', Connection:'keep-alive' });
      for (const line of displayRing) response.write(line);
      streams.add(response);
      request.on('close', () => streams.delete(response));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/status') {
      sendJson(response, 200, {
        sentinel, preset, inputProbeSent, inputProbe,
        upstreamReadOnly: boot.is_read_only,
        upstreamConnected: true,
      }); return;
    }
    const mutationAllowed = request.headers.origin === brokerOrigin;
    if (request.method === 'POST' && url.pathname === '/admin/sentinel') {
      if (!mutationAllowed) { sendJson(response, 403, { error:'origin' }); return; }
      await readBody(request); sentinel++; sendJson(response, 200, { sentinel }); return;
    }
    if (request.method === 'POST' && url.pathname === '/probe/upstream-input') {
      if (!mutationAllowed) { sendJson(response, 403, { error:'origin' }); return; }
      await readBody(request);
      const oracle = await runInputOracle();
      sendJson(response, 200, { sent:true, oracle }); return;
    }
    if (request.method === 'POST' && url.pathname === '/preset') {
      if (!mutationAllowed) { sendJson(response, 403, { error:'origin' }); return; }
      const body = JSON.parse((await readBody(request)).toString('utf8'));
      if (!PRESETS.has(body.preset)) { sendJson(response, 400, { error:'preset' }); return; }
      preset = body.preset;
      const size = PRESETS.get(preset);
      control.sendText(JSON.stringify({ web_client_id: boot.web_client_id, payload:{ type:'TerminalResize', rows:size.rows, cols:size.cols } }));
      sendJson(response, 200, { preset }); return;
    }
    sendJson(response, 404, { error:'not_found' });
  } catch (error) {
    if (!response.headersSent) sendJson(response, 400, { error:error.message });
    else response.destroy(error);
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(Number(args['public-port'] ?? 0), '127.0.0.1', resolve);
});
const address = server.address();
brokerOrigin = `http://127.0.0.1:${address.port}`;
process.stdout.write(`${JSON.stringify({
  event:'ready', publicUrl:brokerOrigin, upstreamPort, session:args.session,
  upstreamReadOnly:boot.is_read_only, tmuxClient:initialClients[0],
  publicRoutes:['/','/frame-document','/events','/status','/admin/sentinel','/probe/upstream-input','/preset'],
})}\n`);

function shutdown() {
  for (const stream of streams) stream.end();
  terminal.close(); control.close(); server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
