import http from 'node:http';
import fs from 'node:fs';
import readline from 'node:readline';
import { DarwinObserverContainment } from '../../src/lib/observer-containment-darwin.js';
import { ObserverControlServer, runObserverPreUninstall } from '../../src/lib/observer-control.js';
import { ObserverCoordinator } from '../../src/lib/observer-coordinator.js';
import { ObserverInstaller } from '../../src/lib/observer-installer.js';
import { ObserverManager } from '../../src/lib/observer-manager.js';
import { ObserverService, OBSERVER_WEBSOCKET_PROTOCOL } from '../../src/lib/observer-service.js';
import { connectObserverWebSocket } from '../../src/lib/observer-websocket.js';

if (process.argv.length < 7) process.exit(0);
const [action, dataDir, configPath, tmuxPath, tmuxSocket] = process.argv.slice(2);
const context = { kind: 'cookie', principalId: 'acceptance-browser', scope: 'admin' };
const authGate = {
  enabled: true,
  resolveAuthContext(req) { return req.headers.cookie === 'acceptance=1' ? context : null; },
  revalidateAuthContext(value) { return value?.principalId === context.principalId ? context : null; },
};
const installer = new ObserverInstaller({ dataDir });
const containment = new DarwinObserverContainment({ dataDir, tmuxPath, tmuxSocket });
const coordinator = new ObserverCoordinator({
  configPath,
  installer,
  teardown: ({ reason }) => containment.stopGeneration({ reason }),
  reconcilePersisted: () => containment.reconcilePersisted(),
  start: ({ generation, binaryPath }) => containment.startGeneration({ generation, binaryPath, runtime: 'codex' }),
});
const manager = new ObserverManager({
  coordinator,
  containment,
  authGate,
  runtime: 'codex',
  idleGraceMs: 200,
  leaseTtlMs: 30_000,
  revalidateMs: 10_000,
});
const service = new ObserverService({ coordinator, containment, manager, authGate });
const control = new ObserverControlServer({ dataDir, onPreUninstall: () => service.preUninstall() });
service.ensureCoordinatorOwnership = () => control.start();
await service.startup();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!await service.handle(req, res, url)) res.writeHead(404).end();
});
server.on('upgrade', (req, socket, head) => service.handleUpgrade(req, socket, head));
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const leaseResponse = await fetch(`${origin}/api/observer/leases`, {
  method: 'POST', headers: { Cookie: 'acceptance=1', Origin: origin },
});
if (leaseResponse.status !== 201) throw new Error(`lease failed: ${leaseResponse.status} ${await leaseResponse.text()}`);
const lease = await leaseResponse.json();
const downstream = await connectObserverWebSocket({
  port: server.address().port,
  path: '/observer/stream',
  headers: {
    Cookie: 'acceptance=1', Origin: origin,
    'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${lease.id}`,
  },
});
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('no terminal display received')), 8_000);
  downstream.on('message', (message) => {
    if (!Buffer.isBuffer(message) || message.length === 0) return;
    clearTimeout(timeout);
    resolve();
  });
  downstream.activate();
});
const active = containment.active;
process.stdout.write(`${JSON.stringify({
  event: 'ready', action, marker: active.marker, port: active.port,
  producerPid: process.pid,
  guardianPid: active.guardian?.pid,
  clientPid: active.client?.pid,
  webPid: active.web?.pid,
})}\n`);

if (action === 'abrupt') await new Promise(() => {});

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
await new Promise((resolve) => input.once('line', resolve));

const startedAt = Date.now();
if (action === 'last-lease') {
  downstream.close();
} else if (action === 'disable') {
  const response = await fetch(`${origin}/api/observer/disable`, {
    method: 'POST', headers: { Cookie: 'acceptance=1', Origin: origin },
  });
  if (response.status !== 200) throw new Error(`disable failed: ${response.status} ${await response.text()}`);
} else if (action === 'pre-uninstall') {
  const result = await runObserverPreUninstall({ dataDir, configPath });
  if (result.mode !== 'online') throw new Error(`unexpected pre-uninstall mode: ${result.mode}`);
} else if (action === 'restart') {
  await service.shutdown('dashboard_restart');
} else {
  throw new Error(`unknown lifecycle action: ${action}`);
}

const deadline = Date.now() + 10_000;
while (containment.active && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
if (containment.active) throw new Error('Observer containment remained active');
downstream.destroy();
await new Promise((resolve) => server.close(resolve));
await control.close();
process.stdout.write(`${JSON.stringify({
  event: 'done', action, elapsedMs: Date.now() - startedAt,
  manifestPresent: fs.existsSync(installer.paths.installedManifest),
})}\n`);
