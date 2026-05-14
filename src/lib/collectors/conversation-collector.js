import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class ConversationCollector {
  constructor(store, config, { stateEngine } = {}) {
    this.store = store;
    this.config = config;
    this._stateEngine = stateEngine || null;
    this._timer = null;
    this._lastByteOffset = 0;
    this._currentFile = null;
    this._seenUuids = new Set();
    this._onEvent = null;
  }

  _resolveProjectSlug() {
    const zylosDir = this.config.zylosDir || path.join(process.env.HOME, 'zylos');
    const resolved = fs.realpathSync(zylosDir);
    return '-' + resolved.replace(/\//g, '-').replace(/^-/, '');
  }

  _resolveJsonlPath() {
    const sessionId = this._stateEngine?.getCurrentSessionId?.();
    if (!sessionId) return null;
    const projectSlug = this._resolveProjectSlug();
    const projectDir = path.join(
      this.config.homeDir || process.env.HOME,
      '.claude', 'projects', projectSlug
    );
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    return fs.existsSync(jsonlPath) ? jsonlPath : null;
  }

  collect() {
    const jsonlPath = this._resolveJsonlPath();
    if (!jsonlPath) return 0;

    if (jsonlPath !== this._currentFile) {
      this._currentFile = jsonlPath;
      this._lastByteOffset = 0;
      this._seenUuids.clear();
    }

    let stat;
    try { stat = fs.statSync(jsonlPath); } catch { return 0; }
    if (stat.size <= this._lastByteOffset) return 0;

    const buf = Buffer.alloc(stat.size - this._lastByteOffset);
    const fd = fs.openSync(jsonlPath, 'r');
    fs.readSync(fd, buf, 0, buf.length, this._lastByteOffset);
    fs.closeSync(fd);

    const chunk = buf.toString('utf8');
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline === -1) return 0;
    this._lastByteOffset += Buffer.byteLength(chunk.slice(0, lastNewline + 1), 'utf8');

    const lines = chunk.slice(0, lastNewline).split('\n').filter(l => l.trim());

    let written = 0;
    const now = new Date().toISOString();

    for (const line of lines) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.type !== 'assistant') continue;
      const uuid = msg.uuid;
      if (!uuid || this._seenUuids.has(uuid)) continue;
      this._seenUuids.add(uuid);

      const content = msg.message?.content;
      if (!Array.isArray(content)) continue;

      const textBlocks = content
        .filter(c => c.type === 'text' && c.text?.trim())
        .map(c => c.text.trim());

      if (textBlocks.length === 0) continue;

      const text = textBlocks.join('\n');
      const hasToolUse = content.some(c => c.type === 'tool_use');

      const ingestId = `conv-${uuid}`;
      const eventId = crypto.randomUUID();

      try {
        const event = {
          id: eventId,
          ingest_id: ingestId,
          timestamp: msg.timestamp || now,
          runtime: 'claude',
          session_id: msg.sessionId || null,
          event_type: 'assistant_message',
          category: 'assistant',
          summary: text.length > 500 ? text.slice(0, 497) + '...' : text,
          duration_ms: null,
          metadata: JSON.stringify({
            uuid,
            has_tool_use: hasToolUse,
            content_types: [...new Set(content.map(c => c.type))]
          }),
          source: 'conversation',
          confidence: 'actual'
        };
        const result = this.store.insertEvent(event);
        if (result?.inserted) {
          if (this._onEvent) {
            this._onEvent({ ...event, metadata: JSON.parse(event.metadata) });
          }
          written++;
        }
      } catch (err) {
        if (!err.message?.includes('UNIQUE constraint')) {
          process.stderr.write(`[conversation-collector] ${err.message}\n`);
        }
      }
    }

    if (written > 0) {
      this.store.upsertSourceHealth('conversation_reader', 'collector_liveness', 'healthy', {
        last_success: now, messages_ingested: written
      });
    }

    return written;
  }

  start(intervalMs = 5_000) {
    this.stop();
    this.collect();
    this._timer = setInterval(() => this.collect(), intervalMs);
    this._timer.unref();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}
