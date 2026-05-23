import fs from 'node:fs';
import crypto from 'node:crypto';
import { modelPricesForRuntime, normalizeServiceTier } from '../config.js';

const PER_MTOK = 1_000_000;

export class CodexRolloutCollector {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this._timer = null;
    this._metadataByPath = new Map();
    this._onEvent = null;
  }

  collect() {
    const mapping = this.store.latestCodexRolloutPath?.('codex');
    const now = new Date().toISOString();

    if (!mapping?.transcript_path) {
      this.store.upsertSourceHealth('codex_rollout', 'collector_liveness', 'unavailable', {
        reason: 'no_hook_transcript_path',
        last_checked: now
      });
      return 0;
    }

    let stat;
    try {
      stat = fs.statSync(mapping.transcript_path);
    } catch (err) {
      this.store.upsertSourceHealth('codex_rollout', 'collector_liveness', 'unavailable', {
        reason: 'rollout_unreadable',
        error: err.code || err.message,
        transcript_path: mapping.transcript_path,
        session_id: mapping.session_id,
        last_checked: now
      });
      return 0;
    }

    const cursor = this.store.getCodexRolloutCursor?.(mapping.transcript_path);
    let offset = cursor?.byte_offset || 0;
    if (stat.size < offset) offset = 0;

    const sessionMeta = this._getTranscriptMetadata(mapping.transcript_path);

    if (stat.size === offset) {
      const backfilled = offset > 0 ? this._backfillRateLimits(mapping, sessionMeta) : 0;
      this.store.upsertSourceHealth('codex_rollout', 'collector_liveness', 'stale', {
        transcript_path: mapping.transcript_path,
        session_id: mapping.session_id,
        byte_offset: offset,
        metrics_written: backfilled,
        last_checked: now
      });
      return backfilled;
    }

    const length = stat.size - offset;
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(mapping.transcript_path, 'r');
    try {
      fs.readSync(fd, buf, 0, length, offset);
    } finally {
      fs.closeSync(fd);
    }

    const chunk = buf.toString('utf8');
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline === -1) {
      this.store.upsertSourceHealth('codex_rollout', 'collector_liveness', 'stale', {
        reason: 'partial_line',
        transcript_path: mapping.transcript_path,
        session_id: mapping.session_id,
        byte_offset: offset,
        last_checked: now
      });
      return 0;
    }

    const complete = chunk.slice(0, lastNewline + 1);
    const lines = complete.split('\n').filter(l => l.trim());
    const nextOffset = offset + Buffer.byteLength(complete, 'utf8');

    let written = 0;
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      written += this._ingestEvent(event, mapping, sessionMeta);
    }

    this.store.upsertCodexRolloutCursor?.({
      transcriptPath: mapping.transcript_path,
      byteOffset: nextOffset,
      sessionId: mapping.session_id
    });

    this.store.upsertSourceHealth('codex_rollout', 'collector_liveness', 'healthy', {
      transcript_path: mapping.transcript_path,
      session_id: mapping.session_id,
      byte_offset: nextOffset,
      metrics_written: written,
      last_success: now
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
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _ingestEvent(event, mapping, sessionMeta = {}) {
    const payload = event.payload || {};
    if (event.type === 'turn_context' && payload.model) {
      sessionMeta.model = payload.model;
      sessionMeta.serviceTier = normalizeServiceTier(payload.service_tier ?? payload.serviceTier);
      return 0;
    }
    if (event.type === 'response_item') {
      return this._ingestResponseItem(payload, timestampForEvent(event), mapping);
    }
    if (event.type !== 'event_msg' || !payload.type) return 0;

    const timestamp = event.timestamp || payload.timestamp || new Date().toISOString();
    if (payload.type === 'token_count') {
      return this._ingestTokenCount(payload.info || {}, timestamp, mapping, {
        rateLimits: payload.rate_limits || payload.info?.rate_limits,
        model: sessionMeta.model,
        serviceTier: normalizeServiceTier(payload.service_tier ?? payload.serviceTier ?? payload.info?.service_tier ?? payload.info?.serviceTier ?? sessionMeta.serviceTier)
      });
    }
    if (payload.type === 'task_complete') {
      return this._ingestTaskComplete(payload, timestamp, mapping);
    }
    if (payload.type === 'response_item') {
      return this._ingestResponseItem(payload, timestamp, mapping);
    }
    return 0;
  }

  _ingestTokenCount(info, timestamp, mapping, context = {}) {
    let written = 0;
    const lastUsage = info.last_token_usage || {};
    const totalUsage = info.total_token_usage || {};
    const usage = Object.keys(lastUsage).length > 0 ? lastUsage : totalUsage;
    const model = info.model || info.model_slug || context.model || null;
    const serviceTier = normalizeServiceTier(info.service_tier ?? info.serviceTier ?? context.serviceTier);
    const eventId = info.id || crypto.randomUUID();

    const contextInput = numberOrNull(lastUsage.input_tokens);
    const contextWindow = numberOrNull(info.model_context_window);
    if (contextInput != null && contextWindow && contextWindow > 0) {
      this.store.insertMetric({
        timestamp,
        runtime: 'codex',
        session_id: mapping.session_id,
        metric_name: 'context_pct',
        metric_value: (contextInput / contextWindow) * 100,
        dimensions: { input_tokens: contextInput, model_context_window: contextWindow, model },
        source: 'rollout',
        confidence: 'actual'
      });
      written++;
    }

    written += this._ingestRateLimit(context.rateLimits?.primary, 'rate_limit', timestamp, mapping);
    written += this._ingestRateLimit(context.rateLimits?.secondary, 'rate_limit_7d', timestamp, mapping);

    const tokenDims = normalizeUsage(usage);
    const totalInput = tokenDims.input + tokenDims.cache_read + tokenDims.cache_creation;
    if (totalInput > 0 || tokenDims.output > 0 || tokenDims.reasoning > 0) {
      tokenDims.model = model;
      tokenDims.service_tier = serviceTier;
      tokenDims.event_id = eventId;
      this.store.insertMetric({
        timestamp,
        runtime: 'codex',
        session_id: mapping.session_id,
        metric_name: 'api_request_tokens',
        metric_value: totalInput,
        dimensions: tokenDims,
        source: 'jsonl_usage',
        confidence: 'actual'
      });
      written++;

      if (totalInput > 0) {
        this.store.insertMetric({
          timestamp,
          runtime: 'codex',
          session_id: mapping.session_id,
          metric_name: 'cache_hit_rate',
          metric_value: tokenDims.cache_read / totalInput,
          dimensions: { event_id: eventId, model, service_tier: serviceTier },
          source: 'jsonl_usage',
          confidence: 'actual'
        });
        written++;
      }

      const price = this._resolveModelPrice(model, serviceTier);
      const cost = this._calculateCost(tokenDims, price);
      if (cost != null) {
        this.store.insertMetric({
          timestamp,
          runtime: 'codex',
          session_id: mapping.session_id,
          metric_name: 'api_request_cost',
          metric_value: cost,
          dimensions: { event_id: eventId, model, service_tier: serviceTier },
          source: 'jsonl_usage',
          confidence: 'estimated'
        });
        written++;
      } else {
        this.store.upsertSourceHealth('codex_cost', 'collector_liveness', 'unavailable', {
          reason: 'missing_model_price',
          model,
          last_checked: timestamp
        });
      }
    }

    return written;
  }

  _ingestRateLimit(limit, metricName, timestamp, mapping) {
    if (!limit || typeof limit !== 'object') return 0;
    const value = numberOrNull(limit.percent_used ?? limit.usage_pct ?? limit.used_percent);
    if (value == null) return 0;
    this.store.insertMetric({
      timestamp,
      runtime: 'codex',
      session_id: mapping.session_id,
      metric_name: metricName,
      metric_value: value,
      dimensions: {
        window_minutes: limit.window_minutes ?? null,
        resets_at: limit.resets_at ?? null
      },
      source: 'rollout',
      confidence: 'actual'
    });
    return 1;
  }

  _ingestTaskComplete(payload, timestamp, mapping) {
    let written = 0;
    const duration = numberOrNull(payload.duration_ms);
    const ttft = numberOrNull(payload.time_to_first_token_ms);
    if (duration != null) {
      this.store.insertMetric({
        timestamp,
        runtime: 'codex',
        session_id: mapping.session_id,
        metric_name: 'turn_duration',
        metric_value: duration,
        dimensions: null,
        source: 'rollout',
        confidence: 'actual'
      });
      written++;
    }
    if (ttft != null) {
      this.store.insertMetric({
        timestamp,
        runtime: 'codex',
        session_id: mapping.session_id,
        metric_name: 'ttft',
        metric_value: ttft,
        dimensions: null,
        source: 'rollout',
        confidence: 'actual'
      });
      written++;
    }
    return written;
  }

  _ingestResponseItem(payload, timestamp, mapping) {
    const item = payload.item || payload.response_item || payload || {};
    if (item.type === 'message' && item.role === 'assistant') {
      return this._ingestAssistantMessage(item, payload, timestamp, mapping);
    }
    if (item.type !== 'function_call' && item.type !== 'function_call_output') return 0;
    const name = item.name || payload.name || null;
    const callId = item.call_id || payload.call_id || null;
    if (!name && !callId) return 0;
    this.store.insertEvent({
      id: crypto.randomUUID(),
      ingest_id: `codex-rollout-${mapping.session_id || 'unknown'}-${callId || crypto.randomUUID()}-${item.type}`,
      timestamp,
      runtime: 'codex',
      session_id: mapping.session_id,
      event_type: item.type === 'function_call' ? 'tool_call' : 'tool_result',
      category: 'tool',
      summary: name || 'function call',
      duration_ms: null,
      metadata: { tool_name: name, call_id: callId, source_event: 'response_item' },
      source: 'rollout',
      confidence: 'actual'
    });
    return 1;
  }

  _ingestAssistantMessage(item, payload, timestamp, mapping) {
    const textBlocks = Array.isArray(item.content)
      ? item.content
        .filter(c => c.type === 'output_text' && c.text?.trim())
        .map(c => c.text.trim())
      : [];
    if (textBlocks.length === 0) return 0;

    const text = textBlocks.join('\n');
    const event = {
      id: crypto.randomUUID(),
      ingest_id: this._assistantMessageIngestId(mapping.session_id, timestamp, text),
      timestamp,
      runtime: 'codex',
      session_id: mapping.session_id,
      event_type: 'assistant_message',
      category: 'assistant',
      summary: text.length > 500 ? text.slice(0, 497) + '...' : text,
      duration_ms: null,
      metadata: {
        role: item.role,
        phase: payload.phase || item.phase || null,
        content_types: [...new Set(item.content.map(c => c.type).filter(Boolean))]
      },
      source: 'rollout',
      confidence: 'actual'
    };

    const result = this.store.insertEvent(event);
    if (result?.inserted && this._onEvent) {
      this._onEvent(event);
    }
    return result?.inserted ? 1 : 0;
  }

  _assistantMessageIngestId(sessionId, timestamp, text) {
    const hash = crypto.createHash('sha256')
      .update(`${sessionId || 'unknown'}\n${timestamp || ''}\n${text}`)
      .digest('hex')
      .slice(0, 24);
    return `codex-assistant-${sessionId || 'unknown'}-${hash}`;
  }

  _resolveModelPrice(model, serviceTier = 'standard') {
    if (!model) return null;
    const prices = modelPricesForRuntime(this.config, 'codex', serviceTier);
    for (const [prefix, price] of Object.entries(prices)) {
      if (model.startsWith(prefix)) return price;
    }
    return null;
  }

  _calculateCost(usage, price) {
    if (!price) return null;
    const input = usage.input * price.input / PER_MTOK;
    const output = usage.output * price.output / PER_MTOK;
    const cacheRead = usage.cache_read * price.cacheRead / PER_MTOK;
    const cacheCreation = usage.cache_creation * price.cacheCreation / PER_MTOK;
    return input + output + cacheRead + cacheCreation;
  }

  _getTranscriptMetadata(transcriptPath) {
    const stat = fs.statSync(transcriptPath);
    const cached = this._metadataByPath.get(transcriptPath);
    if (cached?.size === stat.size) return cached;

    const metadata = { size: stat.size };
    const cachedModel = cached?.model;
    if (cachedModel) metadata.model = cachedModel;
    try {
      const text = fs.readFileSync(transcriptPath, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === 'turn_context' && event.payload?.model) {
          metadata.model = event.payload.model;
          metadata.serviceTier = normalizeServiceTier(event.payload.service_tier ?? event.payload.serviceTier);
        }
        if (event.type === 'event_msg' && event.payload?.type === 'token_count' && event.payload.rate_limits) {
          metadata.rateLimits = event.payload.rate_limits;
          metadata.rateLimitTimestamp = event.timestamp || event.payload.timestamp || null;
        }
      }
    } catch {
      // Missing metadata is non-fatal; token and context metrics can still be recorded.
    }

    this._metadataByPath.set(transcriptPath, metadata);
    return metadata;
  }

  _backfillRateLimits(mapping, sessionMeta) {
    if (!sessionMeta?.rateLimits) return 0;

    const hasRateMetric = (name) => this.store.queryMetrics({ name })
      .some(row => row.session_id === mapping.session_id && row.source === 'rollout');

    let written = 0;
    const timestamp = sessionMeta.rateLimitTimestamp || new Date().toISOString();
    if (!hasRateMetric('rate_limit')) {
      written += this._ingestRateLimit(sessionMeta.rateLimits.primary, 'rate_limit', timestamp, mapping);
    }
    if (!hasRateMetric('rate_limit_7d')) {
      written += this._ingestRateLimit(sessionMeta.rateLimits.secondary, 'rate_limit_7d', timestamp, mapping);
    }
    return written;
  }
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timestampForEvent(event) {
  return event.timestamp || event.payload?.timestamp || new Date().toISOString();
}

function normalizeUsage(usage) {
  return {
    input: numberOrNull(usage.input_tokens) || 0,
    output: numberOrNull(usage.output_tokens) || 0,
    cache_read: numberOrNull(usage.cached_input_tokens ?? usage.cache_read_input_tokens) || 0,
    cache_creation: numberOrNull(usage.cache_creation_input_tokens) || 0,
    reasoning: numberOrNull(usage.reasoning_output_tokens ?? usage.reasoning_tokens) || 0
  };
}
