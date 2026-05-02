import { FileAdapter } from '../adapters/file-adapter.js';
import { HookAdapter } from '../adapters/hook-adapter.js';
import { PM2Adapter } from '../adapters/pm2-adapter.js';
import { SQLiteAdapter } from '../adapters/sqlite-adapter.js';
import { StatusLineAdapter } from '../adapters/statusline-adapter.js';
import { TelemetryAdapter } from '../adapters/telemetry-adapter.js';
import { rankResult, unavailable } from './result.js';

export const METRICS = [
  { name: 'agent_state', domain: 'status', label: 'Agent state' },
  { name: 'current_tool', domain: 'status', label: 'Current tool' },
  { name: 'tool_calls', domain: 'tools', label: 'Tool calls' },
  { name: 'tool_failures', domain: 'tools', label: 'Tool failures' },
  { name: 'tool_duration', domain: 'tools', label: 'Tool duration' },
  { name: 'context_usage', domain: 'status', label: 'Context usage' },
  { name: 'token_usage', domain: 'cost', label: 'Token usage' },
  { name: 'session_cost', domain: 'cost', label: 'Session cost' },
  { name: 'rate_limits', domain: 'cost', label: 'Rate limits' },
  { name: 'llm_latency', domain: 'performance', label: 'LLM latency' },
  { name: 'session_lifecycle', domain: 'status', label: 'Session lifecycle' },
  { name: 'permission_requests', domain: 'tools', label: 'Permission requests' },
  { name: 'health', domain: 'status', label: 'Health' },
  { name: 'cache_hit_rate', domain: 'cost', label: 'Cache hit rate' },
  { name: 'ttft', domain: 'performance', label: 'TTFT' },
  { name: 'usage_leverage', domain: 'cost', label: 'Usage leverage' },
  { name: 'pm2_services', domain: 'services', label: 'PM2 services' },
  { name: 'messages', domain: 'communication', label: 'Messages' },
  { name: 'scheduled_tasks', domain: 'tasks', label: 'Scheduled tasks' }
];

const ADAPTER_ORDER = ['telemetry', 'hook', 'statusline', 'file', 'sqlite', 'pm2'];

export class Resolver {
  constructor(config) {
    this.config = config;
    this.adapters = [
      new TelemetryAdapter(config),
      new HookAdapter(config),
      new StatusLineAdapter(config),
      new FileAdapter(config),
      new SQLiteAdapter(config),
      new PM2Adapter(config)
    ];
  }

  metricCatalog() {
    return METRICS;
  }

  async resolve(metric, runtime = 'auto') {
    const results = [];
    for (const adapter of this.adapters) {
      if (!adapter.supports(metric, runtime)) continue;
      try {
        results.push(await adapter.resolve(metric, runtime));
      } catch (err) {
        results.push(unavailable({
          metric,
          source: adapter.name,
          availability: 'error',
          reason: err.message
        }));
      }
    }

    if (results.length === 0) {
      return unavailable({
        metric,
        source: null,
        capability: 'unsupported',
        availability: 'missing',
        reason: 'unsupported'
      });
    }

    const preferred = results[0]?.source || null;
    const sorted = [...results].sort((a, b) => {
      const rankDelta = rankResult(b) - rankResult(a);
      if (rankDelta !== 0) return rankDelta;
      return ADAPTER_ORDER.indexOf(a.source) - ADAPTER_ORDER.indexOf(b.source);
    });
    const selected = sorted[0];
    return {
      ...selected,
      preferredSource: preferred,
      fallbackReason: selected.source !== preferred ? `${preferred}_${results[0]?.availability || 'unavailable'}` : selected.fallbackReason,
      candidates: results.map((result) => ({
        source: result.source,
        availability: result.availability,
        updatedAt: result.updatedAt,
        reason: result.fallbackReason
      }))
    };
  }

  async resolveAll(runtime = 'auto') {
    const entries = await Promise.all(METRICS.map(async (metric) => [metric.name, await this.resolve(metric.name, runtime)]));
    return Object.fromEntries(entries);
  }

  async summary(runtime = 'auto') {
    const metrics = await this.resolveAll(runtime);
    return {
      runtime,
      generatedAt: new Date().toISOString(),
      status: {
        agent: metrics.agent_state,
        health: metrics.health,
        currentTool: metrics.current_tool,
        context: metrics.context_usage
      },
      cost: {
        session: metrics.session_cost,
        tokens: metrics.token_usage,
        cacheHitRate: metrics.cache_hit_rate,
        rateLimits: metrics.rate_limits
      },
      tools: {
        calls: metrics.tool_calls,
        failures: metrics.tool_failures,
        duration: metrics.tool_duration
      },
      operations: {
        messages: metrics.messages,
        scheduledTasks: metrics.scheduled_tasks,
        pm2Services: metrics.pm2_services
      },
      metrics
    };
  }

  async adapterHealth() {
    return Promise.all(this.adapters.map((adapter) => adapter.health()));
  }
}
