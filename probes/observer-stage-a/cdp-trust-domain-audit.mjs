import assert from 'node:assert/strict';
import fs from 'node:fs';

const cdpPort = Number(process.argv[2]);
const pagePort = Number(process.argv[3]);
const upstreamPort = Number(process.argv[4]);
const evidenceFile = process.argv[5];
const screenshotPrefix = process.argv[6];
assert.ok(cdpPort && pagePort && upstreamPort, 'usage: cdp-trust-domain-audit.mjs <cdp-port> <page-port> <upstream-port> [evidence-file] [screenshot-prefix]');

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
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});
function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const exercise = await send('Runtime.evaluate', {
  expression: `(async () => {
    const waitFor = async (check, label) => {
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(label + ' timed out');
    };
    const status = () => JSON.parse(document.getElementById('status').textContent);
    await waitFor(() => status().frameReady && status().directNetworkBlocked === true && status().frameOversizeRejected >= 1 && status().frameRateLimited >= 1, 'frame controls');
    document.getElementById('positive').click();
    await waitFor(() => status().sentinel === 1, 'positive mutation control');
    document.getElementById('input').click();
    await waitFor(() => status().inputProbeSent === true, 'read-only input control');
    return status();
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
if (exercise.exceptionDetails) throw new Error(exercise.exceptionDetails.exception?.description ?? exercise.exceptionDetails.text);

await send('Page.enable');
async function captureViewport(name, width, height, mobile) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const inspected = await send('Runtime.evaluate', {
    expression: `({
      noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth,
      viewport: { width: innerWidth, height: innerHeight },
    })`,
    returnByValue: true,
  });
  if (inspected.exceptionDetails) throw new Error(inspected.exceptionDetails.text);
  if (screenshotPrefix) {
    const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(`${screenshotPrefix}-${name}.png`, Buffer.from(screenshot.data, 'base64'), { flag: 'wx' });
  }
  return inspected.result.value;
}

const desktop = await captureViewport('desktop', 1280, 900, false);
const mobile = await captureViewport('mobile', 390, 844, true);
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

const expression = `(() => {
  const frame = document.querySelector('iframe');
  let opaque = false;
  try { void frame.contentWindow.document; } catch (error) { opaque = error.name === 'SecurityError'; }
  return {
    status: JSON.parse(document.getElementById('status').textContent),
    sandbox: frame.getAttribute('sandbox'),
    opaque,
    parentCookieNames: document.cookie.split(';').map(part => part.trim().split('=')[0]).filter(Boolean),
    upstreamResources: performance.getEntriesByType('resource').map(entry => entry.name).filter(name => name.includes('127.0.0.1:${upstreamPort}')),
    noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth,
    viewport: { width: innerWidth, height: innerHeight },
  };
})()`;
const evaluation = await send('Runtime.evaluate', { expression, returnByValue: true });
if (evaluation.exceptionDetails) throw new Error(evaluation.exceptionDetails.text);
const browser = evaluation.result.value;
const cookiesResult = await send('Network.getCookies', { urls: [`http://127.0.0.1:${pagePort}/`] });
const cookies = cookiesResult.cookies.map(({ name, domain, path, httpOnly, secure, sameSite }) => ({ name, domain, path, httpOnly, secure, sameSite }));
const report = { result: 'pass', pagePort, upstreamPort, ...browser, desktop, mobile, cookies };

assert.equal(browser.status.directNetworkBlocked, true);
assert.ok(browser.status.forgedWindowRejected >= 1);
assert.ok(browser.status.forgedPortRejected >= 1);
assert.ok(browser.status.frameOversizeRejected >= 1);
assert.ok(browser.status.frameRateLimited >= 1);
assert.equal(browser.status.frameReady, true);
assert.equal(browser.status.sentinel, 1);
assert.equal(browser.status.inputProbeSent, true);
assert.equal(browser.status.upstreamReadOnly, true);
assert.equal(browser.status.upstreamConnected, true);
assert.equal(browser.sandbox, 'allow-scripts');
assert.equal(browser.opaque, true);
assert.equal(browser.noHorizontalOverflow, true);
assert.equal(desktop.noHorizontalOverflow, true);
assert.deepEqual(desktop.viewport, { width: 1280, height: 900 });
assert.equal(mobile.noHorizontalOverflow, true);
assert.deepEqual(mobile.viewport, { width: 390, height: 844 });
assert.deepEqual(browser.upstreamResources, []);
assert.ok(!browser.parentCookieNames.includes('session_token'));
assert.ok(!cookies.some((cookie) => cookie.name === 'session_token'));
assert.equal(cookies.find((cookie) => cookie.name === 'probe_admin')?.httpOnly, true);

if (evidenceFile) fs.writeFileSync(evidenceFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify(report)}\n`);
socket.close();
