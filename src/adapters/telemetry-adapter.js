import { unavailable } from '../lib/result.js';

const SUPPORTED = new Set([
  'tool_calls',
  'tool_failures',
  'tool_duration',
  'context_usage',
  'token_usage',
  'session_cost',
  'llm_latency',
  'cache_hit_rate',
  'ttft'
]);

export class TelemetryAdapter {
  constructor(config) {
    this.name = 'telemetry';
    this.config = config;
  }

  supports(metric) {
    return SUPPORTED.has(metric);
  }

  async resolve(metric) {
    return unavailable({
      metric,
      source: this.name,
      availability: 'missing',
      reason: 'phase2_otel_collector_not_enabled',
      capability: 'planned'
    });
  }

  async health() {
    return {
      source: this.name,
      ok: false,
      detail: 'phase2_otel_collector_not_enabled'
    };
  }
}
