import assert from 'node:assert/strict';
import fs from 'node:fs';

const LIMIT = 4096;
const payload = { type: 'oversized', bytes: new ArrayBuffer(5000) };
const tinyViewPayload = {
  type: 'oversized-view',
  bytes: new Uint8Array(new ArrayBuffer(1024 * 1024), 0, 1),
};
const textEncoder = new TextEncoder();

function flawedJsonTextSize(value) {
  return JSON.stringify(value).length;
}

function boundedStructuredCloneSize(value, limit = LIMIT) {
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

function legacyViewByteLengthSize(value, limit = LIMIT) {
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
    if (ArrayBuffer.isView(item)) { size += item.byteLength; continue; }
    for (const [key, child] of Object.entries(item)) {
      size += textEncoder.encode(key).byteLength;
      pending.push(child);
    }
  }
  return size;
}

const flawedBytes = flawedJsonTextSize(payload);
const boundedBytes = boundedStructuredCloneSize(payload);
const legacyTinyViewBytes = legacyViewByteLengthSize(tinyViewPayload);
const boundedTinyViewBytes = boundedStructuredCloneSize(tinyViewPayload);
assert.ok(flawedBytes <= LIMIT, 'known-bad JSON estimator unexpectedly rejected the binary payload');
assert.ok(boundedBytes > LIMIT, 'bounded structured-clone estimator failed to reject the binary payload');
assert.ok(legacyTinyViewBytes <= LIMIT, 'known-bad view.byteLength estimator unexpectedly rejected the tiny view');
assert.ok(boundedTinyViewBytes > LIMIT, 'full backing-buffer estimator failed to reject the tiny view');

const report = {
  result: 'pass',
  limitBytes: LIMIT,
  payloadArrayBufferBytes: payload.bytes.byteLength,
  knownBadJsonTextEstimate: flawedBytes,
  knownBadWouldReject: flawedBytes > LIMIT,
  correctedBoundedEstimate: boundedBytes,
  correctedWouldReject: boundedBytes > LIMIT,
  tinyViewBytes: tinyViewPayload.bytes.byteLength,
  tinyViewBackingBytes: tinyViewPayload.bytes.buffer.byteLength,
  knownBadViewByteLengthEstimate: legacyTinyViewBytes,
  knownBadViewWouldReject: legacyTinyViewBytes > LIMIT,
  correctedTinyViewEstimate: boundedTinyViewBytes,
  correctedTinyViewWouldReject: boundedTinyViewBytes > LIMIT,
};
if (process.argv[2]) fs.writeFileSync(process.argv[2], `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
