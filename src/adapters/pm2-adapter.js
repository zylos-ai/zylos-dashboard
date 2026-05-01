import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ok, unavailable } from '../lib/result.js';

const execFileAsync = promisify(execFile);

export class PM2Adapter {
  constructor(config) {
    this.name = 'pm2';
    this.config = config;
  }

  supports(metric) {
    return metric === 'pm2_services';
  }

  async resolve(metric) {
    try {
      const { stdout } = await execFileAsync('pm2', ['jlist'], {
        timeout: 5000,
        maxBuffer: 1024 * 1024 * 4
      });
      const processes = JSON.parse(stdout || '[]').map((proc) => ({
        name: proc.name,
        pid: proc.pid,
        status: proc.pm2_env?.status || 'unknown',
        restarts: proc.pm2_env?.restart_time || 0,
        uptime: proc.pm2_env?.pm_uptime || null,
        memory: proc.monit?.memory || 0,
        cpu: proc.monit?.cpu || 0
      }));
      return ok({
        metric,
        source: this.name,
        updatedAt: new Date().toISOString(),
        value: {
          count: processes.length,
          online: processes.filter((proc) => proc.status === 'online').length,
          processes
        }
      });
    } catch (err) {
      return unavailable({ metric, source: this.name, availability: 'error', reason: err.message });
    }
  }

  async health() {
    const result = await this.resolve('pm2_services');
    return {
      source: this.name,
      ok: result.availability === 'ok',
      detail: result.fallbackReason || null
    };
  }
}
