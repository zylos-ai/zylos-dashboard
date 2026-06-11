function dayBoundsUTC(tz, daysBack = 0) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(now)) {
    if (type !== 'literal') p[type] = parseInt(value);
  }
  const asIfUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offsetMs = asIfUTC - now.getTime();
  const midnightUTC = Date.UTC(p.year, p.month - 1, p.day) - offsetMs;
  const since = new Date(midnightUTC - daysBack * 86400000);
  return { since: since.toISOString(), until: now.toISOString() };
}

const METRIC_CHAINS = {
  context_pct: [
    { metric: 'statusline_summary', source: 'statusline', dimension: 'context_pct', confidence: 'actual' },
    { metric: 'usage_event', source: 'jsonl_usage', dimension: 'context_pct', confidence: 'actual' },
    { source: 'statusline', confidence: 'actual' },
    { source: 'rollout', confidence: 'actual' },
    { source: 'derived_token_estimate', confidence: 'estimated' }
  ],
  rate_limit: [
    { metric: 'statusline_summary', source: 'statusline', dimension: 'rate_limit', confidence: 'actual' },
    { metric: 'usage_event', source: 'jsonl_usage', dimension: 'rate_limit', confidence: 'actual' },
    { source: 'statusline', confidence: 'actual' },
    { source: 'rollout', confidence: 'actual' }
  ],
  rate_limit_7d: [
    { metric: 'statusline_summary', source: 'statusline', dimension: 'rate_limit_7d', confidence: 'actual' },
    { metric: 'usage_event', source: 'jsonl_usage', dimension: 'rate_limit_7d', confidence: 'actual' },
    { source: 'statusline', confidence: 'actual' },
    { source: 'rollout', confidence: 'actual' }
  ],
  effort_level: [
    { source: 'statusline', confidence: 'actual' }
  ],
  session_cost: [
    { metric: 'statusline_summary', source: 'statusline', dimension: 'session_cost', confidence: 'actual' },
    { source: 'statusline', confidence: 'actual' },
    { source: 'jsonl_usage', confidence: 'actual' },
    { source: 'token_price_estimated', confidence: 'estimated' }
  ],
  daily_cost: [
    { source: 'jsonl_usage', confidence: 'actual' },
    { source: 'statusline_delta', confidence: 'inferred' },
    { source: 'token_price_estimated', confidence: 'estimated' }
  ],
  cache_hit_rate: [
    { metric: 'statusline_summary', source: 'statusline', dimension: 'cache_hit_rate', confidence: 'actual' },
    { metric: 'usage_event', source: 'jsonl_usage', dimension: 'cache_hit_rate', confidence: 'actual' },
    { source: 'statusline_current_usage', confidence: 'actual' },
    { source: 'jsonl_usage', confidence: 'actual' }
  ],
  cpu_pct: [
    { metric: 'system_summary', source: 'system', dimension: 'cpu_pct', confidence: 'actual' },
    { source: 'system', confidence: 'actual' }
  ],
  mem_used_bytes: [
    { metric: 'system_summary', source: 'system', dimension: 'mem_used_bytes', confidence: 'actual' },
    { source: 'system', confidence: 'actual' }
  ],
  mem_total_bytes: [
    { metric: 'system_summary', source: 'system', dimension: 'mem_total_bytes', confidence: 'actual' },
    { source: 'system', confidence: 'actual' }
  ],
  disk_used_pct: [
    { metric: 'system_summary', source: 'system', dimension: 'disk_used_pct', confidence: 'actual' },
    { source: 'system', confidence: 'actual' }
  ],
  disk_free_bytes: [
    { metric: 'system_summary', source: 'system', dimension: 'disk_free_bytes', confidence: 'actual' },
    { source: 'system', confidence: 'actual' }
  ],
  ttft: [
    { source: 'rollout', confidence: 'actual' }
  ],
  turn_duration: [
    { source: 'rollout', confidence: 'actual' }
  ],
  tool_duration: [
    { source: 'hook_postToolUse', confidence: 'actual' }
  ]
};

const DEFAULT_STALENESS_S = 120;

// Statusline only updates while the runtime is active, so an idle agent keeps
// reporting its last rate-limit reading (e.g. a red 100%) long after the
// window's resets_at has passed. Once the window rolled over, the stored
// percentage describes a window that no longer exists — callers should treat
// it as expired/unknown until the next statusline event fills the fresh
// window (#224). resets_at arrives as unix seconds (statusline) but tolerate
// milliseconds, mirroring fmtResetTime() on the frontend.
export function rateLimitWindowExpired(dimensions, metricName, now = Date.now()) {
  const dims = dimensions || {};
  const raw = dims[`${metricName}_resets_at`] ?? dims.resets_at ?? null;
  const ts = Number(raw);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return ms <= now;
}

export class MetricResolver {
  constructor(store, collectors, config, { stateEngine } = {}) {
    this.store = store;
    this.collectors = collectors;
    this.config = config;
    this._stateEngine = stateEngine || null;
    this._stalenessThreshold = (config.metricStalenessSeconds || DEFAULT_STALENESS_S) * 1000;
  }

  resolveAggregated(metricName) {
    const tz = process.env.TZ || 'UTC';
    const sessionId = this._stateEngine?.getCurrentSessionId?.() || null;
    const today = dayBoundsUTC(tz);
    const week = dayBoundsUTC(tz, 7);

    if (metricName === 'session_cost' || metricName === 'cost') {
      return {
        session: sessionId ? this.store.aggregateCost({ sessionId }) : null,
        today: this.store.aggregateCost(today),
        seven_day: this.store.aggregateCost(week)
      };
    }
    if (metricName === 'cache_hit_rate' || metricName === 'cache') {
      return {
        session: sessionId ? this.store.aggregateCacheRate({ sessionId }) : null,
        today: this.store.aggregateCacheRate(today),
        seven_day: this.store.aggregateCacheRate(week)
      };
    }
    return null;
  }

  resolve(metricName) {
    const chain = METRIC_CHAINS[metricName];
    if (!chain) {
      return {
        value: null,
        selected_source: null,
        freshness: null,
        confidence: 'none',
        alternatives: [],
        fallback_reason: `Unknown metric: ${metricName}`
      };
    }

    const now = Date.now();
    const alternatives = [];
    let selectedSource = null;
    let selectedValue = null;
    let selectedFreshness = null;
    let selectedConfidence = 'none';
    let fallbackReason = null;
    let selectedDimensions = null;
    let preferredSource = chain[0].source;

    for (const link of chain) {
      const queryMetric = link.metric || metricName;
      const latest = this._getLatestMetric(queryMetric, link.source);
      if (!latest) continue;
      const dimensions = latest.dimensions
        ? (typeof latest.dimensions === 'string' ? JSON.parse(latest.dimensions) : latest.dimensions)
        : null;
      const value = link.dimension ? dimensions?.[link.dimension] : latest.metric_value;
      if (value == null) continue;

      const ageMs = now - new Date(latest.timestamp).getTime();
      const fresh = ageMs < this._stalenessThreshold;

      alternatives.push({
        source: link.source,
        metric: queryMetric,
        value,
        age_s: Math.floor(ageMs / 1000),
        fresh,
        confidence: link.confidence
      });

      if (!selectedSource && fresh) {
        selectedSource = link.source;
        selectedValue = value;
        selectedFreshness = Math.floor(ageMs / 1000);
        selectedConfidence = link.confidence;
        selectedDimensions = dimensions;

        if (link.source !== preferredSource) {
          fallbackReason = `${preferredSource} data stale or unavailable, using ${link.source}`;
        }
      }
    }

    if (!selectedSource && alternatives.length > 0) {
      const best = alternatives[0];
      const bestLink = chain.find(link => (link.source === best.source) && ((link.metric || metricName) === best.metric));
      const latest = this._getLatestMetric(best.metric || metricName, best.source);
      selectedSource = best.source;
      selectedValue = best.value;
      selectedFreshness = best.age_s;
      selectedConfidence = best.confidence;
      selectedDimensions = latest?.dimensions
        ? (typeof latest.dimensions === 'string' ? JSON.parse(latest.dimensions) : latest.dimensions)
        : null;
      if (bestLink?.dimension && selectedDimensions && selectedDimensions[bestLink.dimension] == null) selectedDimensions = null;
      fallbackReason = `All sources stale, using most recent: ${best.source} (${best.age_s}s old)`;
    }

    return {
      value: selectedValue,
      dimensions: selectedDimensions,
      selected_source: selectedSource,
      freshness: selectedFreshness,
      confidence: selectedConfidence,
      alternatives,
      fallback_reason: fallbackReason
    };
  }

  _getLatestMetric(metricName, source) {
    try {
      const rows = this.store.queryMetrics({
        name: metricName,
        since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        until: new Date().toISOString()
      });

      const matching = rows.filter(r => r.source === source);
      if (matching.length === 0) return null;
      return matching[matching.length - 1];
    } catch {
      return null;
    }
  }
}
