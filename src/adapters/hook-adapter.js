import { unavailable } from '../lib/result.js';

const SUPPORTED = new Set([
  'tool_calls',
  'tool_failures',
  'agent_state',
  'session_lifecycle',
  'permission_requests'
]);

export class HookAdapter {
  constructor(config) {
    this.name = 'hook';
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
      reason: 'phase2_hook_ingestion_not_enabled',
      capability: 'planned'
    });
  }

  async health() {
    return {
      source: this.name,
      ok: false,
      detail: 'phase2_hook_ingestion_not_enabled'
    };
  }
}
