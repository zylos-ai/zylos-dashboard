import fs from 'node:fs';
import path from 'node:path';
import { readJson, readJsonlTail } from '../lib/json-files.js';
import { ok, unavailable } from '../lib/result.js';
import { epochToIso, isStale } from '../lib/time.js';

const SUPPORTED = new Set([
  'agent_state',
  'current_tool',
  'tool_calls',
  'tool_failures',
  'tool_duration',
  'context_usage',
  'rate_limits',
  'health',
  'session_lifecycle'
]);

function fileUpdatedAt(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

function lastEventTime(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const stamp = event.timestamp || event.time || event.completed_at || event.started_at || event.ended_at;
    if (stamp) return typeof stamp === 'number' ? epochToIso(stamp) : new Date(stamp).toISOString();
  }
  return null;
}

function sanitizeToolEvent(event) {
  return {
    timestamp: event.timestamp || event.time || event.completed_at || event.started_at || null,
    tool_name: event.tool_name || event.tool || event.name || event.active_tool_name || 'unknown',
    success: event.success ?? event.ok ?? (event.error ? false : null),
    duration_ms: event.duration_ms || event.elapsed_ms || event.runtime_ms || null,
    phase: event.phase || event.event || event.type || null
  };
}

export class FileAdapter {
  constructor(config) {
    this.name = 'file';
    this.config = config;
    this.dir = path.join(config.zylosDir, 'activity-monitor');
  }

  supports(metric) {
    return SUPPORTED.has(metric);
  }

  path(name) {
    return path.join(this.dir, name);
  }

  async resolve(metric) {
    if (metric === 'agent_state') return this.agentState(metric);
    if (metric === 'current_tool') return this.currentTool(metric);
    if (metric === 'health') return this.healthMetric(metric);
    if (metric === 'context_usage') return this.contextUsage(metric);
    if (metric === 'rate_limits') return this.rateLimits(metric);
    if (metric === 'tool_calls') return this.toolCalls(metric);
    if (metric === 'tool_failures') return this.toolFailures(metric);
    if (metric === 'tool_duration') return this.toolDuration(metric);
    if (metric === 'session_lifecycle') return this.sessionLifecycle(metric);
    return unavailable({ metric, source: this.name, availability: 'missing', reason: 'unsupported_metric' });
  }

  agentStatus() {
    const filePath = this.path('agent-status.json');
    const result = readJson(filePath);
    return { filePath, result };
  }

  agentState(metric) {
    const { filePath, result } = this.agentStatus();
    if (!result.ok) return unavailable({ metric, source: this.name, reason: result.error });
    const updatedAt = epochToIso(result.value.last_check) || fileUpdatedAt(filePath);
    const availability = isStale(updatedAt, 30) ? 'stale' : 'ok';
    const value = {
      state: result.value.state || 'unknown',
      thinking: Boolean(result.value.thinking),
      idleSeconds: result.value.idle_seconds ?? null,
      activeTools: result.value.active_tools ?? 0,
      source: result.value.source || null,
      runtimeLaunchAt: epochToIso(result.value.runtime_launch_at),
      health: result.value.health || null
    };
    return { ...ok({ metric, value, source: this.name, updatedAt }), availability };
  }

  currentTool(metric) {
    const { filePath, result } = this.agentStatus();
    if (!result.ok) return unavailable({ metric, source: this.name, reason: result.error });
    const updatedAt = epochToIso(result.value.last_check) || fileUpdatedAt(filePath);
    const value = {
      name: result.value.active_tool_name || null,
      summary: result.value.active_tool_summary || null,
      runningSeconds: result.value.active_tool_running_seconds || 0,
      activeTools: result.value.active_tools || 0
    };
    return ok({ metric, value, source: this.name, updatedAt, confidence: value.name ? 'high' : 'medium' });
  }

  healthMetric(metric) {
    const { filePath, result } = this.agentStatus();
    if (!result.ok) return unavailable({ metric, source: this.name, reason: result.error });
    const updatedAt = epochToIso(result.value.last_check) || fileUpdatedAt(filePath);
    const value = {
      health: result.value.health || 'unknown',
      watchdogPhase: result.value.watchdog_phase || null,
      watchdogBlockReason: result.value.watchdog_block_reason || null,
      inactiveSeconds: result.value.inactive_seconds || 0
    };
    return ok({ metric, value, source: this.name, updatedAt });
  }

  contextUsage(metric) {
    const filePath = this.path('context-monitor-state.json');
    const result = readJson(filePath);
    if (!result.ok) return unavailable({ metric, source: this.name, availability: 'missing', reason: result.error });
    const updatedAt = fileUpdatedAt(filePath);
    const value = {
      usedPercentage: result.value.used_percentage ?? result.value.percent ?? null,
      sessionId: result.value.session_id || null,
      lastCost: result.value.last_cost ?? null
    };
    const availability = value.usedPercentage == null ? 'missing' : (isStale(updatedAt, 300) ? 'stale' : 'ok');
    return { ...ok({ metric, value, source: this.name, updatedAt, confidence: value.usedPercentage == null ? 'none' : 'medium' }), availability };
  }

  rateLimits(metric) {
    const filePath = this.path('usage.json');
    const result = readJson(filePath);
    if (!result.ok) return unavailable({ metric, source: this.name, availability: 'missing', reason: result.error });
    const updatedAt = fileUpdatedAt(filePath);
    const value = {
      fiveHour: {
        usedPercentage: result.value.session?.percent ?? null,
        resetsAt: result.value.session?.resets ?? null
      },
      sevenDay: {
        usedPercentage: result.value.weeklyAll?.percent ?? null,
        resetsAt: result.value.weeklyAll?.resets ?? null
      },
      weeklySonnet: {
        usedPercentage: result.value.weeklySonnet?.percent ?? null,
        resetsAt: result.value.weeklySonnet?.resets ?? null
      }
    };
    const hasData = value.fiveHour.usedPercentage != null || value.sevenDay.usedPercentage != null;
    const availability = hasData ? (isStale(updatedAt, 300) ? 'stale' : 'ok') : 'missing';
    return {
      ...ok({
        metric,
        value,
        source: this.name,
        updatedAt,
        confidence: hasData ? 'medium' : 'none'
      }),
      availability
    };
  }

  toolCalls(metric) {
    const filePath = this.path('tool-events.jsonl');
    const result = readJsonlTail(filePath, 100);
    if (!result.ok) return unavailable({ metric, source: this.name, reason: result.error });
    const events = result.value.map(sanitizeToolEvent);
    return ok({
      metric,
      value: {
        count: events.length,
        recent: events.slice(-25)
      },
      source: this.name,
      updatedAt: lastEventTime(result.value) || fileUpdatedAt(filePath),
      confidence: events.length ? 'medium' : 'low'
    });
  }

  toolFailures(metric) {
    const filePath = this.path('tool-events.jsonl');
    const result = readJsonlTail(filePath, 200);
    if (!result.ok) return unavailable({ metric, source: this.name, reason: result.error });
    const failures = result.value.map(sanitizeToolEvent).filter((event) => event.success === false);
    return ok({
      metric,
      value: {
        count: failures.length,
        recent: failures.slice(-25)
      },
      source: this.name,
      updatedAt: lastEventTime(result.value) || fileUpdatedAt(filePath),
      confidence: result.value.length ? 'medium' : 'low'
    });
  }

  toolDuration(metric) {
    const filePath = this.path('tool-events.jsonl');
    const result = readJsonlTail(filePath, 200);
    if (!result.ok) return unavailable({ metric, source: this.name, reason: result.error });
    const durations = result.value.map(sanitizeToolEvent).map((event) => Number(event.duration_ms)).filter(Number.isFinite);
    const avg = durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null;
    return ok({
      metric,
      value: {
        averageMs: avg,
        sampleCount: durations.length,
        maxMs: durations.length ? Math.max(...durations) : null
      },
      source: this.name,
      updatedAt: lastEventTime(result.value) || fileUpdatedAt(filePath),
      confidence: durations.length ? 'medium' : 'low'
    });
  }

  sessionLifecycle(metric) {
    const switchesPath = this.path('session-switches.jsonl');
    const result = readJsonlTail(switchesPath, 50);
    if (!result.ok) return unavailable({ metric, source: this.name, availability: 'missing', reason: result.error });
    return ok({
      metric,
      value: {
        count: result.value.length,
        recent: result.value.slice(-10)
      },
      source: this.name,
      updatedAt: lastEventTime(result.value) || fileUpdatedAt(switchesPath),
      confidence: result.value.length ? 'medium' : 'low'
    });
  }

  async health() {
    return {
      source: this.name,
      ok: fs.existsSync(this.dir),
      detail: this.dir
    };
  }
}
