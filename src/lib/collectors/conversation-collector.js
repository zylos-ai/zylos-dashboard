import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PER_MTOK = 1_000_000;

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
    this._restoreOffset();
  }

  _restoreOffset() {
    try {
      const health = this.store.db.prepare(
        "SELECT extra FROM source_health WHERE name = 'conversation_reader' AND signal_type = 'byte_offset'"
      ).get();
      if (health?.extra) {
        const data = JSON.parse(health.extra);
        if (data.file && data.offset) {
          this._currentFile = data.file;
          this._lastByteOffset = data.offset;
        }
      }
    } catch { /* first run or schema mismatch — start from zero */ }
  }

  _persistOffset() {
    if (!this._currentFile) return;
    this.store.upsertSourceHealth('conversation_reader', 'byte_offset', 'tracking', {
      file: this._currentFile, offset: this._lastByteOffset
    });
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

  _hasUsageForUuid(uuid) {
    try {
      const row = this.store.db.prepare(
        "SELECT 1 FROM metric_points WHERE source = 'jsonl_usage' AND metric_name = 'api_request_tokens' AND dimensions LIKE ? LIMIT 1"
      ).get(`%"uuid":"${uuid}"%`);
      return !!row;
    } catch { return false; }
  }

  _resolveModelPrice(model) {
    if (!model) return null;
    const prices = this.config.modelPrices || {};
    for (const [prefix, price] of Object.entries(prices)) {
      if (model.startsWith(prefix)) return price;
    }
    return null;
  }

  _calculateCost(usage, price, speed) {
    if (!price) return null;
    const multiplier = speed === 'fast' ? 6 : 1;
    const input = (usage.input_tokens || 0) * price.input * multiplier / PER_MTOK;
    const output = (usage.output_tokens || 0) * price.output * multiplier / PER_MTOK;
    const cacheRead = (usage.cache_read_input_tokens || 0) * price.cacheRead * multiplier / PER_MTOK;
    const cacheCreation = (usage.cache_creation_input_tokens || 0) * price.cacheCreation * multiplier / PER_MTOK;
    return input + output + cacheRead + cacheCreation;
  }

  collect() {
    const jsonlPath = this._resolveJsonlPath();
    if (!jsonlPath) return 0;

    if (jsonlPath !== this._currentFile) {
      this._currentFile = jsonlPath;
      this._lastByteOffset = 0;
      this._seenUuids.clear();
      this._persistOffset();
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
    let usageWritten = 0;
    const now = new Date().toISOString();

    for (const line of lines) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.type !== 'assistant') continue;
      const uuid = msg.uuid;
      if (!uuid || this._seenUuids.has(uuid)) continue;
      this._seenUuids.add(uuid);

      const message = msg.message;
      if (!message) continue;

      const content = message.content;
      const usage = message.usage;
      const model = message.model;
      const timestamp = msg.timestamp || now;
      const sessionId = msg.sessionId || null;

      if (usage) {
        const speed = usage.speed || 'standard';
        usageWritten += this._ingestUsage(usage, model, sessionId, timestamp, uuid, speed);
      }

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
          timestamp,
          runtime: 'claude',
          session_id: sessionId,
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

    // Persist offset only AFTER all writes succeed — crash-safe: on restart,
    // unacknowledged lines are re-read; uuid dedup in _seenUuids + dimensions
    // prevents double-counting.
    this._persistOffset();

    if (written > 0) {
      this.store.upsertSourceHealth('conversation_reader', 'collector_liveness', 'healthy', {
        last_success: now, messages_ingested: written
      });
    }

    return written;
  }

  _ingestUsage(usage, model, sessionId, timestamp, uuid, speed) {
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheCreation = usage.cache_creation_input_tokens || 0;
    const totalInput = inputTokens + cacheRead + cacheCreation;

    if (totalInput === 0 && outputTokens === 0) return 0;

    if (this._hasUsageForUuid(uuid)) return 0;

    let written = 0;
    this.store.insertMetric({
      timestamp, runtime: 'claude', session_id: sessionId,
      metric_name: 'api_request_tokens', metric_value: totalInput,
      dimensions: { input: inputTokens, output: outputTokens, cache_read: cacheRead, cache_creation: cacheCreation, model, speed, uuid },
      source: 'jsonl_usage', confidence: 'actual'
    });
    written++;

    if (totalInput > 0) {
      this.store.insertMetric({
        timestamp, runtime: 'claude', session_id: sessionId,
        metric_name: 'cache_hit_rate', metric_value: cacheRead / totalInput,
        dimensions: { uuid },
        source: 'jsonl_usage', confidence: 'actual'
      });
      written++;
    }

    const price = this._resolveModelPrice(model);
    const cost = this._calculateCost(usage, price, speed);
    if (cost != null) {
      this.store.insertMetric({
        timestamp, runtime: 'claude', session_id: sessionId,
        metric_name: 'api_request_cost', metric_value: cost,
        dimensions: { model, speed, uuid },
        source: 'jsonl_usage', confidence: 'actual'
      });
      written++;
    }

    this.store.upsertSourceHealth('jsonl_usage', 'collector_liveness', 'healthy', {
      last_success: timestamp, model, tokens: totalInput + outputTokens
    });

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
