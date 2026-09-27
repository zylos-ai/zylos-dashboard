import { parentPort, workerData } from 'node:worker_threads';
import { redact, UNAVAILABLE } from './engine.js';
try {
  parentPort.postMessage(redact(workerData.text, workerData.options));
} catch {
  parentPort.postMessage({ text: UNAVAILABLE, count: 0, kinds: [], failed: true });
}
