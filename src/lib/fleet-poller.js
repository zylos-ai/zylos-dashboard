import { agentColor } from './agent-color.js';

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 2500;
// Liveness is connection-based (#180): an agent is OFFLINE only when its SSE
// connection is down and polling fails — never because pushed events are
// sparse (an idle agent legitimately emits nothing for long stretches).
// The idle timeout guards against half-open connections: the server emits
// keepalives every 15s, so 45s of byte silence means the connection is dead.
const DEFAULT_SSE_IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_JITTER_MS = 500;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_RECONNECT_BASE_MS = 1000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function joinUrl(baseUrl, apiPath) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const path = String(apiPath || '').replace(/^\/+/, '');
  return `${base}/${path}`;
}

function nextCompleteLineBreak(buffer) {
  const match = buffer.match(/\r\n|\r|\n/);
  if (!match) return null;
  if (match[0] === '\r' && match.index === buffer.length - 1) return null;
  return match;
}

export class SseEventParser {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buffer = '';
    this.event = 'message';
    this.data = [];
    this.id = null;
  }

  push(chunk) {
    this.buffer += chunk;
    let newline = nextCompleteLineBreak(this.buffer);
    while (newline) {
      const newlineIndex = newline.index;
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + newline[0].length);
      this._processLine(line);
      newline = nextCompleteLineBreak(this.buffer);
    }
  }

  flush() {
    if (this.buffer) {
      this.push('\n');
      this.buffer = '';
    }
  }

  _processLine(line) {
    if (line === '') {
      this._dispatch();
      return;
    }
    if (line.startsWith(':')) return;

    const colon = line.indexOf(':');
    const field = colon >= 0 ? line.slice(0, colon) : line;
    let value = colon >= 0 ? line.slice(colon + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') this.event = value || 'message';
    else if (field === 'data') this.data.push(value);
    else if (field === 'id') this.id = value;
  }

  _dispatch() {
    if (this.data.length === 0) {
      this.event = 'message';
      this.id = null;
      return;
    }
    this.onEvent({
      event: this.event || 'message',
      data: this.data.join('\n'),
      id: this.id
    });
    this.event = 'message';
    this.data = [];
    this.id = null;
  }
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function metricValue(state, name) {
  const source = state?.metrics?.[name] ?? state?.metric?.[name];
  if (source && typeof source === 'object') {
    return source.value ?? source.current ?? source.percent ?? null;
  }
  return source ?? null;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function memPct(systemMetrics) {
  const explicit = numberOrNull(systemMetrics?.mem_pct ?? systemMetrics?.mem_used_pct);
  if (explicit != null) return explicit;
  const used = numberOrNull(systemMetrics?.mem_used_bytes);
  const total = numberOrNull(systemMetrics?.mem_total_bytes);
  return used != null && total > 0 ? (used / total) * 100 : null;
}

function hasUpgrade(runtimeInfo) {
  return Boolean(
    runtimeInfo?.zylos_update ||
    runtimeInfo?.cc_update ||
    runtimeInfo?.cc_restart ||
    runtimeInfo?.codex_update ||
    runtimeInfo?.codex_restart ||
    runtimeInfo?.pending_restart
  );
}

function hasSubagent(state) {
  return Array.isArray(state?.active_subagents) && state.active_subagents.length > 0;
}

function deriveActivity(state) {
  if (state?.running_tools?.length > 0) return state.running_tools[0].tool_detail || state.running_tools[0].tool_name || 'Running tool';
  if (state?.active_subagents?.length > 0) return state.active_subagents[0].last_activity || state.active_subagents[0].description || 'Subagent active';
  return state?.last_prompt?.summary || state?.last_message || state?.reason || null;
}

// Mirror of the single-agent Current Activity feed (renderToolFeed): running
// tools first, a synthetic "thinking" entry when busy with no visible tool.
// Falls back to [] so consumers can degrade to the single-line `activity`.
function deriveActivityFeed(state) {
  const feed = [];
  const tools = Array.isArray(state?.running_tools) ? state.running_tools : [];
  for (const tool of tools.slice(0, 3)) {
    feed.push({
      kind: 'tool',
      label: tool.tool_detail
        ? `${tool.tool_name || 'tool'}: ${tool.tool_detail}`
        : (tool.tool_name || 'Running tool'),
      started_at: tool.started_at || null
    });
  }
  if (feed.length === 0 && String(state?.state || '').toUpperCase() === 'BUSY') {
    feed.push({ kind: 'thinking', label: null, started_at: null });
  }
  return feed;
}

function sanitizeRecord(record) {
  return {
    name: record.name,
    color: record.color,
    hue: record.hue,
    state: record.state,
    activity: record.activity,
    activity_feed: Array.isArray(record.activity_feed) ? record.activity_feed : [],
    rate_limit_pct: record.rate_limit_pct ?? null,
    rate_limit_7d_pct: record.rate_limit_7d_pct ?? null,
    context_pct: record.context_pct,
    cost: record.cost,
    session_cost: record.session_cost,
    daily_cost: record.daily_cost,
    weekly_cost: record.weekly_cost,
    model: record.model,
    effort: record.effort,
    new_session_threshold: record.new_session_threshold,
    cpu_pct: record.cpu_pct,
    mem_pct: record.mem_pct,
    disk_pct: record.disk_pct,
    has_upgrade: record.has_upgrade === true,
    has_subagent: record.has_subagent === true,
    last_seen: record.last_seen,
    pulse_rate: record.pulse_rate,
    health_reason: record.health_reason,
    updated_at: record.updated_at,
    base_url: record.base_url,
    self: record.self === true
  };
}

export function stateToFleetRecord(agentConfig = {}, statePayload = {}, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const self = opts.self === true;
  const name = agentConfig.name ?? statePayload?.agent?.name;
  // Identity color/hue is keyed to the name DISPLAYED on this wall (local
  // fleet config), never the remote's self-reported identity: an unconfigured
  // remote falls back to a hostname-derived hue that can collide with other
  // tiles (issue: Jinglever's hostname hashed to ~the same hue as zylos-01).
  const color = agentConfig.color?.color
    ? agentConfig.color
    : {
        color: agentConfig.color || agentColor(name).color,
        hue: agentConfig.hue ?? agentColor(name).hue
      };
  const runtimeInfo = statePayload?.runtime_info || null;
  const systemMetrics = statePayload?.system_metrics || null;
  const liveState = statePayload?.state || 'UNKNOWN';
  const offline = liveState === 'OFFLINE' || liveState === 'UNKNOWN';
  const pulseRate = self && offline ? 0 : 1;
  const healthReason = liveState === 'IDLE' ? 'idle' : (self && offline ? 'offline' : 'ok');
  return sanitizeRecord({
    name,
    base_url: opts.base_url ?? agentConfig.base_url ?? null,
    color: color?.color,
    hue: color?.hue,
    state: liveState,
    activity: deriveActivity(statePayload),
    activity_feed: deriveActivityFeed(statePayload),
    rate_limit_pct: statePayload?.rate_limit_pct ?? null,
    rate_limit_7d_pct: statePayload?.rate_limit_7d_pct ?? null,
    context_pct: statePayload?.context_pct ?? metricValue(statePayload, 'context_pct'),
    cost: statePayload?.session_cost ?? statePayload?.daily_cost ?? statePayload?.weekly_cost ?? metricValue(statePayload, 'session_cost') ?? metricValue(statePayload, 'daily_cost'),
    session_cost: statePayload?.session_cost ?? metricValue(statePayload, 'session_cost'),
    daily_cost: statePayload?.daily_cost ?? metricValue(statePayload, 'daily_cost'),
    weekly_cost: statePayload?.weekly_cost ?? null,
    model: runtimeInfo?.model || runtimeInfo?.model_id || null,
    effort: runtimeInfo?.effort || runtimeInfo?.service_tier || null,
    new_session_threshold: statePayload?.new_session_threshold ?? null,
    cpu_pct: numberOrNull(systemMetrics?.cpu_pct),
    mem_pct: memPct(systemMetrics),
    disk_pct: numberOrNull(systemMetrics?.disk_pct ?? systemMetrics?.disk_used_pct),
    has_upgrade: hasUpgrade(runtimeInfo),
    has_subagent: hasSubagent(statePayload),
    last_seen: nowIso(nowMs),
    pulse_rate: pulseRate,
    health_reason: healthReason,
    updated_at: nowIso(nowMs),
    self
  });
}

export class FleetPoller {
  constructor(config = {}, options = {}) {
    const fleet = config.fleet || {};
    this.agents = Array.isArray(fleet.agents) ? fleet.agents : [];
    this.pollIntervalMs = toNumber(fleet.poll_interval_ms, DEFAULT_POLL_INTERVAL_MS);
    this.timeoutMs = toNumber(fleet.timeout_ms, DEFAULT_TIMEOUT_MS);
    this.sseIdleTimeoutMs = toNumber(fleet.sse_idle_timeout_ms, DEFAULT_SSE_IDLE_TIMEOUT_MS);
    this.jitterMs = toNumber(fleet.jitter_ms, DEFAULT_JITTER_MS);
    this.reconnectBaseMs = toNumber(fleet.sse_reconnect_base_ms, DEFAULT_RECONNECT_BASE_MS);
    this.reconnectMaxMs = toNumber(fleet.sse_reconnect_max_ms, DEFAULT_RECONNECT_MAX_MS);
    this.fetch = options.fetch || globalThis.fetch;
    this.now = options.now || (() => Date.now());
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.onPoll = typeof options.onPoll === 'function' ? options.onPoll : null;
    this.records = new Map();
    this.tokens = new Map();
    this.streams = new Map();
    this.running = false;
    this.timer = null;

    for (const agent of this.agents) {
      const color = agentColor(agent.name);
      this.records.set(agent.name, sanitizeRecord({
        name: agent.name,
        base_url: agent.base_url,
        color: color.color,
        hue: color.hue,
        state: 'UNKNOWN',
        activity: null,
        context_pct: null,
        cost: null,
        session_cost: null,
        daily_cost: null,
        weekly_cost: null,
        model: null,
        effort: null,
        new_session_threshold: null,
        cpu_pct: null,
        mem_pct: null,
        disk_pct: null,
        has_upgrade: false,
        has_subagent: false,
        last_seen: null,
        pulse_rate: null,
        health_reason: 'not_polled',
        updated_at: nowIso(this.now())
      }));
    }
  }

  start() {
    if (this.running || this.agents.length === 0) return;
    this.running = true;
    this.pollOnce().finally(() => {
      if (!this.running) return;
      for (const agent of this.agents) this._connectSse(agent);
    });
  }

  stop() {
    this.running = false;
    if (this.timer) this.clearTimeout(this.timer);
    this.timer = null;
    for (const stream of this.streams.values()) {
      if (stream.compatibilityTimer) this.clearTimeout(stream.compatibilityTimer);
      if (stream.pollTimer) this.clearTimeout(stream.pollTimer);
      if (stream.reconnectTimer) this.clearTimeout(stream.reconnectTimer);
      if (stream.idleTimer) this.clearTimeout(stream.idleTimer);
      stream.controller?.abort();
    }
    this.streams.clear();
  }

  getFleet() {
    return {
      agents: Array.from(this.records.values()).map(sanitizeRecord),
      count: this.records.size,
      updated_at: nowIso(this.now())
    };
  }

  async getSessionToken(agentName, options = {}) {
    const agent = this.agents.find(a => a.name === agentName);
    if (!agent) {
      const err = new Error('unknown_agent');
      err.status = 404;
      throw err;
    }
    return this._ensureToken(agent, { force: Boolean(options.force) });
  }

  async pollOnce() {
    await Promise.all(this.agents.map(agent => this._pollAgent(agent)));
    const fleet = this.getFleet();
    this.onPoll?.(fleet);
    return fleet;
  }

  _scheduleNext() {
    if (!this.running) return;
    const jitter = this.jitterMs > 0 ? Math.floor(Math.random() * this.jitterMs) : 0;
    this.timer = this.setTimeout(() => {
      this.pollOnce().finally(() => this._scheduleNext());
    }, this.pollIntervalMs + jitter);
    this.timer.unref?.();
  }

  _streamState(agent) {
    let state = this.streams.get(agent.name);
    if (!state) {
      state = {
        controller: null,
        compatibilityTimer: null,
        pollTimer: null,
        reconnectTimer: null,
        idleTimer: null,
        backoffMs: this.reconnectBaseMs,
        connecting: false,
        seenFleetState: false
      };
      this.streams.set(agent.name, state);
    }
    return state;
  }

  async _ensureToken(agent, { force = false } = {}) {
    const cached = this.tokens.get(agent.name);
    const now = this.now();
    if (!force && cached?.token && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now) {
      return cached.token;
    }

    const resp = await fetchWithTimeout(this.fetch, joinUrl(agent.base_url, '/api/auth/token'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent.read_api_key}` }
    }, this.timeoutMs);

    if (resp.status === 404) {
      const err = new Error('version_unsupported');
      err.reason = 'version_unsupported';
      err.status = 404;
      throw err;
    }
    if (resp.status === 401 || resp.status === 403) {
      const err = new Error('auth_failed');
      err.reason = 'auth_failed';
      err.status = resp.status;
      throw err;
    }
    if (!resp.ok) {
      const err = new Error('unreachable');
      err.reason = 'unreachable';
      err.status = resp.status;
      throw err;
    }

    const body = await resp.json();
    if (!body?.token) {
      const err = new Error('auth_failed');
      err.reason = 'auth_failed';
      throw err;
    }

    const parsedExpiresAtMs = body.expires_at ? Date.parse(body.expires_at) : NaN;
    const expiresAtMs = Number.isFinite(parsedExpiresAtMs)
      ? parsedExpiresAtMs
      : now + toNumber(body.ttl_seconds, 86400) * 1000;
    this.tokens.set(agent.name, { token: body.token, expiresAtMs });
    return body.token;
  }

  async _pollAgent(agent) {
    try {
      let token = await this._ensureToken(agent);
      let resp = await this._fetchState(agent, token);
      if (resp.status === 401) {
        this.tokens.delete(agent.name);
        token = await this._ensureToken(agent, { force: true });
        resp = await this._fetchState(agent, token);
      }
      if (resp.status === 401 || resp.status === 403) {
        this._setFailure(agent, 'auth_failed');
        return;
      }
      if (!resp.ok) {
        this._setFailure(agent, 'unreachable');
        return;
      }
      const state = await resp.json();
      this._setSuccess(agent, state);
    } catch (err) {
      this._setFailure(agent, err.reason || 'unreachable');
    }
  }

  async _pollAgentAndNotify(agent) {
    await this._pollAgent(agent);
    this.onPoll?.(this.getFleet());
  }

  _fetchState(agent, token) {
    return fetchWithTimeout(this.fetch, joinUrl(agent.base_url, '/api/state'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    }, this.timeoutMs);
  }

  _fetchStream(agent, token, signal) {
    return this.fetch(joinUrl(agent.base_url, '/api/stream'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal
    });
  }

  _setSuccess(agent, state) {
    this.records.set(agent.name, stateToFleetRecord(agent, state, {
      self: false,
      base_url: agent.base_url,
      nowMs: this.now()
    }));
  }

  _connectSse(agent) {
    if (!this.running) return;
    const stream = this._streamState(agent);
    if (stream.connecting) return;
    stream.connecting = true;
    stream.controller?.abort();
    stream.controller = new AbortController();
    this._runSse(agent, stream, stream.controller.signal)
      .catch((err) => {
        if (!this.running || err?.name === 'AbortError') return;
        this._startFallbackPolling(agent);
        this._scheduleReconnect(agent);
      })
      .finally(() => {
        stream.connecting = false;
      });
  }

  async _runSse(agent, stream, signal) {
    let token = await this._ensureToken(agent);
    let resp = await this._fetchStream(agent, token, signal);
    if (resp.status === 401) {
      this.tokens.delete(agent.name);
      token = await this._ensureToken(agent, { force: true });
      resp = await this._fetchStream(agent, token, signal);
    }
    if (resp.status === 401 || resp.status === 403) {
      this._setFailure(agent, 'auth_failed');
      throw new Error('auth_failed');
    }
    if (!resp.ok || !resp.body) {
      this._setFailure(agent, resp.status === 404 ? 'version_unsupported' : 'unreachable');
      throw new Error('sse_unreachable');
    }

    this._stopFallbackPolling(agent);
    stream.backoffMs = this.reconnectBaseMs;
    stream.seenFleetState = false;
    await this._pollAgentAndNotify(agent);
    if (stream.compatibilityTimer) this.clearTimeout(stream.compatibilityTimer);
    stream.compatibilityTimer = this.setTimeout(() => {
      const current = this.streams.get(agent.name);
      if (this.running && current && !current.seenFleetState) this._startFallbackPolling(agent);
    }, this.pollIntervalMs);
    stream.compatibilityTimer.unref?.();
    try {
      await this._readSseBody(agent, stream, resp.body, signal);
    } finally {
      this._clearIdleWatchdog(stream);
    }
    if (this.running && !signal.aborted) throw new Error('sse_closed');
  }

  async _readSseBody(agent, stream, body, signal) {
    const decoder = new TextDecoder();
    const parser = new SseEventParser((event) => this._handleSseEvent(agent, event));
    this._armIdleWatchdog(agent, stream);
    if (body.getReader) {
      const reader = body.getReader();
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          this._armIdleWatchdog(agent, stream);
          parser.push(decoder.decode(value, { stream: true }));
        }
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
      }
    } else {
      for await (const chunk of body) {
        if (signal.aborted) break;
        this._armIdleWatchdog(agent, stream);
        parser.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
      }
    }
    parser.push(decoder.decode());
    parser.flush();
  }

  _handleSseEvent(agent, event) {
    if (event.event === 'auth_expired') {
      this.tokens.delete(agent.name);
      const err = new Error('auth_expired');
      err.reason = 'auth_expired';
      throw err;
    }
    if (event.event !== 'fleet_state') return;
    const stream = this.streams.get(agent.name);
    if (stream) {
      stream.seenFleetState = true;
      if (stream.compatibilityTimer) {
        this.clearTimeout(stream.compatibilityTimer);
        stream.compatibilityTimer = null;
      }
    }
    let state;
    try {
      state = JSON.parse(event.data || '{}');
    } catch {
      return;
    }
    this._setSuccess(agent, state);
    this._stopFallbackPolling(agent);
    this.onPoll?.(this.getFleet());
  }

  _startFallbackPolling(agent) {
    if (!this.running) return;
    const stream = this._streamState(agent);
    if (stream.pollTimer) return;
    const run = () => {
      if (!this.running || !this.streams.has(agent.name)) return;
      this._pollAgentAndNotify(agent).finally(() => {
        const current = this.streams.get(agent.name);
        if (!this.running || !current || !current.pollTimer) return;
        current.pollTimer = this.setTimeout(run, this.pollIntervalMs);
        current.pollTimer.unref?.();
      });
    };
    stream.pollTimer = this.setTimeout(run, 0);
    stream.pollTimer.unref?.();
  }

  _stopFallbackPolling(agent) {
    const stream = this.streams.get(agent.name);
    if (!stream?.pollTimer) return;
    this.clearTimeout(stream.pollTimer);
    stream.pollTimer = null;
  }

  _scheduleReconnect(agent) {
    if (!this.running) return;
    const stream = this._streamState(agent);
    if (stream.reconnectTimer) this.clearTimeout(stream.reconnectTimer);
    const delay = stream.backoffMs;
    stream.backoffMs = Math.min(stream.backoffMs * 2, this.reconnectMaxMs);
    stream.reconnectTimer = this.setTimeout(() => {
      stream.reconnectTimer = null;
      this._connectSse(agent);
    }, delay);
    stream.reconnectTimer.unref?.();
  }

  _setFailure(agent, reason) {
    const existing = this.records.get(agent.name) || {};
    const color = agentColor(agent.name);
    this.records.set(agent.name, sanitizeRecord({
      name: agent.name,
      base_url: agent.base_url,
      color: color.color,
      hue: color.hue,
      state: reason === 'version_unsupported' ? 'UNKNOWN' : 'OFFLINE',
      activity: existing.activity || null,
      context_pct: existing.context_pct ?? null,
      cost: existing.cost ?? null,
      session_cost: existing.session_cost ?? null,
      daily_cost: existing.daily_cost ?? null,
      weekly_cost: existing.weekly_cost ?? null,
      model: existing.model ?? null,
      effort: existing.effort ?? null,
      new_session_threshold: existing.new_session_threshold ?? null,
      cpu_pct: existing.cpu_pct ?? null,
      mem_pct: existing.mem_pct ?? null,
      disk_pct: existing.disk_pct ?? null,
      has_upgrade: existing.has_upgrade === true,
      has_subagent: existing.has_subagent === true,
      last_seen: existing.last_seen || null,
      pulse_rate: 0,
      health_reason: reason,
      updated_at: nowIso(this.now())
    }));
  }

  // Connection-level watchdog (#180). The server writes a keepalive comment
  // every 15s even when no events fire, so prolonged byte silence means the
  // connection is half-open (e.g. remote power loss, NAT table drop). Abort
  // it and let fallback polling + reconnect determine the real state. This
  // watches the *connection*, never the event rate — a quiet stream on a
  // healthy connection keeps the last pushed state indefinitely.
  _armIdleWatchdog(agent, stream) {
    if (stream.idleTimer) this.clearTimeout(stream.idleTimer);
    stream.idleTimer = this.setTimeout(() => {
      stream.idleTimer = null;
      if (!this.running) return;
      stream.controller?.abort();
      this._startFallbackPolling(agent);
      this._scheduleReconnect(agent);
    }, this.sseIdleTimeoutMs);
    stream.idleTimer.unref?.();
  }

  _clearIdleWatchdog(stream) {
    if (!stream.idleTimer) return;
    this.clearTimeout(stream.idleTimer);
    stream.idleTimer = null;
  }
}
