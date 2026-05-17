import { setAssetRoot, getLocale, initI18n, t, renderI18n } from './i18n.js';

const BASE_PATH = document.documentElement.dataset.basePath || '';
const ASSET_ROOT = `${BASE_PATH}/_assets`;
setAssetRoot(ASSET_ROOT);

const METRICS = ['context_pct', 'rate_limit', 'rate_limit_7d', 'session_cost'];
const THEMES = ['light'];
const THEME_KEY = 'zylos-dashboard-theme';
const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh' };

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
  return `${Math.round(n < 1 ? n * 100 : n)}%`;
}

function barPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n < 1 ? n * 100 : n));
}

function barColor(pctValue) {
  const p = barPct(pctValue);
  if (p < 50) return '';
  if (p <= 75) return 'bar-warning';
  return 'bar-danger';
}

function pctDecimal(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  const p = n <= 1 ? n * 100 : n;
  return `${p.toFixed(1)}%`;
}

function tok(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '--';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
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
  if (a < 60) return t('time.seconds', { count: a });
  if (a < 3600) return t('time.minutes', { m: Math.floor(a / 60), s: a % 60 });
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  return m > 0 ? t('time.hours', { h, m }) : t('time.hours_exact', { h });
}

function fmtResetTime(unixSeconds) {
  const ts = Number(unixSeconds);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const diff = ms - Date.now();
  if (diff <= 0) return 'now';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 24) { const d = Math.floor(h / 24); return `in ${d}d ${h % 24}h`; }
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
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
  const reason = p?.reason || t('value.unknown');
  if (s === 'BUSY') return t('state.busy_simple');
  if (s === 'IDLE') return t('state.idle');
  if (s === 'OFFLINE') return t('state.offline');
  if (s === 'WAITING_HUMAN') return t('state.waiting');
  if (s === 'POSSIBLY_STUCK') return t('state.possibly_stuck_simple');
  if (s === 'STUCK') return t('state.stuck_simple');
  return t('state.unknown_simple');
}


function confLabel(v) {
  if (!v) return '--';
  const key = `confidence.${String(v).toLowerCase()}`;
  const r = t(key);
  return r === key ? String(v) : r;
}

function srcLabel(m) {
  if (!m) return t('confidence.unavailable');
  const src = m.selected_source || m.source || '';
  const friendly = {
    statusline: 'current session',
    statusline_current_usage: 'current session',
    otel_cost_sum: 'OpenTelemetry',
    otel_token_usage: 'OpenTelemetry',
    otel_span: 'OpenTelemetry',
    rollout: 'rollout',
    token_price_estimated: 'estimated',
    derived_token_estimate: 'estimated',
    hook_postToolUse: 'tool hooks'
  };
  return friendly[src] || src || t('confidence.unavailable');
}

function metVal(m) {
  if (!m) return null;
  if (m.value && typeof m.value === 'object') return m.value;
  return m.value ?? m.current ?? m.percent ?? null;
}

// ─── Render: Info Bar ───
function renderInfoBar() {
  const bar = $('#info-bar');
  if (!bar) return;
  const ri = state.dashboardState?.runtime_info;
  if (!ri) { bar.textContent = ''; return; }

  const parts = [];
  if (ri.zylos_version) {
    let zv = `zylos v${ri.zylos_version}`;
    if (ri.zylos_update) zv += ` <span class="info-bar-update" title="v${esc(ri.zylos_update)} available — click ⚙️ to upgrade">↑${esc(ri.zylos_update)}</span>`;
    parts.push(zv);
  }
  if (ri.runtime) parts.push(esc(ri.runtime.charAt(0).toUpperCase() + ri.runtime.slice(1)));
  if (ri.model) {
    const short = ri.model.replace(' context', '');
    parts.push(esc(short));
  }
  if (ri.effort) parts.push(esc(EFFORT_LABELS[ri.effort] || ri.effort.charAt(0).toUpperCase() + ri.effort.slice(1)));
  if (ri.cc_version) {
    let cv = `CC v${esc(ri.cc_version)}`;
    if (ri.cc_restart) cv += ` <span class="info-bar-update" title="v${esc(ri.cc_restart)} installed — restart to apply">↑${esc(ri.cc_restart)}</span>`;
    else if (ri.cc_update) cv += ` <span class="info-bar-update" title="v${esc(ri.cc_update)} available — click ⚙️ to upgrade">↑${esc(ri.cc_update)}</span>`;
    parts.push(cv);
  }

  bar.innerHTML = `<span class="info-bar-text">${parts.join(' · ')}</span><button class="info-bar-gear" id="gear-btn" type="button" aria-label="Actions">⚙️</button>`;
}

// ─── Render: State ───
const FEED_MAX = 5;
const prevToolIds = new Set();

function renderState() {
  const p = state.dashboardState;
  $('#state-dot').className = `state-dot ${stateClass(p?.state)}`;
  $('#state-title').textContent = p ? stateTitle(p) : t('state.unknown_simple');
  $('#state-confidence').textContent = confLabel(p?.confidence);
  $('#state-updated').textContent = fmtAge(p?.updated_at || state.sourceUpdatedAt);

  const tools = p?.running_tools || [];

  renderToolFeed(tools, p);
  renderSubagents(p);
  renderAssistantMessage(p);
}

function renderToolFeed(tools, p) {
  const feed = $('#tool-feed');
  const currentIds = new Set(tools.map((t) => t.tool_use_id));
  const s = normState(p?.state);

  // Render prompt source as a transient feed item
  const promptId = '_prompt';
  const existingPrompt = feed.querySelector(`[data-tool-id="${promptId}"]`);
  const lp = p?.last_prompt;
  if (lp && lp.timestamp) {
    const promptAge = ageSec(lp.timestamp) ?? 0;
    const isNewPrompt = existingPrompt && existingPrompt.dataset.promptTs !== lp.timestamp;
    if (isNewPrompt) {
      existingPrompt.remove();
    }
    const current = isNewPrompt ? null : existingPrompt;
    if (promptAge < 30) {
      if (!current) {
        const el = document.createElement('div');
        el.className = 'tool-feed-item prompt-source';
        el.dataset.toolId = promptId;
        el.dataset.promptTs = lp.timestamp;
        el.dataset.addedAt = String(Date.now());
        el.innerHTML = `<span class="mono tool-detail">${esc(lp.summary)}</span><span class="tool-status">${dur(promptAge)}</span>`;
        feed.prepend(el);
      } else {
        current.querySelector('.tool-status').textContent = dur(promptAge);
      }
    } else if (current && !current.classList.contains('done')) {
      current.classList.add('done');
      setTimeout(() => {
        if (current.parentNode) {
          current.classList.add('removing');
          current.addEventListener('animationend', () => current.remove(), { once: true });
        }
      }, 5000);
    }
  } else if (existingPrompt) {
    existingPrompt.remove();
  }

  for (const id of prevToolIds) {
    if (!currentIds.has(id)) {
      const el = feed.querySelector(`[data-tool-id="${id}"]`);
      if (el && !el.classList.contains('done')) {
        const statusEl = el.querySelector('.tool-status');
        if (statusEl) statusEl.textContent = '✓';
        const age = Date.now() - (Number(el.dataset.addedAt) || 0);
        const greyDelay = Math.max(0, 2000 - age);
        setTimeout(() => {
          el.classList.add('done');
          setTimeout(() => {
            if (el.parentNode) {
              el.classList.add('removing');
              el.addEventListener('animationend', () => el.remove(), { once: true });
            }
          }, 10000);
        }, greyDelay);
      }
    }
  }

  for (const tool of tools) {
    let el = feed.querySelector(`[data-tool-id="${tool.tool_use_id}"]`);
    const elapsed = ageSec(tool.started_at) ?? tool.duration_s ?? 0;
    const detail = tool.tool_detail ? `: ${esc(tool.tool_detail)}` : '';
    const label = `${esc(tool.tool_name || 'tool')}${detail}`;

    if (!el) {
      el = document.createElement('div');
      el.className = 'tool-feed-item';
      el.dataset.toolId = tool.tool_use_id;
      el.dataset.addedAt = String(Date.now());
      el.innerHTML = `<span class="mono tool-detail">${label}</span><span class="tool-status">${dur(elapsed)}</span>`;
      feed.appendChild(el);
    } else if (!el.classList.contains('done')) {
      el.querySelector('.tool-status').textContent = dur(elapsed);
    }
  }

  const thinkingId = '_thinking';
  const existingThinking = feed.querySelector(`[data-tool-id="${thinkingId}"]`);
  const shouldThink = s === 'BUSY' && tools.length === 0;
  if (shouldThink) {
    if (!existingThinking) {
      const el = document.createElement('div');
      el.className = 'tool-feed-item thinking';
      el.dataset.toolId = thinkingId;
      el.dataset.startedAt = new Date().toISOString();
      el.innerHTML = `<span class="mono tool-detail">Thinking...</span><span class="tool-status">0s</span>`;
      feed.appendChild(el);
    } else {
      const thinkAge = ageSec(existingThinking.dataset.startedAt) ?? 0;
      existingThinking.querySelector('.tool-status').textContent = dur(thinkAge);
    }
  } else if (existingThinking) {
    existingThinking.remove();
  }

  trimFeed(feed);

  const fallback = $('#activity-fallback');
  const hasItems = feed.querySelector('.tool-feed-item') !== null;
  if (hasItems || s === 'IDLE') {
    fallback.hidden = true;
  } else {
    fallback.hidden = false;
    if (s === 'OFFLINE') fallback.textContent = t('activity.offline');
    else if (s === 'WAITING_HUMAN') fallback.textContent = t('activity.waiting');
    else fallback.textContent = p?.reason || t('value.unavailable');
  }

  prevToolIds.clear();
  for (const id of currentIds) prevToolIds.add(id);
}

function trimFeed(feed) {
  const items = feed.querySelectorAll('.tool-feed-item');
  if (items.length <= FEED_MAX) return;
  const doneItems = [...items].filter((el) => el.classList.contains('done'));
  let excess = items.length - FEED_MAX;
  for (const el of doneItems) {
    if (excess <= 0) break;
    el.classList.add('removing');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    excess--;
  }
}

// ─── Render: Assistant Message ───
function renderAssistantMessage(p) {
  const el = $('#assistant-message');
  const msg = p?.last_message;
  if (msg?.text) {
    el.textContent = msg.text;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// ─── Render: Subagents ───
const prevSubagentIds = new Set();

function renderSubagents(p) {
  const agents = p?.active_subagents || [];
  const section = $('#subagent-section');
  const list = $('#subagent-list');
  const badge = $('#subagent-count');

  const currentAgentIds = new Set(agents.map((a) => a.agent_id));

  const hasContent = agents.length > 0 ||
    list.querySelector('.subagent-group') !== null;
  section.classList.toggle('visible', hasContent);
  section.closest('.runtime-split')?.classList.toggle('has-subagents', hasContent);
  badge.textContent = String(agents.length);
  badge.hidden = agents.length === 0;

  for (const id of prevSubagentIds) {
    if (!currentAgentIds.has(id)) {
      const grp = list.querySelector(`[data-agent-id="${id}"]`);
      if (grp && !grp.classList.contains('done')) {
        const timeEl = grp.querySelector('.subagent-group-time');
        if (timeEl) timeEl.textContent = '✓';
        grp.classList.add('done');
        setTimeout(() => {
          if (grp.parentNode) {
            grp.classList.add('removing');
            grp.addEventListener('animationend', () => {
              grp.remove();
              if (!list.querySelector('.subagent-group')) {
                section.classList.remove('visible');
                section.closest('.runtime-split')?.classList.remove('has-subagents');
              }
            }, { once: true });
          }
        }, 10000);
      }
    }
  }

  for (const agent of agents) {
    let grp = list.querySelector(`[data-agent-id="${agent.agent_id}"]`);
    const label = agent.description || agent.agent_type || 'subagent';
    const shortId = agent.agent_id.slice(0, 7);
    const subtitle = agent.description ? agent.agent_type : null;

    if (!grp) {
      grp = document.createElement('div');
      grp.className = 'subagent-group';
      grp.dataset.agentId = agent.agent_id;
      const subtitleHtml = subtitle ? ` <span style="opacity:0.5">${esc(subtitle)}</span>` : ` <span style="opacity:0.5">${esc(shortId)}</span>`;
      grp.innerHTML =
        `<div class="subagent-group-head">` +
          `<span class="subagent-group-label">${esc(label)}${subtitleHtml}</span>` +
          `<span class="subagent-group-time">${dur(agent.duration_s || 0)}</span>` +
        `</div>` +
        `<div class="tool-feed"></div>`;
      list.appendChild(grp);
    } else if (!grp.classList.contains('done')) {
      grp.querySelector('.subagent-group-time').textContent = dur(agent.duration_s || 0);
    }

    if (!grp.classList.contains('done')) {
      const feed = grp.querySelector('.tool-feed');
      const tools = agent.running_tools || [];
      const currentToolIds = new Set(tools.map((t) => t.tool_use_id));
      const existingItems = feed.querySelectorAll('.tool-feed-item');
      for (const el of existingItems) {
        if (!currentToolIds.has(el.dataset.toolId) && !el.classList.contains('done')) {
          const statusEl = el.querySelector('.tool-status');
          if (statusEl) statusEl.textContent = '✓';
          el.classList.add('done');
          setTimeout(() => {
            if (el.parentNode) {
              el.classList.add('removing');
              el.addEventListener('animationend', () => el.remove(), { once: true });
            }
          }, 5000);
        }
      }
      for (const tool of tools) {
        let el = feed.querySelector(`[data-tool-id="${tool.tool_use_id}"]`);
        const elapsed = ageSec(tool.started_at) ?? tool.duration_s ?? 0;
        const detail = tool.tool_detail ? `: ${esc(tool.tool_detail)}` : '';
        const toolLabel = `${esc(tool.tool_name || 'tool')}${detail}`;
        if (!el) {
          el = document.createElement('div');
          el.className = 'tool-feed-item';
          el.dataset.toolId = tool.tool_use_id;
          el.innerHTML = `<span class="mono tool-detail">${toolLabel}</span><span class="tool-status">${dur(elapsed)}</span>`;
          feed.appendChild(el);
        } else if (!el.classList.contains('done')) {
          el.querySelector('.tool-status').textContent = dur(elapsed);
        }
      }
      trimFeed(feed);
    }
  }

  prevSubagentIds.clear();
  currentAgentIds.forEach((id) => prevSubagentIds.add(id));
}

// ─── Render: Metrics ───
function renderMetrics() {
  const ctx = state.metrics.get('context_pct');
  const rate = state.metrics.get('rate_limit');
  const cost = state.metrics.get('session_cost') || state.metrics.get('daily_cost');

  const cv = metVal(ctx);
  const rv = metVal(rate);
  const ro = rv && typeof rv === 'object';
  const r5 = ro ? (rv['5h'] ?? rv.five_hour ?? rv.short ?? rv.value) : rv;
  const rate7d = state.metrics.get('rate_limit_7d');
  const r7 = metVal(rate7d) ?? (ro ? (rv['7d'] ?? rv.seven_day ?? rv.long) : null);

  $('#metric-context-value').textContent = pct(cv);
  const ctxBar = $('#metric-context-bar');
  const threshold = state.newSessionThreshold || 70;
  const cvNum = Number(cv);
  const cvAbs = Number.isFinite(cvNum) ? (cvNum < 1 ? cvNum * 100 : cvNum) : 0;
  ctxBar.style.width = `${barPct(cv)}%`;
  ctxBar.className = `progress-fill ${barColor(cv)}`;
  const thresholdMarker = $('#metric-context-threshold');
  if (thresholdMarker) {
    thresholdMarker.hidden = false;
    thresholdMarker.style.left = `${threshold}%`;
    thresholdMarker.title = `New Session @ ${threshold}%`;
  }
  const thresholdLabel = $('#metric-context-threshold-label');
  if (thresholdLabel) {
    thresholdLabel.textContent = `${threshold}%`;
    thresholdLabel.style.left = `${threshold}%`;
  }
  $('#metric-context-source').textContent = srcLabel(ctx);

  $('#metric-rate-5h-value').textContent = pct(r5);
  const r5Bar = $('#metric-rate-5h-bar');
  r5Bar.style.width = `${barPct(r5)}%`;
  r5Bar.className = `progress-fill ${barColor(r5)}`;

  $('#metric-rate-7d-value').textContent = r7 == null ? '--' : pct(r7);
  const r7Bar = $('#metric-rate-7d-bar');
  r7Bar.style.width = `${barPct(r7)}%`;
  r7Bar.className = `progress-fill ${barColor(r7)}`;

  const r5Reset = rate?.dimensions?.resets_at ?? rate?.resets_at;
  const r7Reset = rate7d?.dimensions?.resets_at ?? rate7d?.resets_at;
  $('#metric-rate-5h-reset').textContent = r5Reset ? `resets ${fmtResetTime(r5Reset)}` : '';
  $('#metric-rate-7d-reset').textContent = r7Reset ? `resets ${fmtResetTime(r7Reset)}` : '';

  const agg = state.aggregated || {};
  const hasCostSession = agg.cost_session != null;
  $('#metric-cost-session').textContent = hasCostSession ? usd(agg.cost_session) : usd(metVal(cost));
  $('#metric-cost-today').textContent = agg.cost_today != null ? usd(agg.cost_today) : '--';
  $('#metric-cost-7d').textContent = agg['cost_7d'] != null ? usd(agg['cost_7d']) : '--';

  const costSessionLabel = $('#metric-cost-session-label');
  if (costSessionLabel) costSessionLabel.textContent = hasCostSession ? 'session' : 'lifetime';

  // Tokens — stacked bar + cache ring
  const ts = agg.tokens_session;
  const tt = agg.tokens_today;
  const t7 = agg['tokens_7d'];

  // Session input/output stacked bar
  $('#metric-tokens-input').textContent = ts ? tok(ts.input) : '--';
  $('#metric-tokens-output').textContent = ts ? tok(ts.output) : '--';
  setTokenBar('tokens-bar', ts);

  // Cache hit ring
  const CACHE_RING_C = 2 * Math.PI * 22;
  const cacheEl = $('#cache-ring');
  if (cacheEl) {
    const cr = ts?.cache_rate;
    const cv = cr != null ? (cr <= 1 ? cr * 100 : cr) : 0;
    cacheEl.style.strokeDasharray = CACHE_RING_C;
    cacheEl.style.strokeDashoffset = CACHE_RING_C * (1 - Math.min(100, cv) / 100);
  }
  $('#metric-tokens-cache').textContent = ts ? pctDecimal(ts.cache_rate) : '--';

  // Today / 7d rows
  const tokLine = (t) => t ? `↑${tok(t.input)} ↓${tok(t.output)}` : '--';
  $('#metric-tokens-today').textContent = tokLine(tt);
  $('#metric-tokens-7d').textContent = tokLine(t7);
  setTokenBar('tokens-bar-today', tt);
  setTokenBar('tokens-bar-7d', t7);

  $('#metrics-updated').textContent = fmtAge(state.metricsUpdatedAt);
}

function setTokenBar(id, tokData) {
  const el = $(`#${id}`);
  if (!el || !tokData) return;
  const inp = Number(tokData.input) || 0;
  const out = Number(tokData.output) || 0;
  const total = inp + out;
  if (total === 0) return;
  const inputEl = el.querySelector('.tokens-bar-input');
  const outputEl = el.querySelector('.tokens-bar-output');
  if (inputEl) inputEl.style.width = `${(inp / total) * 100}%`;
  if (outputEl) outputEl.style.width = `${(out / total) * 100}%`;
}

// ─── Render: Health ───
const RING_CIRCUMFERENCE = 2 * Math.PI * 34; // r=34 → ~213.63

function ringLevel(pctVal) {
  if (pctVal >= 90) return 'level-danger';
  if (pctVal >= 70) return 'level-warn';
  return 'level-ok';
}

function ringLevelInverse(pctVal) {
  if (pctVal <= 50) return 'level-danger';
  if (pctVal <= 80) return 'level-warn';
  return 'level-ok';
}

function setRing(id, pctVal, levelFn) {
  const el = $(`#${id}`);
  if (!el) return;
  const v = Math.max(0, Math.min(100, pctVal));
  const offset = RING_CIRCUMFERENCE * (1 - v / 100);
  el.style.strokeDashoffset = offset;
  el.className.baseVal = `ring-fill ${(levelFn || ringLevel)(v)}`;
}

function renderHealth() {
  const sysResp = state.system || {};
  const sys = sysResp.system || sysResp;
  const pm2 = sysResp.pm2 || sys.pm2 || sys.pm2_services || sys.services || [];
  const svcs = Array.isArray(pm2) ? pm2 : (pm2.services || []);
  const svcStatus = (s) => String(s.status || s.pm2_env?.status || '').toLowerCase();
  const running = svcs.filter((s) => ['online', 'running', 'ok'].includes(svcStatus(s))).length;
  const total = svcs.length || Number(pm2.total) || 0;
  const downSvcs = svcs.filter((s) => !['online', 'running', 'ok'].includes(svcStatus(s)));

  const cpuVal = sys.cpu?.percent ?? sys.cpu_pct ?? sys.cpu;
  const memUsed = sys.memory?.used_bytes ?? sys.mem_used_bytes ?? sys.memory?.used ?? sys.memory;
  const memTotal = sys.memory?.total_bytes ?? sys.mem_total_bytes ?? sys.memory?.total;
  const diskVal = sys.disk?.used_pct ?? sys.disk_used_pct ?? sys.disk_pct ?? sys.disk?.percent ?? sys.disk;

  // PM2 — ring shows fraction (inverse color: green=high, red=low)
  const pm2Pct = total ? (running / total) * 100 : 0;
  $('#system-pm2').textContent = total ? `${running}/${total}` : '--';
  setRing('pm2-ring', pm2Pct, ringLevelInverse);
  const downList = $('#pm2-down-list');
  if (downList) {
    if (downSvcs.length > 0) {
      downList.textContent = '↓ ' + downSvcs.map((s) => s.name).join(', ');
      downList.className = 'gauge-detail alert';
    } else {
      downList.textContent = '';
      downList.className = 'gauge-detail';
    }
  }

  // CPU
  const cpuPct = Number(cpuVal);
  $('#system-cpu').textContent = pct(cpuVal);
  if (Number.isFinite(cpuPct)) setRing('cpu-ring', cpuPct < 1 ? cpuPct * 100 : cpuPct);

  // Memory — ring shows %, detail shows used/total
  const memDetail = $('#mem-detail');
  if (typeof memUsed === 'number' && memUsed > 100 && typeof memTotal === 'number' && memTotal > 0) {
    const memPctVal = (memUsed / memTotal) * 100;
    $('#system-memory').textContent = `${Math.round(memPctVal)}%`;
    setRing('mem-ring', memPctVal);
    if (memDetail) memDetail.textContent = `${bytes(memUsed)} / ${bytes(memTotal)}`;
  } else {
    $('#system-memory').textContent = typeof memUsed === 'number' && memUsed > 100 ? bytes(memUsed) : pct(memUsed);
    setRing('mem-ring', 0);
    if (memDetail) memDetail.textContent = '';
  }

  // Disk
  const diskPct = Number(diskVal);
  $('#system-disk').textContent = pct(diskVal);
  if (Number.isFinite(diskPct)) setRing('disk-ring', diskPct < 1 ? diskPct * 100 : diskPct);

  // Scheduler — timeline of upcoming tasks
  const sched = sysResp.scheduler;
  const schedCount = $('#scheduler-count');
  const schedTimeline = $('#scheduler-timeline');
  if (schedCount) {
    schedCount.textContent = sched?.pending ? `${sched.pending} pending` : '';
  }
  if (schedTimeline) {
    const tasks = sched?.upcoming || [];
    if (tasks.length === 0) {
      schedTimeline.innerHTML = '<span class="gauge-detail">No pending tasks</span>';
    } else {
      const now = Date.now();
      schedTimeline.innerHTML = tasks.map((task, i) => {
        const runAt = new Date(task.run_at);
        const isOverdue = runAt.getTime() < now;
        const time = runAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const cls = isOverdue ? ' overdue' : '';
        const line = i < tasks.length - 1 ? '<div class="sched-line"></div>' : '';
        return `<div class="sched-item${cls}"><div class="sched-dot"></div><div class="sched-info"><div class="sched-time">${esc(time)}</div><div class="sched-name">${esc(task.name)}</div></div></div>${line}`;
      }).join('');
    }
  }

  $('#health-updated').textContent = fmtAge(state.healthUpdatedAt);
}

// ─── Render: Timeline ───
function fmtTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function timelineDotType(eventType) {
  if (eventType === 'session_start' || eventType === 'session_end') return 'session';
  if (eventType === 'stop' || eventType === 'assistant_message') return 'assistant';
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


// ─── Render: Communication (inside Runtime) ───
const COMM_COLORS = ['#0d9488', '#6366f1', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899'];

function ageClass(ts) {
  const a = ageSec(ts);
  if (a === null) return 'age-normal';
  if (a < 60) return 'age-fresh';
  if (a < 3600) return 'age-normal';
  if (a < 86400) return 'age-stale';
  return 'age-old';
}

function renderComm() {
  const c = state.communication;
  const container = $('#comm-channels');
  if (!c || !Object.keys(c.channels || {}).length) {
    container.innerHTML = `<p class="empty-state">${t('comm.empty')}</p>`;
    $('#comm-pending').innerHTML = '';
    return;
  }

  const lastOb = c.last_outbound || {};
  const entries = Object.entries(c.channels).sort(([, a], [, b]) => (b.in + b.out) - (a.in + a.out));
  const maxTotal = Math.max(...entries.map(([, v]) => v.in + v.out), 1);

  container.replaceChildren(...entries.map(([ch, counts], i) => {
    const el = document.createElement('div');
    el.className = 'comm-row';
    const lastTs = lastOb[ch];
    const ageStr = lastTs ? fmtAge(lastTs) : '--';
    const total = counts.in + counts.out;
    const inPct = total ? (counts.in / total) * 100 : 50;
    const outPct = 100 - inPct;
    const color = COMM_COLORS[i % COMM_COLORS.length];
    el.innerHTML =
      `<span class="comm-dot" style="background:${color}"></span>` +
      `<span class="comm-channel">${esc(ch)}</span>` +
      `<span class="comm-bar-wrap">${counts.in}/${counts.out} <span class="comm-bar"><span class="comm-bar-in" style="width:${inPct}%"></span><span class="comm-bar-out" style="width:${outPct}%"></span></span></span>` +
      `<span class="comm-age ${ageClass(lastTs)}">${ageStr}</span>`;
    return el;
  }));

  const pendingEl = $('#comm-pending');
  const avgStr = c.avg_response_s != null ? `${t('comm.avg_response')}: ${dur(c.avg_response_s)}` : '';
  const pendingStr = c.pending_depth > 0
    ? `<span class="${c.pending_oldest_age_s > 300 ? 'warn' : ''}">${t('comm.pending')}: ${c.pending_depth}</span>` +
      (c.pending_oldest_age_s != null ? ` · ${t('comm.oldest')}: ${dur(c.pending_oldest_age_s)}` : '')
    : `${t('comm.pending')}: 0`;
  pendingEl.innerHTML = [avgStr, pendingStr].filter(Boolean).join(' · ');

  $('#comm-updated').textContent = fmtAge(state.commUpdatedAt);
}

function renderConnection(mode) {
  const pill = $('#connection-status');
  pill.dataset.state = mode;
  pill.textContent = t(`status.${mode}`);
}

function renderAll() {
  renderI18n();
  renderInfoBar();
  renderState();
  renderMetrics();
  renderHealth();
  renderTimeline();
  renderComm();
}

// ─── Data fetching ───
async function fetchJson(path) {
  const r = await fetch(api(path), { cache: 'no-store' });
  if (r.status === 401) {
    window.location.href = api('/login');
    throw new Error('unauthorized');
  }
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

async function refreshState() {
  state.dashboardState = await fetchJson('/api/state');
  state.sourceUpdatedAt = state.dashboardState.updated_at || new Date().toISOString();
  if (state.dashboardState.new_session_threshold) {
    state.newSessionThreshold = state.dashboardState.new_session_threshold;
  }
  renderInfoBar();
  renderState();
  renderHealth();
}

async function refreshMetrics() {
  const results = await Promise.allSettled(METRICS.map(async (n) => [n, await fetchJson(`/api/metrics/${n}`)]));
  let changed = false;
  for (const r of results) {
    if (r.status === 'fulfilled') { state.metrics.set(r.value[0], r.value[1]); changed = true; }
  }
  try {
    const aggKeys = [
      ['cost', 'session'], ['cost', 'today'], ['cost', '7d'],
      ['tokens', 'session'], ['tokens', 'today'], ['tokens', '7d']
    ];
    const aggResults = await Promise.allSettled(aggKeys.map(([m, p]) => fetchJson(`/api/metrics/aggregate?metric=${m}&period=${p}`)));
    state.aggregated = {};
    aggKeys.forEach(([m, p], i) => {
      const r = aggResults[i];
      state.aggregated[`${m}_${p}`] = r.status === 'fulfilled' ? (r.value?.value ?? null) : null;
    });
    changed = true;
  } catch { /* aggregation endpoints not available yet */ }
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
  const data = await fetchJson(`/api/timeline?since=${since}&limit=200&order=desc`);
  state.timeline = (data.events || []).filter((e) => e.event_type !== 'pre_tool_use' && e.event_type !== 'stop');
  state.timelineUpdatedAt = new Date().toISOString();
  renderTimeline();
}

async function refreshSummary() {
  state.summary = await fetchJson('/api/summary');
  state.summaryUpdatedAt = new Date().toISOString();
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
    const prevRi = state.dashboardState?.runtime_info;
    state.dashboardState = data;
    if (!data.runtime_info && prevRi) state.dashboardState.runtime_info = prevRi;
    if (data.new_session_threshold) state.newSessionThreshold = data.new_session_threshold;
    state.sourceUpdatedAt = data.updated_at || new Date().toISOString();
    renderInfoBar(); renderState(); renderHealth(); updateRestartDot();
    refreshTimeline();
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
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  clearTimeout(state.sseReconnectTimer);

  state.eventSource = new EventSource(api('/api/stream'));

  state.eventSource.onopen = () => {
    state.sseRetries = 0;
    renderConnection('live');
  };

  state.eventSource.onerror = () => {
    state.eventSource.close();
    state.eventSource = null;
    renderConnection('reconnecting');
    scheduleSseReconnect();
  };

  for (const ev of ['state_change', 'metric_update', 'system_update', 'health_update']) {
    state.eventSource.addEventListener(ev, (e) => {
      try { applySse(ev, JSON.parse(e.data)); renderConnection('live'); }
      catch { renderConnection('degraded'); }
    });
  }
}

function scheduleSseReconnect() {
  const delay = Math.min(1000 * Math.pow(2, state.sseRetries || 0), 30000);
  state.sseRetries = (state.sseRetries || 0) + 1;
  state.sseReconnectTimer = setTimeout(async () => {
    try {
      const r = await fetch(api('/api/state'), { cache: 'no-store' });
      if (r.status === 401) {
        window.location.href = api('/login');
        return;
      }
      if (!r.ok) throw new Error(r.status);
    } catch {
      renderConnection('reconnecting');
      scheduleSseReconnect();
      return;
    }
    connectSse();
  }, delay);
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

function initLogout() {
  $('#logout-btn').addEventListener('click', async () => {
    try {
      await fetch(api('/logout'), { method: 'POST' });
    } catch { /* ignore */ }
    window.location.href = api('/login');
  });
}

function initTips() {
  const tipPairs = [
    ['#confidence-tip', '#confidence-popover'],
    ['#cost-tip', '#cost-popover'],
    ['#cost-trend-tip', '#cost-trend-popover'],
    ['#projects-tip', '#projects-popover'],
    ['#context-tip', '#context-popover']
  ];
  const allPops = [];

  for (const [btnSel, popSel] of tipPairs) {
    const btn = $(btnSel);
    const srcPop = $(popSel);
    if (!btn || !srcPop) continue;

    const pop = srcPop.cloneNode(true);
    pop.removeAttribute('id');
    pop.hidden = true;
    document.body.appendChild(pop);
    srcPop.remove();
    allPops.push(pop);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasHidden = pop.hidden;
      allPops.forEach((p) => { p.hidden = true; });
      if (wasHidden) {
        const rect = btn.getBoundingClientRect();
        pop.style.top = `${rect.bottom + 6}px`;
        const left = Math.max(8, rect.left - 120);
        const maxLeft = window.innerWidth - 280 - 8;
        pop.style.left = `${Math.min(left, Math.max(8, maxLeft))}px`;
        pop.hidden = false;
      }
    });
  }

  document.addEventListener('click', () => { allPops.forEach((p) => { p.hidden = true; }); });
}

// ─── Charts ───
const CHART_COLORS = {
  accent: '#0d9488',
  accentBg: 'rgba(13, 148, 136, 0.35)',
  purple: '#6366f1',
  purpleBg: 'rgba(99, 102, 241, 0.35)',
  green: '#059669',
  greenBg: 'rgba(5, 150, 105, 0.35)',
  orange: '#ea580c',
  orangeBg: 'rgba(234, 88, 12, 0.35)',
  blue: '#3b82f6',
  blueBg: 'rgba(59, 130, 246, 0.35)',
  pink: '#ec4899',
  pinkBg: 'rgba(236, 72, 153, 0.35)',
  grid: 'rgba(15, 118, 110, 0.06)',
  text: '#7a8794'
};

function barChartOpts(yCallback, stacked) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: true, position: 'top', labels: { boxWidth: 10, font: { size: 11 }, padding: 8 } },
      tooltip: { backgroundColor: '#101827', titleFont: { size: 11 }, bodyFont: { size: 11 }, padding: 8, cornerRadius: 6 }
    },
    scales: {
      x: {
        type: 'time',
        time: { tooltipFormat: 'MMM d HH:mm', displayFormats: { hour: 'HH:mm', day: 'MMM d' } },
        grid: { display: false },
        ticks: { font: { size: 10 }, color: CHART_COLORS.text, maxTicksLimit: 8 },
        stacked: !!stacked
      },
      y: {
        min: 0,
        grid: { color: CHART_COLORS.grid },
        ticks: { font: { size: 10 }, color: CHART_COLORS.text, callback: yCallback || undefined },
        border: { display: false },
        stacked: !!stacked
      }
    }
  };
}

function horizontalBarOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: 'y',
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: '#101827', titleFont: { size: 11 }, bodyFont: { size: 11 }, padding: 8, cornerRadius: 6 }
    },
    scales: {
      x: {
        min: 0,
        grid: { color: CHART_COLORS.grid },
        ticks: { font: { size: 10 }, color: CHART_COLORS.text },
        border: { display: false }
      },
      y: {
        grid: { display: false },
        ticks: { font: { size: 11 }, color: CHART_COLORS.text }
      }
    }
  };
}

function initCharts() {
  if (!window.Chart) return;
  try {
    // 1. Token Usage — stacked bar (input vs output)
    const tokensCtx = document.getElementById('chart-tokens');
    if (tokensCtx) {
      state.charts.tokens = new Chart(tokensCtx, {
        type: 'bar',
        data: {
          datasets: [
            { label: t('trends.input'), data: [], backgroundColor: CHART_COLORS.accent, stack: 'tokens' },
            { label: t('trends.output'), data: [], backgroundColor: CHART_COLORS.purple, stack: 'tokens' }
          ]
        },
        options: barChartOpts((v) => tok(v), true)
      });
    }

    // 2. Cost — bar chart
    const costCtx = document.getElementById('chart-cost');
    if (costCtx) {
      state.charts.cost = new Chart(costCtx, {
        type: 'bar',
        data: {
          datasets: [{ label: t('trends.cost'), data: [], backgroundColor: CHART_COLORS.orange }]
        },
        options: barChartOpts((v) => `$${v}`)
      });
    }

    // 3. Message Throughput — stacked bar (in vs out)
    const msgCtx = document.getElementById('chart-messages');
    if (msgCtx) {
      state.charts.messages = new Chart(msgCtx, {
        type: 'bar',
        data: {
          datasets: [
            { label: t('trends.msg_in'), data: [], backgroundColor: CHART_COLORS.blue, stack: 'msgs' },
            { label: t('trends.msg_out'), data: [], backgroundColor: CHART_COLORS.pink, stack: 'msgs' }
          ]
        },
        options: barChartOpts(undefined, true)
      });
    }

    // 4. Project Distribution — horizontal bar
    const projCtx = document.getElementById('chart-projects');
    if (projCtx) {
      state.charts.projects = new Chart(projCtx, {
        type: 'bar',
        data: {
          labels: [],
          datasets: [{ label: 'Tool Calls', data: [], backgroundColor: CHART_COLORS.green }]
        },
        options: horizontalBarOpts()
      });
    }
  } catch { /* chart init failed — overview still works */ }
}

function getTrendRange() {
  const active = document.querySelector('.range-btn.active[data-range]');
  return active ? active.dataset.range : '24h';
}

function rangeToSince() {
  const range = getTrendRange();
  const now = Date.now();
  const ms = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
  return new Date(now - (ms[range] || ms['24h'])).toISOString();
}

function autoBucket(sinceMs, untilMs) {
  const diffDays = (untilMs - sinceMs) / 86400000;
  if (diffDays <= 2) return 3600;
  if (diffDays <= 60) return 86400;
  return 604800;
}

async function refreshCharts() {
  if (!window.Chart) return;

  let since, until, bucket;
  const customStart = $('#trend-start')?.value;
  const customEnd = $('#trend-end')?.value;
  const isCustom = customStart && customEnd;

  if (isCustom) {
    since = new Date(customStart + 'T00:00:00').toISOString();
    until = new Date(customEnd + 'T23:59:59').toISOString();
    bucket = autoBucket(new Date(since).getTime(), new Date(until).getTime());
  } else {
    since = rangeToSince();
    until = new Date().toISOString();
    const range = getTrendRange();
    bucket = { '24h': 3600, '7d': 86400, '30d': 86400 }[range] || 3600;
  }

  const qp = `since=${since}&until=${until}&bucket=${bucket}`;

  const [tokensData, costData, msgData, projData] = await Promise.allSettled([
    fetchJson(`/api/metrics/series?metric=tokens&${qp}`),
    fetchJson(`/api/metrics/series?metric=cost&${qp}`),
    fetchJson(`/api/metrics/series?metric=messages&${qp}`),
    fetchJson(`/api/metrics/series?metric=projects&since=${since}&until=${until}`)
  ]);

  // 1. Token Usage — stacked bar
  if (state.charts.tokens && tokensData.status === 'fulfilled') {
    const pts = tokensData.value.points || [];
    state.charts.tokens.data.datasets[0].data = pts.map((p) => ({ x: p.bucket_start * 1000, y: p.input_sum }));
    state.charts.tokens.data.datasets[1].data = pts.map((p) => ({ x: p.bucket_start * 1000, y: p.output_sum }));
    state.charts.tokens.update('none');
    const totalInput = pts.reduce((s, p) => s + (p.input_sum || 0), 0);
    const totalOutput = pts.reduce((s, p) => s + (p.output_sum || 0), 0);
    const tokensTotalEl = $('#chart-tokens-total');
    if (tokensTotalEl) tokensTotalEl.textContent = `Total: ${tok(totalInput + totalOutput)} (↑${tok(totalInput)} ↓${tok(totalOutput)})`;
  }

  // 2. Cost — bar
  if (state.charts.cost && costData.status === 'fulfilled') {
    const pts = costData.value.points || [];
    state.charts.cost.data.datasets[0].data = pts.map((p) => ({ x: p.bucket_start * 1000, y: p.cost_sum }));
    state.charts.cost.update('none');
    const totalCost = pts.reduce((s, p) => s + (p.cost_sum || 0), 0);
    const costTotalEl = $('#chart-cost-total');
    if (costTotalEl) costTotalEl.textContent = `Total: ${usd(totalCost)}`;
  }

  // 3. Message Throughput — stacked bar
  if (state.charts.messages && msgData.status === 'fulfilled') {
    const pts = msgData.value.points || [];
    state.charts.messages.data.datasets[0].data = pts.map((p) => ({ x: p.bucket_start * 1000, y: p.msg_in }));
    state.charts.messages.data.datasets[1].data = pts.map((p) => ({ x: p.bucket_start * 1000, y: p.msg_out }));
    state.charts.messages.update('none');
  }

  // 4. Project Distribution — horizontal bar
  if (state.charts.projects && projData.status === 'fulfilled') {
    const items = projData.value.items || [];
    items.sort((a, b) => (b.calls || 0) - (a.calls || 0));
    state.charts.projects.data.labels = items.map((i) => i.name);
    state.charts.projects.data.datasets[0].data = items.map((i) => i.calls || 0);
    state.charts.projects.update('none');
  }
}

function initTrendControls() {
  // Range buttons
  document.querySelectorAll('.range-btn[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-btn[data-range]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      // Clear custom date inputs when a preset is selected
      const startEl = $('#trend-start');
      const endEl = $('#trend-end');
      if (startEl) startEl.value = '';
      if (endEl) endEl.value = '';
      refreshCharts();
    });
  });

  // Custom date range
  const customBtn = $('#trend-custom');
  if (customBtn) {
    customBtn.addEventListener('click', () => {
      const startEl = $('#trend-start');
      const endEl = $('#trend-end');
      if (startEl?.value && endEl?.value) {
        // Deactivate preset buttons
        document.querySelectorAll('.range-btn[data-range]').forEach((b) => b.classList.remove('active'));
        refreshCharts();
      }
    });
  }
}

// ─── Actions Modal ───
let actionsModal = null;

function createActionsModal() {
  if (actionsModal) return actionsModal;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'actions-modal';
  overlay.hidden = true;
  overlay.innerHTML = `
<div class="modal">
  <div class="modal-head">
    <h2>Actions</h2>
    <button class="modal-close" type="button" aria-label="Close">&times;</button>
  </div>
  <div class="modal-body">
    <div class="action-group">
      <span class="action-group-label">Agent Control</span>
      <div class="action-row">
        <button class="action-btn" data-action="interrupt" type="button">Interrupt</button>
        <button class="action-btn action-warn" data-action="restart-session" type="button">Restart Session</button>
      </div>
    </div>
    <div class="action-group">
      <span class="action-group-label">Configuration</span>
      <div class="action-field">
        <label class="action-field-label">Runtime</label>
        <select id="action-runtime" class="action-select">
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </div>
      <div class="action-field">
        <label class="action-field-label">Model</label>
        <div class="action-model-wrap">
          <select id="action-model" class="action-select"></select>
          <input id="action-model-custom" class="action-input" type="text" placeholder="e.g. claude-opus-4-7" hidden />
        </div>
      </div>
      <div class="action-field" id="action-effort-field">
        <label class="action-field-label">Effort</label>
        <select id="action-effort" class="action-select"></select>
      </div>
      <div class="action-field">
        <label class="action-field-label">New Session Threshold</label>
        <button class="tip-btn tip-btn-inline" id="threshold-tip" type="button" aria-label="Threshold info">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4M8 5.5v0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
        <div class="tip-popover" id="threshold-popover" hidden>
          <p><strong>New Session Threshold</strong> — the context level at which the agent should start a new session to avoid degraded performance.</p>
          <p style="margin-top:4px">Recommended: 200K context → 70%, 1M context → ≤40%.</p>
        </div>
        <div class="action-threshold-wrap">
          <input id="action-threshold" class="action-input action-threshold-input" type="number" min="10" max="95" step="5" />
          <span class="action-threshold-unit">%</span>
          <button class="action-btn action-btn-sm" id="action-threshold-apply" type="button">Apply</button>
        </div>
      </div>
    </div>
    <div class="action-group">
      <span class="action-group-label">Upgrade</span>
      <div class="action-row">
        <button class="action-btn" data-action="upgrade-zylos" type="button">
          Upgrade zylos<span class="action-ver" id="action-zylos-ver"></span>
        </button>
        <button class="action-btn" data-action="upgrade-cc" type="button">
          Upgrade CC<span class="action-ver" id="action-cc-ver"></span>
        </button>
      </div>
    </div>
  </div>
  <div class="modal-status" id="action-status" hidden></div>
  <div class="modal-confirm" id="action-confirm" hidden>
    <p id="action-confirm-text"></p>
    <div class="modal-confirm-buttons">
      <button class="action-btn" id="action-confirm-cancel" type="button">Cancel</button>
      <button class="action-btn danger" id="action-confirm-ok" type="button">Confirm</button>
    </div>
  </div>
</div>`;
  document.body.appendChild(overlay);
  actionsModal = overlay;

  overlay.querySelector('.modal-close').addEventListener('click', closeActionsModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeActionsModal(); });

  overlay.querySelectorAll('.action-btn[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => execAction(btn.dataset.action));
  });

  async function selectAction(sel, action, key) {
    if (sel._inFlight) return;
    const prev = sel._prevValue || sel.value;
    const val = sel.value;
    if (val === prev) return;
    sel._inFlight = true;
    try {
      const ok = await execAction(action, { [key]: val });
      if (ok === false) sel.value = prev;
      else sel._prevValue = val;
    } finally {
      sel._inFlight = false;
    }
  }

  const modelSel = overlay.querySelector('#action-model');
  const modelCustom = overlay.querySelector('#action-model-custom');
  modelSel.addEventListener('change', () => {
    if (modelSel.value === '__custom__') {
      modelCustom.hidden = false;
      modelCustom.focus();
    } else {
      modelCustom.hidden = true;
      if (actionsModal?._renderEffortOptions) actionsModal._renderEffortOptions(modelSel.value);
      selectAction(modelSel, 'switch-model', 'model');
    }
  });
  modelCustom.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && modelCustom.value.trim()) {
      execAction('switch-model', { model: modelCustom.value.trim() });
    }
  });

  const runtimeSel = overlay.querySelector('#action-runtime');
  runtimeSel.addEventListener('change', () => {
    selectAction(runtimeSel, 'switch-runtime', 'runtime');
  });

  const effortSel = overlay.querySelector('#action-effort');
  effortSel.addEventListener('change', () => {
    selectAction(effortSel, 'switch-effort', 'effort');
  });

  const thresholdApply = overlay.querySelector('#action-threshold-apply');
  const thresholdInput = overlay.querySelector('#action-threshold');
  thresholdApply.addEventListener('click', async () => {
    const val = parseInt(thresholdInput.value, 10);
    if (!val || val < 10 || val > 95) return;
    const result = await execAction('set-threshold', { value: val });
    if (result !== false) {
      state.newSessionThreshold = val;
      renderMetrics();
    }
  });
  thresholdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') thresholdApply.click();
  });

  const thresholdTipBtn = overlay.querySelector('#threshold-tip');
  const thresholdPop = overlay.querySelector('#threshold-popover');
  if (thresholdTipBtn && thresholdPop) {
    const pop = thresholdPop.cloneNode(true);
    pop.removeAttribute('id');
    pop.hidden = true;
    document.body.appendChild(pop);
    thresholdPop.remove();
    thresholdTipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pop.hidden) {
        const rect = thresholdTipBtn.getBoundingClientRect();
        pop.style.top = `${rect.bottom + 6}px`;
        const left = Math.max(8, rect.left - 120);
        const maxLeft = window.innerWidth - 280 - 8;
        pop.style.left = `${Math.min(left, Math.max(8, maxLeft))}px`;
        pop.hidden = false;
      } else {
        pop.hidden = true;
      }
    });
    document.addEventListener('click', () => { pop.hidden = true; });
  }

  return overlay;
}

async function openActionsModal() {
  const modal = createActionsModal();
  modal.hidden = false;

  const statusEl = modal.querySelector('#action-status');
  statusEl.hidden = true;
  updateRestartDot();

  try {
    const meta = await fetchJson('/api/actions/meta');
    const runtimeSel = modal.querySelector('#action-runtime');
    runtimeSel.value = meta.runtime;

    const modelSel = modal.querySelector('#action-model');
    modelSel.innerHTML = '';
    for (const m of meta.models || []) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.id;
      if (m.id === meta.current_model) opt.selected = true;
      modelSel.appendChild(opt);
    }
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = 'Custom...';
    modelSel.appendChild(customOpt);
    modal.querySelector('#action-model-custom').hidden = true;

    const effortField = modal.querySelector('#action-effort-field');
    const effortSel = modal.querySelector('#action-effort');
    const effortsByModel = meta.efforts_by_model || {};
    modal._renderEffortOptions = (modelId) => {
      const list = effortsByModel[modelId] || effortsByModel['*'] || [];
      if (!list.length) {
        effortField.hidden = true;
        return;
      }
      effortField.hidden = false;
      effortSel.innerHTML = '';
      for (const e of list) {
        const opt = document.createElement('option');
        opt.value = e;
        opt.textContent = EFFORT_LABELS[e] || e.charAt(0).toUpperCase() + e.slice(1);
        if (e === meta.current_effort) opt.selected = true;
        effortSel.appendChild(opt);
      }
      effortSel._prevValue = effortSel.value;
    };
    modal._renderEffortOptions(meta.current_model);

    const ri = state.dashboardState?.runtime_info;
    const zylosVer = modal.querySelector('#action-zylos-ver');
    const ccVer = modal.querySelector('#action-cc-ver');
    zylosVer.textContent = meta.zylos_version ? ` v${meta.zylos_version}` : '';
    zylosVer.classList.toggle('action-ver-dot', !!ri?.zylos_update);
    zylosVer.title = ri?.zylos_update ? `v${ri.zylos_update} available` : '';
    ccVer.textContent = meta.cc_version ? ` v${meta.cc_version}` : '';
    ccVer.classList.toggle('action-ver-dot', !!ri?.cc_update);
    ccVer.title = ri?.cc_update ? `v${ri.cc_update} available` : '';

    runtimeSel._prevValue = runtimeSel.value;
    modelSel._prevValue = modelSel.value;
    effortSel._prevValue = effortSel.value;

    const thresholdInput = modal.querySelector('#action-threshold');
    if (thresholdInput) thresholdInput.value = meta.new_session_threshold || state.newSessionThreshold || 70;
  } catch { /* meta unavailable, modal still usable */ }
}

function closeActionsModal() {
  if (!actionsModal) return;
  actionsModal.hidden = true;
  const confirm = actionsModal.querySelector('#action-confirm');
  if (confirm) confirm.hidden = true;
  const status = actionsModal.querySelector('#action-status');
  if (status) status.hidden = true;
}

function updateRestartDot() {
  const btn = actionsModal?.querySelector('.action-btn[data-action="restart-session"]');
  if (!btn) return;
  const pending = !!state.dashboardState?.runtime_info?.pending_restart;
  btn.classList.toggle('action-btn-pending', pending);
  btn.title = pending ? 'Pending changes require restart to take effect' : '';
}

const CONFIRM_ACTIONS = new Set(['interrupt', 'restart-session', 'switch-runtime', 'switch-model', 'switch-effort', 'upgrade-zylos', 'upgrade-cc']);

function showConfirm(text) {
  return new Promise((resolve) => {
    const box = actionsModal?.querySelector('#action-confirm');
    const msg = actionsModal?.querySelector('#action-confirm-text');
    const okBtn = actionsModal?.querySelector('#action-confirm-ok');
    const cancelBtn = actionsModal?.querySelector('#action-confirm-cancel');
    if (!box || !msg || !okBtn || !cancelBtn) { resolve(false); return; }

    msg.textContent = text;
    box.hidden = false;

    function cleanup() {
      box.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
    }
    function onOk() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

async function execAction(action, body) {
  if (CONFIRM_ACTIONS.has(action)) {
    const labels = {
      'interrupt': 'Interrupt the agent? This will cancel the current operation.',
      'restart-session': 'Restart the agent session? Context is preserved via memory.',
      'switch-runtime': `Switch runtime to ${body?.runtime}? Session will restart.`,
      'switch-model': `Switch model to ${body?.model}?`,
      'switch-effort': `Switch effort to ${EFFORT_LABELS[body?.effort] || body?.effort}?`,
      'upgrade-zylos': 'Upgrade zylos-core? All services will restart.',
      'upgrade-cc': 'Upgrade Claude Code?'
    };
    if (!(await showConfirm(labels[action] || `Execute ${action}?`))) return false;
  }

  const statusEl = actionsModal?.querySelector('#action-status');
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = 'modal-status running';
    statusEl.textContent = 'Executing...';
  }

  try {
    const r = await fetch(api(`/api/actions/${action}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const result = await r.json();
    if (statusEl) {
      const isInfo = !result.ok && (result.error === 'already_up_to_date' || result.error === 'already_set');
      statusEl.className = result.ok ? 'modal-status success' : isInfo ? 'modal-status success' : 'modal-status error';
      statusEl.textContent = result.message || (result.ok ? 'Done' : result.error);
      if (result.ok || isInfo) setTimeout(() => { statusEl.hidden = true; }, 5000);
    }
    if (result.ok && result.requires_restart) {
      await new Promise(r => setTimeout(r, 1500));
      if (statusEl) statusEl.hidden = true;
      await execAction('restart-session');
    }
    return result.ok;
  } catch (err) {
    if (statusEl) {
      statusEl.className = 'modal-status error';
      statusEl.textContent = `Failed: ${err.message}`;
    }
    return false;
  }
}

function initActionsGear() {
  document.addEventListener('click', (e) => {
    const gear = e.target.closest('#gear-btn, .info-bar-gear, .info-bar-update');
    if (gear) { e.preventDefault(); openActionsModal(); }
  });
}

// ─── Timers ───
function startTimers() {
  state.timer = setInterval(() => { renderState(); renderMetrics(); renderHealth(); }, 1000);
  state.pollTimer = setInterval(refreshAll, 30_000);
}

window.addEventListener('beforeunload', () => {
  clearInterval(state.timer);
  clearInterval(state.pollTimer);
  clearTimeout(state.sseReconnectTimer);
  state.eventSource?.close();
});

// ─── Init ───
initTheme();
await initI18n();
initTabs();
initLocaleToggle();
initLogout();
initTips();
initActionsGear();
renderAll();
initCharts();
initTrendControls();
connectSse();
await refreshAll();
startTimers();
