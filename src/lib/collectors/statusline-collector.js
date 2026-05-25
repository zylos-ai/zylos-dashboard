import fs from 'node:fs';
import path from 'node:path';

export class StatuslineCollector {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this._watcher = null;
    this._debounceTimer = null;
    this._lastHash = null;
    this._statusFilePath = path.join(config.zylosDir, 'activity-monitor', 'statusline.json');
    this._runtimeInfo = null;
  }

  async collect() {
    const now = new Date().toISOString();
    let data;

    try {
      const raw = fs.readFileSync(this._statusFilePath, 'utf8');
      data = JSON.parse(raw);
    } catch {
      this.store.upsertSourceHealth('statusline', 'collector_liveness', 'stale', {
        reason: 'file_unreadable',
        path: this._statusFilePath,
        last_check: now
      });
      return;
    }

    const hash = simpleHash(JSON.stringify(data));
    if (hash === this._lastHash) return;
    this._lastHash = hash;

    const sessionId = data.session_id || null;
    let written = 0;

    if (data.context_window?.used_percentage != null) {
      this.store.insertMetric({
        timestamp: now, runtime: 'claude', session_id: sessionId,
        metric_name: 'context_pct', metric_value: data.context_window.used_percentage,
        source: 'statusline', confidence: 'actual'
      });
      written++;
    }

    if (data.cost?.total_cost_usd != null) {
      this.store.insertMetric({
        timestamp: now, runtime: 'claude', session_id: sessionId,
        metric_name: 'session_cost', metric_value: data.cost.total_cost_usd,
        source: 'statusline', confidence: 'actual'
      });
      written++;
    }

    if (data.rate_limits?.five_hour?.used_percentage != null) {
      this.store.insertMetric({
        timestamp: now, runtime: 'claude', session_id: sessionId,
        metric_name: 'rate_limit', metric_value: data.rate_limits.five_hour.used_percentage,
        dimensions: { period: '5h', '5h': data.rate_limits.five_hour.used_percentage, '7d': data.rate_limits?.seven_day?.used_percentage, resets_at: data.rate_limits.five_hour.resets_at || null },
        source: 'statusline', confidence: 'actual'
      });
      written++;
    }

    if (data.rate_limits?.seven_day?.used_percentage != null) {
      this.store.insertMetric({
        timestamp: now, runtime: 'claude', session_id: sessionId,
        metric_name: 'rate_limit_7d', metric_value: data.rate_limits.seven_day.used_percentage,
        dimensions: { period: '7d', resets_at: data.rate_limits.seven_day.resets_at || null },
        source: 'statusline', confidence: 'actual'
      });
      written++;
    }

    const cw = data.context_window?.current_usage;
    if (cw && cw.cache_read_input_tokens != null) {
      const totalIn = (cw.input_tokens || 0) + (cw.cache_creation_input_tokens || 0) + (cw.cache_read_input_tokens || 0);
      if (totalIn > 0) {
        this.store.insertMetric({
          timestamp: now, runtime: 'claude', session_id: sessionId,
          metric_name: 'cache_hit_rate', metric_value: cw.cache_read_input_tokens / totalIn,
          source: 'statusline_current_usage', confidence: 'actual'
        });
        written++;
      }
    }

    this._runtimeInfo = {
      model: data.model?.display_name || data.model?.id || null,
      model_id: data.model?.id || null,
      effort: data.effort?.level || null,
      cc_version: data.version || null
    };

    if (written > 0) {
      this.store.upsertSourceHealth('statusline', 'collector_liveness', 'healthy', {
        last_success: now, metrics_written: written
      });
      this.store.upsertSourceHealth('statusline', 'runtime_progress', 'healthy', {
        last_success: now,
        runtime: 'claude'
      });
    }

    return { written, data };
  }

  start() {
    this.stop();
    const dir = path.dirname(this._statusFilePath);
    const filename = path.basename(this._statusFilePath);
    try {
      this._watcher = fs.watch(dir, (eventType, changed) => {
        if (changed !== filename) return;
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => this.collect(), 50);
      });
      this._watcher.on('error', () => {});
    } catch {
      // directory doesn't exist yet — fall back to a slow poll until it appears
      this._watcher = setInterval(() => {
        if (fs.existsSync(dir)) { this.stop(); this.start(); }
      }, 30_000);
      this._watcher.unref?.();
    }
  }

  getRuntimeInfo() {
    return this._runtimeInfo;
  }

  stop() {
    clearTimeout(this._debounceTimer);
    if (this._watcher) {
      if (typeof this._watcher.close === 'function') this._watcher.close();
      else clearInterval(this._watcher);
      this._watcher = null;
    }
  }
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}
