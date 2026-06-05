import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fastModeMultiplierForRuntime, modelPricesForRuntime } from '../config.js';
import { Sanitizer } from '../sanitizer.js';

const PER_MTOK = 1_000_000;
const ASSISTANT_MESSAGE_SUMMARY_LIMIT = 500;

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
    this._lastUserPromptAt = null;
    this._sanitizer = config.sanitizer || new Sanitizer(config.zylosDir || path.join(process.env.HOME, 'zylos'));
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
    const prices = modelPricesForRuntime(this.config, 'claude');
    for (const [prefix, price] of Object.entries(prices)) {
      if (model.startsWith(prefix)) return price;
    }
    return null;
  }

  _calculateCost(usage, price, speed) {
    if (!price) return null;
    const multiplier = speed === 'fast' ? (fastModeMultiplierForRuntime(this.config, 'claude') || 6) : 1;
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

      const uuid = msg.uuid;
      if (!uuid || this._seenUuids.has(uuid)) continue;
      this._seenUuids.add(uuid);

      const timestamp = msg.timestamp || now;
      const sessionId = msg.sessionId || null;

      if (msg.type === 'user') {
        const userContent = msg.message?.content;
        const isToolResult = Array.isArray(userContent) &&
          userContent.every(c => c.type === 'tool_result');
        if (!isToolResult) {
          written += this._emitEvent({
            ingestId: `user-${uuid}`,
            timestamp, sessionId,
            eventType: 'user_prompt_submit',
            category: 'turn',
            summary: 'User prompt',
            metadata: { uuid }
          });
          this._lastUserPromptAt = timestamp;
        }
        continue;
      }

      if (msg.type !== 'assistant') continue;

      const message = msg.message;
      if (!message) continue;

      const content = message.content;
      const usage = message.usage;
      const model = message.model;

      const projects = this._extractProjectsFromContent(content);

      if (usage) {
        const speed = usage.speed || 'standard';
        usageWritten += this._ingestUsage(usage, model, sessionId, timestamp, uuid, speed, projects);
      }

      if (!Array.isArray(content)) continue;

      const textBlocks = content
        .filter(c => c.type === 'text' && c.text?.trim())
        .map(c => c.text.trim());

      if (textBlocks.length === 0) continue;

      const text = textBlocks.join('\n');
      const hasToolUse = content.some(c => c.type === 'tool_use');
      const turnDuration = this._lastUserPromptAt
        ? Math.max(0, new Date(timestamp).getTime() - new Date(this._lastUserPromptAt).getTime())
        : null;

      try {
        const summary = this._sanitizer.safeAssistantSummary(text, ASSISTANT_MESSAGE_SUMMARY_LIMIT);
        if (!summary) continue;
        const event = {
          id: crypto.randomUUID(),
          ingest_id: `conv-${uuid}`,
          timestamp,
          runtime: 'claude',
          session_id: sessionId,
          event_type: 'assistant_message',
          category: 'assistant',
          summary,
          duration_ms: hasToolUse ? null : turnDuration,
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

      if (!hasToolUse) {
        written += this._emitEvent({
          ingestId: `stop-${uuid}`,
          timestamp, sessionId,
          eventType: 'stop',
          category: 'turn',
          summary: 'Turn complete',
          durationMs: turnDuration,
          metadata: { uuid }
        });
        this._lastUserPromptAt = null;
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

  _emitEvent({ ingestId, timestamp, sessionId, eventType, category, summary, durationMs, metadata }) {
    try {
      const event = {
        id: crypto.randomUUID(),
        ingest_id: ingestId,
        timestamp,
        runtime: 'claude',
        session_id: sessionId,
        event_type: eventType,
        category,
        summary,
        duration_ms: durationMs ?? null,
        metadata: metadata ? JSON.stringify(metadata) : null,
        source: 'conversation',
        confidence: 'actual'
      };
      const result = this.store.insertEvent(event);
      if (result?.inserted && this._onEvent) {
        this._onEvent({ ...event, metadata });
      }
      return result?.inserted ? 1 : 0;
    } catch (err) {
      if (!err.message?.includes('UNIQUE constraint')) {
        process.stderr.write(`[conversation-collector] ${err.message}\n`);
      }
      return 0;
    }
  }

  _ingestUsage(usage, model, sessionId, timestamp, uuid, speed, projects = []) {
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheCreation = usage.cache_creation_input_tokens || 0;
    const totalInput = inputTokens + cacheRead + cacheCreation;

    if (totalInput === 0 && outputTokens === 0) return 0;

    if (this._hasUsageForUuid(uuid)) return 0;

    const dims = {
      input: inputTokens,
      total_input: totalInput,
      uncached_input: inputTokens,
      output: outputTokens,
      cache_read: cacheRead,
      cache_creation: cacheCreation,
      runtime_semantics: 'claude_split_cache',
      model,
      speed,
      uuid
    };
    if (projects.length > 0) dims.projects = projects;

    let written = 0;
    this.store.insertMetric({
      timestamp, runtime: 'claude', session_id: sessionId,
      metric_name: 'api_request_tokens', metric_value: totalInput,
      dimensions: dims,
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

  _extractProjectsFromContent(content) {
    if (!Array.isArray(content)) return [];
    const projects = new Set();
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      const fp = block.input?.file_path || block.input?.path;
      if (fp) {
        const project = this._extractProject(fp);
        if (project) projects.add(project);
        continue;
      }
      const cmd = block.input?.command;
      if (cmd) {
        const project = this._extractProjectFromCommand(cmd);
        if (project) projects.add(project);
      }
    }
    return [...projects];
  }

  _extractProject(filePath) {
    if (!filePath) return null;
    const parts = filePath.replace(/^\/+/, '').split('/');
    const wsIdx = parts.indexOf('workspace');
    if (wsIdx >= 0 && parts[wsIdx + 1]) return parts[wsIdx + 1];
    const skillsIdx = parts.indexOf('skills');
    if (skillsIdx >= 0 && parts[skillsIdx + 1]) return parts[skillsIdx + 1];
    return null;
  }

  _extractProjectFromCommand(cmd) {
    if (!cmd) return null;
    const m = cmd.match(/(?:workspace|skills)\/([^/\s]+)/);
    return m ? m[1] : null;
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
