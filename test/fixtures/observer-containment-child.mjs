import { DarwinObserverContainment } from '../../src/lib/observer-containment-darwin.js';

if (process.argv.length < 6) process.exit(0);
const [dataDir, zellij, tmuxPath, tmuxSocket, guardianOutput] = process.argv.slice(2);
const containment = new DarwinObserverContainment({ dataDir, tmuxPath, tmuxSocket, guardianOutput });
const active = await containment.startGeneration({ generation: 7, binaryPath: zellij, runtime: 'codex' });
process.stdout.write(`${JSON.stringify({
  event: 'ready',
  marker: active.marker,
  port: active.port,
  root: active.root,
  socketRoot: active.socketRoot,
  producerPid: process.pid,
  guardianPid: active.guardian?.pid,
  clientPid: active.client?.pid,
  webPid: active.web?.pid,
})}\n`);
await new Promise(() => {});
