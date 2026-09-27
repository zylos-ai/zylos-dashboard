import { DEFAULT_OBSERVER_SIZE, validObserverSize } from '../../public/js/observer-size.js';
import { command, targetArgs } from './observer-tmux-state.js';

export function parseObserverSize(stdout) {
  const match = /^(\d+) (\d+) (off|on|[2-5])$/.exec(String(stdout).trim());
  if (!match) return null;
  const statusLines = match[3] === 'off' ? 0 : match[3] === 'on' ? 1 : Number(match[3]);
  const size = { cols: Number(match[1]), rows: Number(match[2]) + statusLines };
  return validObserverSize(size) ? size : null;
}

// One monitor is owned by each service, independent of the number of viewers.
// Stopping or changing generation fences any command that is still in flight.
export class ObserverSizeMonitor {
  constructor({ exec = command, intervalMs = 2000, onChange = () => {} } = {}) {
    this.exec = exec;
    this.intervalMs = intervalMs;
    this.onChange = onChange;
    this.size = DEFAULT_OBSERVER_SIZE;
    this.active = null;
    this.timer = null;
    this.pending = null;
    this.epoch = 0;
  }

  start(active) {
    if (this.active === active && this.timer) return this.pending || Promise.resolve(this.size);
    this.stop();
    this.active = active;
    this.size = DEFAULT_OBSERVER_SIZE;
    this.timer = setInterval(() => { this.poll(); }, this.intervalMs);
    this.timer.unref?.();
    return this.poll();
  }

  poll() {
    if (!this.active) return Promise.resolve(this.size);
    if (this.pending) return this.pending;
    const active = this.active;
    const epoch = this.epoch;
    const pending = (async () => {
      try {
        if (!['claude-main', 'codex-main'].includes(active.target) || !active.tmuxPath) return this.size;
        const result = await this.exec(active.tmuxPath, targetArgs(active,
          'display-message', '-p', '-t', `=${active.target}:`, '#{window_width} #{window_height} #{status}'));
        const size = parseObserverSize(result.stdout);
        if (this.epoch === epoch && this.active === active && size &&
            (size.cols !== this.size.cols || size.rows !== this.size.rows)) {
          this.size = Object.freeze(size);
          this.onChange(this.size, active);
        }
      } catch { /* Keep the last valid size and retry while viewers remain. */ }
      return this.size;
    })().finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }

  stop() {
    this.epoch += 1;
    clearInterval(this.timer);
    this.timer = null;
    this.active = null;
    this.pending = null;
  }
}
