import os from 'node:os';
import fs from 'node:fs';

export class SystemCollector {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this._cache = null;
    this._timer = null;
    this._onUpdate = null;
    this._prevCpuTimes = null;
  }

  async collect() {
    const now = new Date().toISOString();
    const collectedAt = Date.now();
    const runtime = this.config.runtime || 'claude';
    const data = {};

    try {
      const cpuInfo = os.cpus();
      const cpuCount = cpuInfo.length || 1;
      const curTimes = { idle: 0, total: 0 };
      for (const core of cpuInfo) {
        const t = core.times;
        curTimes.idle += t.idle;
        curTimes.total += t.user + t.nice + t.sys + t.idle + t.irq;
      }

      if (this._prevCpuTimes) {
        const idleDelta = curTimes.idle - this._prevCpuTimes.idle;
        const totalDelta = curTimes.total - this._prevCpuTimes.total;
        data.cpu_pct = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0;

        this.store.insertMetric({
          timestamp: now, runtime,
          metric_name: 'cpu_pct',
          metric_value: data.cpu_pct,
          dimensions: { cpus: cpuCount },
          source: 'system',
          confidence: 'actual'
        });
      }

      this._prevCpuTimes = curTimes;
    } catch (err) {
      process.stderr.write(`[system-collector] CPU error: ${err.message}\n`);
    }

    try {
      data.mem_total_bytes = os.totalmem();
      data.mem_used_bytes = data.mem_total_bytes - os.freemem();

      this.store.insertMetric({
        timestamp: now, runtime,
        metric_name: 'mem_used_bytes',
        metric_value: data.mem_used_bytes,
        source: 'system',
        confidence: 'actual'
      });
      this.store.insertMetric({
        timestamp: now, runtime,
        metric_name: 'mem_total_bytes',
        metric_value: data.mem_total_bytes,
        source: 'system',
        confidence: 'actual'
      });
    } catch (err) {
      process.stderr.write(`[system-collector] Memory error: ${err.message}\n`);
    }

    try {
      const stats = fs.statfsSync(this.config.zylosDir);
      const totalBytes = stats.blocks * stats.bsize;
      const availBytes = stats.bavail * stats.bsize;
      data.disk_free_bytes = availBytes;
      data.disk_used_pct = totalBytes > 0 ? (1 - availBytes / totalBytes) * 100 : 0;

      this.store.insertMetric({
        timestamp: now, runtime,
        metric_name: 'disk_used_pct',
        metric_value: data.disk_used_pct,
        dimensions: { path: this.config.zylosDir },
        source: 'system',
        confidence: 'actual'
      });
      this.store.insertMetric({
        timestamp: now, runtime,
        metric_name: 'disk_free_bytes',
        metric_value: data.disk_free_bytes,
        dimensions: { path: this.config.zylosDir },
        source: 'system',
        confidence: 'actual'
      });
    } catch (err) {
      process.stderr.write(`[system-collector] Disk error: ${err.message}\n`);
    }

    this._cache = { ...data, collectedAt };

    this.store.upsertSourceHealth('system_sampler', 'collector_liveness', 'healthy', {
      last_success: now
    });

    if (this._onUpdate) this._onUpdate(this._cache);
  }

  async warmup() {
    await this.collect();
    await new Promise((r) => setTimeout(r, 200));
    await this.collect();
  }

  getLatestSystemData() {
    return this._cache;
  }

  start(intervalMs = 30_000) {
    this.stop();
    this._timer = setInterval(() => this.collect(), intervalMs);
    this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
