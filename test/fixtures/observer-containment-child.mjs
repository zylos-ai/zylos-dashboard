import { DarwinObserverContainment } from '../../src/lib/observer-containment-darwin.js';

const [dataDir, zellij, tmuxPath, tmuxSocket] = process.argv.slice(2);
const containment = new DarwinObserverContainment({ dataDir, tmuxPath, tmuxSocket });
const active = await containment.startGeneration({ generation: 7, binaryPath: zellij, runtime: 'codex' });
process.stdout.write(`${JSON.stringify({
  event: 'ready',
  marker: active.marker,
  port: active.port,
  root: active.root,
  socketRoot: active.socketRoot,
})}\n`);
await new Promise(() => {});
