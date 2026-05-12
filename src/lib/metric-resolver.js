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
    { source: 'statusline', confidence: 'actual' },
    { source: 'rollout', confidence: 'actual' },
    { source: 'derived_token_estimate', confidence: 'estimated' }
  ],
  rate_limit: [
    { source: 'statusline', confidence: 'actual' },
    { source: 'rollout', confidence: 'actual' }
  ],
  rate_limit_7d: [
    { source: 'statusline', confidence: 'actual' }
  ],
  effort_level: [
    { source: 'statusline', confidence: 'actual' }
  ],
  session_cost: [
    { source: 'statusline', confidence: 'actual' },
    { source: 'otel_cost_sum', confidence: 'actual' },
    { source: 'token_price_estimated', confidence: 'estimated' }
  ],
  daily_cost: [
    { source: 'otel_cost_sum', confidence: 'actual' },
    { source: 'statusline_delta', confidence: 'inferred' },
    { source: 'token_price_estimated', confidence: 'estimated' }
  ],
  cache_hit_rate: [
    { source: 'statusline_current_usage', confidence: 'actual' },
    { source: 'otel_token_usage', confidence: 'actual' }
  ],
  tool_duration: [
    { source: 'otel_span', confidence: 'actual' },
    { source: 'hook_postToolUse', confidence: 'actual' }
  ]
};

const DEFAULT_STALENESS_S = 120;

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
      const latest = this._getLatestMetric(metricName, link.source);
      if (!latest) continue;

      const ageMs = now - new Date(latest.timestamp).getTime();
      const fresh = ageMs < this._stalenessThreshold;

      alternatives.push({
        source: link.source,
        value: latest.metric_value,
        age_s: Math.floor(ageMs / 1000),
        fresh,
        confidence: link.confidence
      });

      if (!selectedSource && fresh) {
        selectedSource = link.source;
        selectedValue = latest.metric_value;
        selectedFreshness = Math.floor(ageMs / 1000);
        selectedConfidence = link.confidence;
        selectedDimensions = latest.dimensions ? (typeof latest.dimensions === 'string' ? JSON.parse(latest.dimensions) : latest.dimensions) : null;

        if (link.source !== preferredSource) {
          fallbackReason = `${preferredSource} data stale or unavailable, using ${link.source}`;
        }
      }
    }

    if (!selectedSource && alternatives.length > 0) {
      const best = alternatives[0];
      selectedSource = best.source;
      selectedValue = best.value;
      selectedFreshness = best.age_s;
      selectedConfidence = best.confidence;
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
