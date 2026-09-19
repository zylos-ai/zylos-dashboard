import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
const [guardian, marker, ready, log] = process.argv.slice(2);
const result = spawnSync(guardian, ['identity', String(process.pid)], { encoding: 'utf8', timeout: 1500 });
if (result.status !== 0) throw new Error(`producer identity failed: ${result.stderr}`);
const id = JSON.parse(result.stdout.trim());
const out = fs.openSync(log, 'wx', 0o600);
const child = spawn(guardian, ['watch', '3', String(process.pid), String(id.startSec), String(id.startUsec), `fdpath:${marker}`, '8000'], {
  stdio: ['ignore', out, out, 'pipe'],
});
child.on('error', (error) => { throw error; });
child.stdio[3].on('error', () => {});
fs.closeSync(out);
fs.writeFileSync(ready, JSON.stringify({ producer: process.pid, guardian: child.pid }), { flag: 'wx', mode: 0o600 });
// Bound this fixture even if the outer harness fails before recording readiness.
const heartbeat = setInterval(() => {}, 1000);
const expiry = setTimeout(() => process.exit(2), 30000);
child.on('exit', (code) => {
  clearInterval(heartbeat); clearTimeout(expiry);
  process.exitCode = code || 1;
});
