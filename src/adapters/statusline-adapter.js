import fs from 'node:fs';
import path from 'node:path';
import { readJson, readJsonlTail } from '../lib/json-files.js';
import { ok, unavailable } from '../lib/result.js';
import { isStale } from '../lib/time.js';

const SUPPORTED = new Set(['context_usage', 'token_usage', 'session_cost', 'cache_hit_rate', 'rate_limits']);

function fileUpdatedAt(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

export class StatusLineAdapter {
  constructor(config) {
    this.name = 'statusline';
    this.config = config;
    this.dir = path.join(config.zylosDir, 'activity-monitor');
  }

  supports(metric) {
    return SUPPORTED.has(metric);
  }

  statusline() {
    const filePath = path.join(this.dir, 'statusline.json');
    return { filePath, result: readJson(filePath) };
  }

  async resolve(metric) {
    const { filePath, result } = this.statusline();
    if (!result.ok) return this.costLogFallback(metric, result.error);
    const data = result.value;
    const updatedAt = fileUpdatedAt(filePath);

    const availability = isStale(updatedAt, 300) ? 'stale' : 'ok';

    if (metric === 'context_usage') {
      return {
        ...ok({
        metric,
        source: this.name,
        updatedAt,
        value: {
          usedPercentage: data.context_window?.used_percentage ?? null,
          remainingPercentage: data.context_window?.remaining_percentage ?? null,
          windowSize: data.context_window?.context_window_size ?? null,
          inputTokens: data.context_window?.total_input_tokens ?? null,
          outputTokens: data.context_window?.total_output_tokens ?? null
        }
        }),
        availability
      };
    }

    if (metric === 'token_usage') {
      const current = data.context_window?.current_usage || {};
      return {
        ...ok({
        metric,
        source: this.name,
        updatedAt,
        value: {
          input: data.context_window?.total_input_tokens ?? null,
          output: data.context_window?.total_output_tokens ?? null,
          currentInput: current.input_tokens ?? null,
          currentOutput: current.output_tokens ?? null,
          cacheRead: current.cache_read_input_tokens ?? null,
          cacheCreation: current.cache_creation_input_tokens ?? null
        }
        }),
        availability
      };
    }

    if (metric === 'session_cost') {
      return {
        ...ok({
        metric,
        source: this.name,
        updatedAt,
        value: {
          usd: data.cost?.total_cost_usd ?? null,
          durationMs: data.cost?.total_duration_ms ?? null,
          apiDurationMs: data.cost?.total_api_duration_ms ?? null,
          sessionId: data.session_id || null
        }
        }),
        availability
      };
    }

    if (metric === 'cache_hit_rate') {
      const current = data.context_window?.current_usage || {};
      const cacheRead = Number(current.cache_read_input_tokens || 0);
      const input = Number(current.input_tokens || 0);
      const denominator = cacheRead + input;
      return {
        ...ok({
        metric,
        source: this.name,
        updatedAt,
        value: {
          percentage: denominator ? Math.round((cacheRead / denominator) * 1000) / 10 : null,
          cacheRead,
          input
        },
        confidence: denominator ? 'medium' : 'low'
        }),
        availability
      };
    }

    if (metric === 'rate_limits') {
      const rateLimits = data.rate_limits || {};
      const value = {
        fiveHour: {
          usedPercentage: rateLimits.five_hour?.used_percentage ?? null,
          resetsAt: rateLimits.five_hour?.resets_at ?? null
        },
        sevenDay: {
          usedPercentage: rateLimits.seven_day?.used_percentage ?? null,
          resetsAt: rateLimits.seven_day?.resets_at ?? null
        }
      };
      const hasData = value.fiveHour.usedPercentage != null || value.sevenDay.usedPercentage != null;
      return {
        ...ok({
        metric,
        source: this.name,
        updatedAt,
        value,
        confidence: hasData ? 'high' : 'none'
        }),
        availability: hasData ? availability : 'missing'
      };
    }

    return unavailable({ metric, source: this.name, reason: 'unsupported_metric' });
  }

  costLogFallback(metric, priorReason) {
    if (!['session_cost', 'context_usage'].includes(metric)) {
      return unavailable({ metric, source: this.name, reason: priorReason });
    }
    const filePath = path.join(this.dir, 'cost-log.jsonl');
    const result = readJsonlTail(filePath, 1);
    if (!result.ok || result.value.length === 0) return unavailable({ metric, source: this.name, reason: priorReason });
    const last = result.value[result.value.length - 1];
    if (metric === 'session_cost') {
      return ok({
        metric,
        source: this.name,
        updatedAt: last.ended_at || fileUpdatedAt(filePath),
        value: {
          usd: last.cost_usd ?? null,
          sessionId: last.session_id || null
        },
        confidence: 'low'
      });
    }
    return ok({
      metric,
      source: this.name,
      updatedAt: last.ended_at || fileUpdatedAt(filePath),
      value: {
        usedPercentage: last.context_used_pct ?? null,
        sessionId: last.session_id || null
      },
      confidence: 'low'
    });
  }

  async health() {
    return {
      source: this.name,
      ok: fs.existsSync(path.join(this.dir, 'statusline.json')),
      detail: path.join(this.dir, 'statusline.json')
    };
  }
}
