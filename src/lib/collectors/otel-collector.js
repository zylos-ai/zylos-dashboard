export class OTelCollector {
  constructor(store, config, { stateEngine } = {}) {
    this.store = store;
    this.config = config;
    this._stateEngine = stateEngine || null;
    this._timer = null;
    this._lastIngest = null;
  }

  _resolveSessionId(otelSessionId) {
    if (otelSessionId) return otelSessionId;
    return this._stateEngine?.getCurrentSessionId?.() || null;
  }

  ingestTraces(resourceSpans) {
    const now = new Date().toISOString();
    let written = 0;

    for (const rs of resourceSpans || []) {
      const sessionId = this._resolveSessionId(extractAttr(rs.resource?.attributes, 'session.id'));
      for (const ss of rs.scopeSpans || []) {
        for (const span of ss.spans || []) {
          const spanType = extractAttr(span.attributes, 'span.type');
          if (spanType === 'llm_request') {
            written += this._processLlmSpan(span, sessionId, now);
          }
        }
      }
    }

    if (written > 0) {
      this._lastIngest = now;
      this.store.upsertSourceHealth('otel_reader', 'collector_liveness', 'healthy', { last_success: now });
      this.store.upsertSourceHealth('otel_events', 'runtime_progress', 'healthy', { last_success: now, spans_processed: written });
    }

    return written;
  }

  ingestLogs(resourceLogs) {
    const now = new Date().toISOString();
    let written = 0;

    for (const rl of resourceLogs || []) {
      const sessionId = this._resolveSessionId(extractAttr(rl.resource?.attributes, 'session.id'));
      for (const sl of rl.scopeLogs || []) {
        for (const log of sl.logRecords || []) {
          const eventName = extractAttr(log.attributes, 'event.name');
          if (eventName === 'api_request') {
            written += this._processApiRequestLog(log, sessionId, now);
          }
        }
      }
    }

    if (written > 0) {
      this._lastIngest = now;
      this.store.upsertSourceHealth('otel_reader', 'collector_liveness', 'healthy', { last_success: now });
    }

    return written;
  }

  ingestMetrics(resourceMetrics) {
    const now = new Date().toISOString();
    let written = 0;

    for (const rm of resourceMetrics || []) {
      const sessionId = this._resolveSessionId(extractAttr(rm.resource?.attributes, 'session.id'));
      for (const sm of rm.scopeMetrics || []) {
        for (const metric of sm.metrics || []) {
          if (metric.name === 'claude_code.cost.usage') {
            written += this._processCostMetric(metric, sessionId, now);
          } else if (metric.name === 'claude_code.token.usage') {
            written += this._processTokenMetric(metric, sessionId, now);
          }
        }
      }
    }

    if (written > 0) {
      this._lastIngest = now;
      this.store.upsertSourceHealth('otel_reader', 'collector_liveness', 'healthy', { last_success: now });
    }

    return written;
  }

  _processLlmSpan(span, sessionId, now) {
    let written = 0;
    const attrs = span.attributes || [];
    const inputTokens = numAttr(attrs, 'input_tokens') || 0;
    const outputTokens = numAttr(attrs, 'output_tokens') || 0;
    const cacheReadTokens = numAttr(attrs, 'cache_read_tokens') || 0;
    const cacheCreationTokens = numAttr(attrs, 'cache_creation_tokens') || 0;

    const totalIn = inputTokens + cacheCreationTokens + cacheReadTokens;

    if (totalIn > 0) {
      this.store.insertMetric({
        timestamp: now, runtime: 'claude', session_id: sessionId,
        metric_name: 'cache_hit_rate', metric_value: cacheReadTokens / totalIn,
        source: 'otel_token_usage', confidence: 'actual'
      });

      this.store.insertMetric({
        timestamp: now, runtime: 'claude', session_id: sessionId,
        metric_name: 'api_request_tokens', metric_value: totalIn,
        dimensions: { cache_read: cacheReadTokens, cache_creation: cacheCreationTokens, input: inputTokens, output: outputTokens },
        source: 'otel_llm_span', confidence: 'actual'
      });
      written += 2;
    }

    return written;
  }

  _processApiRequestLog(log, sessionId, now) {
    let written = 0;
    const attrs = log.attributes || [];
    const costUsd = numAttr(attrs, 'cost_usd');

    if (costUsd != null) {
      this.store.insertMetric({
        timestamp: now, runtime: 'claude', session_id: sessionId,
        metric_name: 'session_cost', metric_value: costUsd,
        dimensions: { model: strAttr(attrs, 'model'), source: 'per_request' },
        source: 'otel_cost_sum', confidence: 'actual'
      });

      this.store.insertMetric({
        timestamp: now, runtime: 'claude', session_id: sessionId,
        metric_name: 'api_request_cost', metric_value: costUsd,
        dimensions: { model: strAttr(attrs, 'model') },
        source: 'otel_api_log', confidence: 'actual'
      });
      written += 2;
    }

    return written;
  }

  _processCostMetric(metric, sessionId, now) {
    let written = 0;
    const dataPoints = metric.sum?.dataPoints || [];
    for (const dp of dataPoints) {
      const value = dp.asDouble ?? dp.asInt ?? null;
      if (value != null) {
        this.store.insertMetric({
          timestamp: now, runtime: 'claude', session_id: sessionId,
          metric_name: 'daily_cost', metric_value: value,
          dimensions: { model: extractAttr(dp.attributes, 'model') },
          source: 'otel_cost_sum', confidence: 'actual'
        });
        written++;
      }
    }
    return written;
  }

  _processTokenMetric(metric, sessionId, now) {
    const dataPoints = metric.sum?.dataPoints || [];
    let cacheRead = 0;
    let totalInput = 0;

    for (const dp of dataPoints) {
      const value = dp.asDouble ?? dp.asInt ?? 0;
      const tokenType = extractAttr(dp.attributes, 'type');
      if (tokenType === 'cache_read') cacheRead += value;
      if (['input', 'cache_read', 'cache_creation'].includes(tokenType)) totalInput += value;
    }

    if (totalInput > 0) {
      this.store.insertMetric({
        timestamp: now, runtime: 'claude', session_id: sessionId,
        metric_name: 'cache_hit_rate', metric_value: cacheRead / totalInput,
        source: 'otel_token_usage', confidence: 'actual'
      });
      return 1;
    }
    return 0;
  }

  async collect() {
    const now = new Date().toISOString();
    const lastIngestAge = this._lastIngest ? (Date.now() - new Date(this._lastIngest).getTime()) / 1000 : null;

    if (!this._lastIngest || lastIngestAge > 120) {
      this.store.upsertSourceHealth('otel_reader', 'collector_liveness', 'stale', {
        reason: this._lastIngest ? 'no_recent_data' : 'awaiting_first_ingest',
        last_ingest: this._lastIngest,
        last_check: now
      });
      this.store.upsertSourceHealth('otel_events', 'runtime_progress', 'stale', {
        reason: this._lastIngest ? 'no_recent_data' : 'awaiting_first_ingest',
        last_check: now
      });
    }
  }

  start(intervalMs = 10_000) {
    this.stop();
    this._timer = setInterval(() => this.collect(), intervalMs);
    this._timer.unref();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

function extractAttr(attrs, key) {
  if (!attrs) return null;
  if (Array.isArray(attrs)) {
    const found = attrs.find(a => a.key === key);
    if (!found) return null;
    const v = found.value;
    return v?.stringValue ?? v?.intValue ?? v?.doubleValue ?? v?.boolValue ?? null;
  }
  return attrs[key] ?? null;
}

function numAttr(attrs, key) {
  const v = extractAttr(attrs, key);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strAttr(attrs, key) {
  const v = extractAttr(attrs, key);
  return v != null ? String(v) : null;
}
