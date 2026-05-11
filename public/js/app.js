import { setAssetRoot, getLocale, initI18n, t, renderI18n } from './i18n.js';

const BASE_PATH = document.documentElement.dataset.basePath || '';
const ASSET_ROOT = `${BASE_PATH}/_assets`;
setAssetRoot(ASSET_ROOT);

const METRICS = ['context_pct', 'rate_limit', 'rate_limit_7d', 'session_cost', 'cache_hit_rate'];
const THEMES = ['light'];
const THEME_KEY = 'zylos-dashboard-theme';

const state = {
  dashboardState: null,
  metrics: new Map(),
  health: null,
  system: null,
  summary: null,
  communication: null,
  timeline: null,
  sourceUpdatedAt: null,
  metricsUpdatedAt: null,
  healthUpdatedAt: null,
  summaryUpdatedAt: null,
  commUpdatedAt: null,
  timelineUpdatedAt: null,
  timer: null,
  pollTimer: null,
  eventSource: null,
  charts: {}
};

const $ = (sel) => document.querySelector(sel);

function api(path) { return `${BASE_PATH}${path}`; }

// ─── Theme ───
function initTheme(theme) {
  const stored = localStorage.getItem(THEME_KEY);
  const resolved = THEMES.includes(theme) ? theme : (THEMES.includes(stored) ? stored : 'light');
  document.documentElement.dataset.theme = resolved;
  localStorage.setItem(THEME_KEY, resolved);
}

// ─── Formatting ───
function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return `${Math.round(n <= 1 ? n * 100 : n)}%`;
}

function barPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n <= 1 ? n * 100 : n));
}

function usd(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return new Intl.NumberFormat(getLocale() === 'zh' ? 'zh-CN' : 'en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: n < 1 ? 4 : 2
  }).format(n);
}

function bytes(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
  return `${Math.round(n / 1048576)} MB`;
}

function dur(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function ageSec(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
}

function fmtAge(ts) {
  const a = ageSec(ts);
  if (a === null) return '--';
  if (a < 2) return t('time.just_now');
  return t('time.seconds', { count: a });
}

function esc(v) {
  return String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

// ─── State helpers ───
function normState(v) { return String(v || 'UNKNOWN').toUpperCase(); }

function stateClass(v) { return `state-${normState(v).toLowerCase().replaceAll('_', '-')}`; }

function latestTool(tools = []) {
  return [...tools].sort((a, b) => new Date(b.started_at) - new Date(a.started_at))[0] || null;
}

function stateTitle(p) {
  const s = normState(p?.state);
  const tool = latestTool(p?.running_tools);
  const reason = p?.reason || t('value.unknown');
  if (s === 'BUSY') return t('state.busy', { tool: tool?.tool_name || 'tool' });
  if (s === 'IDLE') return t('state.idle');
  if (s === 'OFFLINE') return t('state.offline');
  if (s === 'WAITING_HUMAN') return t('state.waiting');
  if (s === 'POSSIBLY_STUCK') return t('state.possibly_stuck', { reason });
  if (s === 'STUCK') return t('state.stuck', { reason });
  return t('state.unknown', { reason });
}

function confLabel(v) {
  if (!v) return '--';
  const key = `confidence.${String(v).toLowerCase()}`;
  const r = t(key);
  return r === key ? String(v) : r;
}

function srcLabel(m) {
  if (!m) return t('confidence.unavailable');
  const conf = m.confidence || m.selected_source?.confidence;
  const src = m.selected_source?.source || m.selected_source || m.source || m.freshness?.source;
  const ct = conf ? confLabel(conf) : t('confidence.unavailable');
  return src ? `${ct} · ${src}` : ct;
}

function metVal(m) {
  if (!m) return null;
  if (m.value && typeof m.value === 'object') return m.value;
  return m.value ?? m.current ?? m.percent ?? null;
}

// ─── Render: State ───
function renderState() {
  const p = state.dashboardState;
  $('#state-dot').className = `state-dot ${stateClass(p?.state)}`;
  $('#state-title').textContent = p ? stateTitle(p) : t('state.unknown', { reason: t('value.unavailable') });
  $('#state-reason').textContent = p?.reason || p?.evidence?.join(', ') || t('value.unavailable');
  $('#state-confidence').textContent = confLabel(p?.confidence);
  $('#state-action').textContent = p?.suggested_action || t('value.none');
  $('#state-updated').textContent = fmtAge(p?.updated_at || state.sourceUpdatedAt);

  const tools = p?.running_tools || [];
  $('#tool-count').textContent = String(tools.length);
  $('#tool-details').open = tools.length > 1;
  $('#tool-list').replaceChildren(...tools.map((tool) => {
    const el = document.createElement('div');
    el.className = 'tool-item';
    const elapsed = tool.duration_s ?? ageSec(tool.started_at) ?? 0;
    el.innerHTML = `<span class="mono">${esc(tool.tool_name || 'tool')}</span><strong>${dur(elapsed)}</strong>`;
    return el;
  }));
}

// ─── Render: Metrics ───
function renderMetrics() {
  const ctx = state.metrics.get('context_pct');
  const rate = state.metrics.get('rate_limit');
  const cost = state.metrics.get('session_cost') || state.metrics.get('daily_cost');
  const cache = state.metrics.get('cache_hit_rate');

  const cv = metVal(ctx);
  const rv = metVal(rate);
  const ro = rv && typeof rv === 'object';
  const r5 = ro ? (rv['5h'] ?? rv.five_hour ?? rv.short ?? rv.value) : rv;
  const rate7d = state.metrics.get('rate_limit_7d');
  const r7 = metVal(rate7d) ?? (ro ? (rv['7d'] ?? rv.seven_day ?? rv.long) : null);

  $('#metric-context-value').textContent = pct(cv);
  $('#metric-context-bar').style.width = `${barPct(cv)}%`;
  $('#metric-context-source').textContent = srcLabel(ctx);
  $('#metric-rate-5h-value').textContent = pct(r5);
  $('#metric-rate-5h-bar').style.width = `${barPct(r5)}%`;
  $('#metric-rate-7d-value').textContent = r7 == null ? '--' : pct(r7);
  $('#metric-rate-7d-bar').style.width = `${barPct(r7)}%`;
  $('#metric-cost-value').textContent = usd(metVal(cost));
  $('#metric-cost-source').textContent = srcLabel(cost);
  $('#metric-cache-value').textContent = pct(metVal(cache));
  $('#metric-cache-source').textContent = srcLabel(cache);
  $('#metrics-updated').textContent = fmtAge(state.metricsUpdatedAt);
}

// ─── Render: Health ───
function renderHealth() {
  const sysResp = state.system || {};
  const sys = sysResp.system || sysResp;
  const health = state.health || {};
  const pm2 = sysResp.pm2 || sys.pm2 || sys.pm2_services || sys.services || [];
  const svcs = Array.isArray(pm2) ? pm2 : (pm2.services || []);
  const running = svcs.filter((s) => ['online', 'running', 'ok'].includes(String(s.status || s.pm2_env?.status).toLowerCase())).length;
  const total = svcs.length || Number(pm2.total) || 0;
  const cpu = sys.cpu?.percent ?? sys.cpu_pct ?? sys.cpu;
  const mem = sys.memory?.used_bytes ?? sys.mem_used_bytes ?? sys.memory?.used ?? sys.memory;
  const disk = sys.disk?.used_pct ?? sys.disk_used_pct ?? sys.disk_pct ?? sys.disk?.percent ?? sys.disk;

  $('#system-cpu').textContent = pct(cpu);
  $('#system-memory').textContent = typeof mem === 'number' && mem > 100 ? bytes(mem) : pct(mem);
  $('#system-disk').textContent = pct(disk);
  $('#system-pm2').textContent = total ? t('label.running', { count: running, total }) : '--';
  $('#health-updated').textContent = fmtAge(state.healthUpdatedAt);

  const sources = flatSources(state.dashboardState?.source || health.source || health.sources || {});
  $('#source-list').replaceChildren(...sources.slice(0, 8).map((s) => {
    const el = document.createElement('div');
    el.className = 'source-item';
    const status = s.status || (s.fresh ? 'healthy' : 'stale');
    const age = Number.isFinite(Number(s.age_s)) ? `${Math.round(s.age_s)}s` : '--';
    el.innerHTML = `<strong>${esc(s.name)}</strong><span>${esc(status)} · ${age}</span>`;
    return el;
  }));
}

function flatSources(tree) {
  const out = [];
  for (const [domain, sources] of Object.entries(tree || {})) {
    for (const [name, val] of Object.entries(sources || {})) {
      out.push({ name: `${domain}.${name}`, ...(val || {}) });
    }
  }
  return out;
}

// ─── Render: Timeline ───
function fmtTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function timelineDotType(eventType) {
  if (eventType === 'session_start' || eventType === 'session_end') return 'session';
  if (eventType === 'permission_request') return 'permission';
  if (eventType === 'post_compact') return 'compact';
  return '';
}

function fmtDuration(ms) {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderTimeline() {
  const events = state.timeline || [];
  const container = $('#timeline-list');
  if (!events.length) {
    container.innerHTML = `<p class="empty-state">${t('timeline.empty')}</p>`;
    return;
  }
  container.replaceChildren(...events.slice(0, 50).map((e) => {
    const el = document.createElement('div');
    el.className = 'timeline-item';
    const durStr = fmtDuration(e.duration_ms);
    el.innerHTML =
      `<span class="timeline-time">${fmtTime(e.timestamp)}</span>` +
      `<span class="timeline-dot" data-type="${timelineDotType(e.event_type)}"></span>` +
      `<span class="timeline-summary">${esc(e.summary || e.event_type)}</span>` +
      `<span class="timeline-duration">${esc(durStr)}</span>`;
    return el;
  }));
  $('#timeline-updated').textContent = fmtAge(state.timelineUpdatedAt);
}

// ─── Render: Summary ───
function renderSummary() {
  const s = state.summary;
  $('#summary-tool-calls').textContent = s ? String(s.tool_calls) : '--';
  $('#summary-active-time').textContent = s ? formatActiveTime(s.active_time_ms) : '--';
  $('#summary-messages').textContent = s ? String(s.messages_processed) : '--';
  $('#summary-top-tool').textContent = s?.top_tool || '--';
  $('#summary-updated').textContent = fmtAge(state.summaryUpdatedAt);
}

function formatActiveTime(ms) {
  if (!ms) return '0m';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

// ─── Render: Communication ───
function renderComm() {
  const c = state.communication;
  const container = $('#comm-channels');
  if (!c || !Object.keys(c.channels || {}).length) {
    container.innerHTML = `<p class="empty-state">${t('comm.empty')}</p>`;
    $('#comm-pending').innerHTML = '';
    return;
  }

  const lastOb = c.last_outbound || {};
  container.replaceChildren(...Object.entries(c.channels).map(([ch, counts]) => {
    const el = document.createElement('div');
    el.className = 'comm-row';
    const lastTs = lastOb[ch];
    const ageStr = lastTs ? fmtAge(lastTs) : '--';
    el.innerHTML =
      `<span class="comm-channel">${esc(ch)}</span>` +
      `<span class="comm-counts">${counts.in} ${t('comm.in')} / ${counts.out} ${t('comm.out')}</span>` +
      `<span class="comm-age">${ageStr}</span>`;
    return el;
  }));

  const pendingEl = $('#comm-pending');
  if (c.pending_depth > 0) {
    const warn = c.pending_oldest_age_s > 300 ? ' warn' : '';
    pendingEl.innerHTML =
      `<span class="${warn}">${t('comm.pending')}: ${c.pending_depth}</span>` +
      (c.pending_oldest_age_s != null ? ` · ${t('comm.oldest')}: ${dur(c.pending_oldest_age_s)}` : '');
  } else {
    pendingEl.innerHTML = `${t('comm.pending')}: 0`;
  }

  $('#comm-updated').textContent = fmtAge(state.commUpdatedAt);
}

function renderConnection(mode) {
  const pill = $('#connection-status');
  pill.dataset.state = mode;
  pill.textContent = t(`status.${mode}`);
}

function renderAll() {
  renderI18n();
  renderState();
  renderMetrics();
  renderHealth();
  renderTimeline();
  renderSummary();
  renderComm();
}

// ─── Data fetching ───
async function fetchJson(path) {
  const r = await fetch(api(path), { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

async function refreshState() {
  state.dashboardState = await fetchJson('/api/state');
  state.sourceUpdatedAt = state.dashboardState.updated_at || new Date().toISOString();
  renderState();
  renderHealth();
}

async function refreshMetrics() {
  const results = await Promise.allSettled(METRICS.map(async (n) => [n, await fetchJson(`/api/metrics/${n}`)]));
  let changed = false;
  for (const r of results) {
    if (r.status === 'fulfilled') { state.metrics.set(r.value[0], r.value[1]); changed = true; }
  }
  if (changed) {
    state.metricsUpdatedAt = new Date().toISOString();
    renderMetrics();
  }
}

async function refreshHealth() {
  const [h, s] = await Promise.allSettled([fetchJson('/api/health'), fetchJson('/api/system')]);
  if (h.status === 'fulfilled') state.health = h.value;
  if (s.status === 'fulfilled') state.system = s.value;
  state.healthUpdatedAt = new Date().toISOString();
  renderHealth();
}

async function refreshTimeline() {
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const data = await fetchJson(`/api/timeline?since=${since}&limit=50`);
  state.timeline = (data.events || []).reverse();
  state.timelineUpdatedAt = new Date().toISOString();
  renderTimeline();
}

async function refreshSummary() {
  state.summary = await fetchJson('/api/summary');
  state.summaryUpdatedAt = new Date().toISOString();
  renderSummary();
}

async function refreshComm() {
  state.communication = await fetchJson('/api/communication');
  state.commUpdatedAt = new Date().toISOString();
  renderComm();
}

async function refreshAll() {
  const results = await Promise.allSettled([
    refreshState(), refreshMetrics(), refreshHealth(),
    refreshTimeline(), refreshSummary(), refreshComm()
  ]);
  const ok = results.some((r) => r.status === 'fulfilled');
  const sseOpen = state.eventSource?.readyState === EventSource.OPEN;
  renderConnection(ok ? (sseOpen ? 'live' : 'polling') : 'degraded');
}

// ─── SSE ───
function applySse(name, data) {
  if (name === 'state_change') {
    state.dashboardState = data;
    state.sourceUpdatedAt = data.updated_at || new Date().toISOString();
    renderState(); renderHealth();
  } else if (name === 'metric_update') {
    const mn = data.metric_name || data.name;
    if (mn) { state.metrics.set(mn, data); state.metricsUpdatedAt = new Date().toISOString(); renderMetrics(); }
  } else if (name === 'system_update') {
    state.system = data; state.healthUpdatedAt = new Date().toISOString(); renderHealth();
  } else if (name === 'health_update') {
    state.health = data; state.healthUpdatedAt = new Date().toISOString(); renderHealth();
  }
}

function connectSse() {
  if (!window.EventSource) return;
  state.eventSource = new EventSource(api('/api/stream'));
  state.eventSource.onopen = () => renderConnection('live');
  state.eventSource.onerror = () => renderConnection('degraded');
  for (const ev of ['state_change', 'metric_update', 'system_update', 'health_update']) {
    state.eventSource.addEventListener(ev, (e) => {
      try { applySse(ev, JSON.parse(e.data)); renderConnection('live'); }
      catch { renderConnection('degraded'); }
    });
  }
}

// ─── Tabs ───
function initTabs() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
      document.querySelectorAll('.tab-panel').forEach((p) => {
        const active = p.id === `tab-${btn.dataset.tab}`;
        p.classList.toggle('active', active);
        p.hidden = !active;
      });
      if (btn.dataset.tab === 'trends') refreshCharts();
    });
  });
}

function initLocaleToggle() {
  $('#locale-toggle').addEventListener('click', async () => {
    await initI18n(getLocale() === 'zh' ? 'en' : 'zh');
    renderAll();
  });
}

// ─── Charts ───
const CHART_COLORS = {
  accent: '#0d9488',
  accentBg: 'rgba(13, 148, 136, 0.08)',
  purple: '#6366f1',
  purpleBg: 'rgba(99, 102, 241, 0.08)',
  green: '#059669',
  greenBg: 'rgba(5, 150, 105, 0.08)',
  orange: '#ea580c',
  orangeBg: 'rgba(234, 88, 12, 0.08)',
  grid: 'rgba(15, 118, 110, 0.06)',
  text: '#7a8794'
};

function chartOpts(yLabel, yMax, yCallback) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: '#101827', titleFont: { size: 11 }, bodyFont: { size: 11 }, padding: 8, cornerRadius: 6 }
    },
    scales: {
      x: {
        type: 'time',
        time: { tooltipFormat: 'HH:mm', displayFormats: { minute: 'HH:mm', hour: 'HH:mm', day: 'MMM d' } },
        grid: { display: false },
        ticks: { font: { size: 10 }, color: CHART_COLORS.text, maxTicksLimit: 8 }
      },
      y: {
        min: 0,
        max: yMax,
        grid: { color: CHART_COLORS.grid },
        ticks: { font: { size: 10 }, color: CHART_COLORS.text, callback: yCallback || undefined },
        border: { display: false }
      }
    },
    elements: { point: { radius: 0, hoverRadius: 3 }, line: { tension: 0.3, borderWidth: 2 } }
  };
}

function createChart(canvasId, label, color, bgColor, yMax, yCallback) {
  const ctx = document.getElementById(canvasId);
  if (!ctx || !window.Chart) return null;
  return new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{ label, data: [], borderColor: color, backgroundColor: bgColor, fill: true }]
    },
    options: chartOpts(label, yMax, yCallback)
  });
}

function initCharts() {
  if (!window.Chart) return;
  try {
    state.charts.context = createChart('chart-context', t('label.context'), CHART_COLORS.accent, CHART_COLORS.accentBg, 100, (v) => `${v}%`);
    state.charts.cost = createChart('chart-cost', t('label.cost'), CHART_COLORS.purple, CHART_COLORS.purpleBg, undefined, (v) => `$${v}`);
    state.charts.rate = createChart('chart-rate', t('trends.rate'), CHART_COLORS.orange, CHART_COLORS.orangeBg, 100, (v) => `${v}%`);
    state.charts.tools = createChart('chart-tools', t('trends.tools'), CHART_COLORS.green, CHART_COLORS.greenBg, undefined);
  } catch { /* chart init failed — overview still works */ }
}

function rangeToSince() {
  const range = $('#trend-range')?.value || '6h';
  const now = Date.now();
  const ms = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000 };
  return new Date(now - (ms[range] || ms['6h'])).toISOString();
}

async function refreshCharts() {
  if (!window.Chart) return;
  const since = rangeToSince();
  const until = new Date().toISOString();
  const qp = `?since=${since}&until=${until}`;

  const [contextData, costData, rateData, toolData] = await Promise.allSettled([
    fetchJson(`/api/metrics/history/context_pct${qp}`),
    fetchJson(`/api/metrics/history/session_cost${qp}`),
    fetchJson(`/api/metrics/history/rate_limit${qp}`),
    fetchJson(`/api/timeline${qp}&types=pre_tool_use&limit=500`)
  ]);

  if (state.charts.context && contextData.status === 'fulfilled') {
    const pts = (contextData.value.points || []).map((p) => ({ x: new Date(p.timestamp), y: p.value <= 1 ? p.value * 100 : p.value }));
    state.charts.context.data.datasets[0].data = pts;
    state.charts.context.update('none');
  }

  if (state.charts.cost && costData.status === 'fulfilled') {
    const pts = (costData.value.points || []).map((p) => ({ x: new Date(p.timestamp), y: p.value }));
    state.charts.cost.data.datasets[0].data = pts;
    state.charts.cost.options.scales.y.max = undefined;
    state.charts.cost.update('none');
  }

  if (state.charts.rate && rateData.status === 'fulfilled') {
    const pts = (rateData.value.points || []).map((p) => ({ x: new Date(p.timestamp), y: p.value <= 1 ? p.value * 100 : p.value }));
    state.charts.rate.data.datasets[0].data = pts;
    state.charts.rate.update('none');
  }

  if (state.charts.tools && toolData.status === 'fulfilled') {
    const events = toolData.value.events || [];
    const buckets = new Map();
    const bucketSize = getBucketSize();
    for (const e of events) {
      const ts = new Date(e.timestamp).getTime();
      const key = Math.floor(ts / bucketSize) * bucketSize;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    const pts = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => ({ x: new Date(k), y: v }));
    state.charts.tools.data.datasets[0].data = pts;
    state.charts.tools.options.scales.y.max = undefined;
    state.charts.tools.update('none');
  }
}

function getBucketSize() {
  const range = $('#trend-range')?.value || '6h';
  return { '1h': 60000, '6h': 300000, '24h': 900000, '7d': 3600000 }[range] || 300000;
}

// ─── Timers ───
function startTimers() {
  state.timer = setInterval(() => { renderState(); renderMetrics(); renderHealth(); }, 1000);
  state.pollTimer = setInterval(refreshAll, 30_000);
}

window.addEventListener('beforeunload', () => {
  clearInterval(state.timer);
  clearInterval(state.pollTimer);
  state.eventSource?.close();
});

// ─── Init ───
initTheme();
await initI18n();
initTabs();
initLocaleToggle();
renderAll();
initCharts();
connectSse();
await refreshAll();
startTimers();

$('#trend-range')?.addEventListener('change', refreshCharts);
