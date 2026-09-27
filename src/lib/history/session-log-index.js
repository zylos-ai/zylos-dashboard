import fs from 'node:fs/promises';
import { constants } from 'node:fs';

async function openTranscript(filePath) {
  if (await fs.realpath(filePath) !== filePath) throw new Error('transcript_path_changed');
  const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const [opened, named] = await Promise.all([file.stat(), fs.lstat(filePath)]);
  if (!opened.isFile() || opened.ino !== named.ino || opened.dev !== named.dev) {
    await file.close(); throw new Error('transcript_path_changed');
  }
  return file;
}

// Serialize all read operations by path, including metadata discovery and
// active-session parsing using different index instances.
const reads = new Map();
function readTask(filePath, work) {
  const previous = reads.get(filePath) || Promise.resolve();
  const pending = previous.catch(() => {}).then(work);
  reads.set(filePath, pending);
  pending.finally(() => { if (reads.get(filePath) === pending) reads.delete(filePath); }).catch(() => {});
  return pending;
}

// Internal/raw views must not bypass the runtime reasoning exclusion.
function withoutReasoning(value) {
  if (Array.isArray(value)) return value.map(withoutReasoning);
  if (!value || typeof value !== 'object') return value;
  if (['thinking', 'redacted_thinking', 'reasoning', 'Reasoning'].includes(value.type)) {
    return { type: value.type, notice: 'Runtime did not save thinking content.' };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutReasoning(item)]));
}

export const CHUNK_BYTES = 1024 * 1024;
export const DEFERRED_LINE_BYTES = 4 * CHUNK_BYTES;

/** Read-only, bounded-buffer index. Only newline-terminated records become visible. */
export class SessionLogIndex {
  constructor(filePath) {
    this.filePath = filePath;
    this.lines = [];
    this.generation = 0;
    this.position = 0;
    this.lineStart = 0;
  }
  update() {
    if (!this.pending) this.pending = readTask(this.filePath, () => this._update()).finally(() => { this.pending = null; });
    return this.pending;
  }
  async _update() {
    const file = await openTranscript(this.filePath);
    try {
      const stat = await file.stat();
      const identity = `${stat.dev}:${stat.ino}`;
      if (identity !== this.identity || stat.size < this.position ||
          (stat.size === this.position && this.mtime !== undefined && stat.mtimeMs !== this.mtime)) {
        this.lines = []; this.position = 0; this.lineStart = 0;
        this.generation++; this.parsed = null; this.historyMetadata = null;
      }
      this.identity = identity;
      const buffer = Buffer.alloc(CHUNK_BYTES);
      // A snapshot avoids chasing a continuously growing writer.
      while (this.position < stat.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - this.position), this.position);
        if (!bytesRead) break;
        let from = 0;
        while (from < bytesRead) {
          const end = buffer.indexOf(10, from);
          if (end < 0 || end >= bytesRead) break;
          const length = this.position + end - this.lineStart;
          this.lines.push({ offset: this.lineStart, length, deferred: length > DEFERRED_LINE_BYTES });
          this.lineStart = this.position + end + 1;
          from = end + 1;
        }
        this.position += bytesRead;
      }
      this.mtime = stat.mtimeMs;
      return this;
    } finally { await file.close(); }
  }
  readLine(line) { return readTask(this.filePath, () => this._readLine(line)); }
  async _readLine(line) {
    const file = await openTranscript(this.filePath);
    try {
      const stat = await file.stat();
      if (`${stat.dev}:${stat.ino}` !== this.identity || stat.size < line.offset + line.length) {
        throw new Error('transcript_replaced');
      }
      const buffer = Buffer.alloc(line.length);
      let read = 0;
      while (read < buffer.length) {
        const { bytesRead } = await file.read(buffer, read, Math.min(CHUNK_BYTES, buffer.length - read), line.offset + read);
        if (!bytesRead) throw new Error('transcript_replaced');
        read += bytesRead;
      }
      return buffer.toString('utf8');
    } finally { await file.close(); }
  }
}

export class SessionLogIndexCache {
  constructor({ maxFiles = 8 } = {}) { this.maxFiles = maxFiles; this.cache = new Map(); }
  async get(filePath) {
    let index = this.cache.get(filePath);
    if (!index) index = new SessionLogIndex(filePath);
    this.cache.delete(filePath); this.cache.set(filePath, index);
    while (this.cache.size > this.maxFiles) this.cache.delete(this.cache.keys().next().value);
    return index.update();
  }
}

export class HistoryParser {
  constructor({ indexCache = new SessionLogIndexCache() } = {}) {
    this.indexCache = indexCache; this.paths = new Map(); this.loads = new Map();
  }
  loadSession(id) {
    if (!this.loads.has(id)) this.loads.set(id, this._loadSession(id).finally(() => this.loads.delete(id)));
    return this.loads.get(id);
  }
  async _loadSession(id) {
    if (!this.paths.has(id)) await this.listSessions();
    const filePath = this.paths.get(id);
    if (!filePath) throw Object.assign(new Error('invalid_session'), { status: 400 });
    const index = await this.indexCache.get(filePath);
    if (!index.parsed) index.parsed = { entries: [], next: 0, calls: new Map(), turn: null, nearest: new Map() };
    const state = index.parsed;
    while (state.next < index.lines.length) {
      const line = index.lines[state.next++];
      if (line.deferred) {
        state.entries.push({ id: `o:${line.offset}`, kind: 'marker', deferred: true, bytes: line.length,
          fields: { body: `Oversized record · ${line.length} bytes. Expand to view complete content.` } });
        continue;
      }
      let record;
      const text = await index.readLine(line);
      try { record = withoutReasoning(JSON.parse(text)); }
      catch { state.entries.push({ id: `o:${line.offset}`, kind: 'internal', fields: { body: text } }); continue; }
      const parsed = await this.parseRecord(record, line.offset, state, id);
      state.entries.push(...(parsed.length ? parsed : [{ id: `o:${line.offset}`, kind: 'internal', fields: { body: record } }]));
    }
    return { index, entries: state.entries, generation: index.generation };
  }
  async expandEntry(id, entryId) {
    const loaded = await this.loadSession(id);
    const line = loaded.index.lines.find(row => row.offset === Number(entryId.split(':')[1]));
    if (!line) throw Object.assign(new Error('invalid_cursor'), { status: 400 });
    if (!line.deferred) return loaded.entries.find(row => row.id === entryId);
    const raw = await loaded.index.readLine(line);
    let record;
    try { record = withoutReasoning(JSON.parse(raw)); } catch { return { id: entryId, kind: 'internal', fields: { body: raw } }; }
    const entries = await this.parseRecord(record, line.offset, { calls: new Map(), nearest: new Map() }, id);
    // Preserve every block of a deferred record under the existing entry id.
    const fields = {}, binaries = {};
    for (const [i, entry] of entries.entries()) {
      for (const [key, value] of Object.entries(entry.fields || {})) fields[`${key}_${i}`] = value;
      for (const [key, value] of Object.entries(entry.binaries || {})) binaries[`${key}_${i}`] = value;
    }
    fields.body = omitBinaryPayloads(record);
    return { id: entryId, kind: 'internal', fields, binaries };
  }
}

function omitBinaryPayloads(value) {
  if (Array.isArray(value)) return value.map(omitBinaryPayloads);
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'base64' && typeof value.data === 'string') {
    return { ...value, data: '[Binary attachment available separately]' };
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, omitBinaryPayloads(child)]));
}
