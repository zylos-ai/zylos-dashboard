export const MASCOT_BY_MOOD = {
  busy: 'busy.png',
  thinking: 'thinking.png',
  idle: 'idle.png',
  stuck: 'stuck.png',
  offline: 'offline.png'
};

const TOOL_GLYPHS = {
  bash: '⌁',
  shell: '⌁',
  exec_command: '⌁',
  browser: '◱',
  web: '◱',
  edit: '✎',
  apply_patch: '✎',
  default: '•'
};

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function pctValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n <= 1 ? n * 100 : n));
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function ageSeconds(timestamp, nowMs) {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((nowMs - ms) / 1000));
}

function ageLabel(timestamp, nowMs, labels) {
  const age = ageSeconds(timestamp, nowMs);
  if (age == null) return '--';
  if (age < 2) return labels.justNow;
  if (age < 60) return labels.secondsAgo.replace('{count}', String(age));
  if (age < 3600) return labels.minutesAgo.replace('{count}', String(Math.floor(age / 60)));
  return labels.hoursAgo.replace('{count}', String(Math.floor(age / 3600)));
}

export function stateMood(agent) {
  const state = String(agent?.state || 'UNKNOWN').toUpperCase();
  const reason = String(agent?.health_reason || '').toLowerCase();
  const activity = String(agent?.activity || '').toLowerCase();
  if (state === 'OFFLINE' || reason === 'offline' || reason === 'unreachable' || reason === 'version_unsupported' || reason === 'auth_failed') return 'offline';
  if (state === 'STUCK' || state === 'POSSIBLY_STUCK' || reason.includes('stuck')) return 'stuck';
  if (state === 'IDLE') return 'idle';
  if (state === 'BUSY' && (activity.includes('thinking') || activity.includes('思考'))) return 'thinking';
  if (state === 'THINKING') return 'thinking';
  if (state === 'BUSY') return 'busy';
  return 'idle';
}

function isOffline(agent) {
  return stateMood(agent) === 'offline' || Number(agent?.pulse_rate) === 0;
}

function stateLabel(agent, labels) {
  const mood = stateMood(agent);
  const reason = String(agent?.health_reason || '').toLowerCase();
  if (reason === 'version_unsupported') return labels.versionUnsupported;
  if (reason === 'unreachable') return labels.unreachable;
  if (reason === 'auth_failed') return labels.authFailed;
  if (mood === 'busy') return labels.busy;
  if (mood === 'thinking') return labels.thinking;
  if (mood === 'stuck') return labels.stuck;
  if (mood === 'offline') return labels.offline;
  return labels.idle;
}

function toolParts(agent, labels) {
  const activity = String(agent?.activity || '').trim();
  if (!activity) return { glyph: TOOL_GLYPHS.default, verb: labels.noActivity };
  const first = activity.split(/[\s:]/)[0].toLowerCase();
  const glyph = TOOL_GLYPHS[first] || TOOL_GLYPHS.default;
  return { glyph, verb: activity };
}

function colorForAgent(agent) {
  return agent?.color || '#64748b';
}

function sparklineValues(agent) {
  const raw = Array.isArray(agent?.sparkline) ? agent.sparkline : [];
  const values = raw.map(Number).filter(Number.isFinite).slice(-12);
  if (values.length > 0) return values;
  const cost = Number(agent?.cost);
  return Number.isFinite(cost) && cost > 0 ? [0, cost * 0.4, cost * 0.7, cost] : [0, 0, 0];
}

function sparklinePoints(agent) {
  const values = sparklineValues(agent);
  const max = Math.max(...values, 0.001);
  return values.map((value, index) => {
    const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 48;
    const y = 18 - (value / max) * 16;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

function mascotSrc(mood, root) {
  const cleanRoot = String(root || './img/mascot').replace(/\/+$/, '');
  return `${cleanRoot}/${MASCOT_BY_MOOD[mood]}`;
}

export function defaultPulseWallLabels() {
  return {
    title: 'Pulse Wall',
    subtitle: 'Fleet heartbeat',
    totalCost: 'Total $/min',
    busy: 'busy',
    thinking: 'thinking',
    idle: 'idle',
    stuck: 'stuck',
    offline: 'offline',
    unreachable: 'unreachable',
    versionUnsupported: 'version unsupported',
    authFailed: 'auth failed',
    noActivity: 'standing by',
    lastSeen: 'last seen',
    context: 'context',
    justNow: 'just now',
    secondsAgo: '{count}s ago',
    minutesAgo: '{count}m ago',
    hoursAgo: '{count}h ago',
    empty: 'No fleet agents configured',
    you: 'you'
  };
}

export function buildPulseWallView(fleet, options = {}) {
  const labels = { ...defaultPulseWallLabels(), ...(options.labels || {}) };
  const nowMs = options.nowMs ?? Date.now();
  const basePath = options.basePath || '';
  const agents = Array.isArray(fleet?.agents) ? [...fleet.agents] : [];
  const tiles = agents
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    .map((agent) => {
      const mood = stateMood(agent);
      const offline = isOffline(agent);
      const contextPct = pctValue(agent.context_pct);
      const pulseRate = offline ? 0 : Math.max(0.6, Math.min(2.4, Number(agent.pulse_rate) || 1));
      const tool = toolParts(agent, labels);
      const color = colorForAgent(agent);
      const isSelf = agent.self === true;
      return {
        name: String(agent.name || ''),
        mood,
        offline,
        isSelf,
        color,
        hue: Number.isFinite(Number(agent.hue)) ? Number(agent.hue) : 0,
        stateLabel: stateLabel(agent, labels),
        activity: tool.verb,
        glyph: tool.glyph,
        contextPct,
        cost: Number.isFinite(Number(agent.cost)) ? Number(agent.cost) : null,
        costLabel: money(agent.cost),
        lastSeenLabel: ageLabel(agent.last_seen || agent.updated_at, nowMs, labels),
        reason: agent.health_reason || '',
        pulseRate,
        sparkline: sparklinePoints(agent),
        href: isSelf ? `${basePath}/` : `${basePath}/fleet/${encodeURIComponent(String(agent.name || ''))}/`,
        mascotSrc: mascotSrc(mood, options.mascotRoot)
      };
    });

  const counts = tiles.reduce((acc, tile) => {
    acc[tile.mood] = (acc[tile.mood] || 0) + 1;
    return acc;
  }, { busy: 0, thinking: 0, idle: 0, stuck: 0, offline: 0 });
  const totalCost = tiles.reduce((sum, tile) => sum + (tile.cost || 0), 0);
  const activePulse = tiles.filter((tile) => !tile.offline).reduce((sum, tile) => sum + tile.pulseRate, 0);

  return {
    labels,
    tiles,
    counts,
    totalCost,
    totalCostLabel: money(totalCost),
    activePulse,
    updatedAt: fleet?.updated_at || null
  };
}

function renderTile(tile, labels) {
  const ringPct = tile.contextPct == null ? 0 : tile.contextPct;
  const reason = tile.reason ? `<span class="pulse-tile-reason">${escapeHtml(tile.stateLabel)}</span>` : '';
  const selfBadge = tile.isSelf ? `<span class="pulse-self-badge">${escapeHtml(labels.you)}</span>` : '';
  return `<a class="pulse-tile pulse-tile-${escapeHtml(tile.mood)}${tile.offline ? ' is-offline' : ''}${tile.isSelf ? ' is-self' : ''}" href="${escapeHtml(tile.href)}" data-agent="${escapeHtml(tile.name)}" data-state="${escapeHtml(tile.mood)}"${tile.isSelf ? ' data-self="true"' : ''} style="--agent-accent:${escapeHtml(tile.color)};--agent-hue:${tile.hue}deg;--pulse-rate:${tile.pulseRate}s;--context-pct:${ringPct};">
    <div class="pulse-tile-top">
      <span class="pulse-dot" aria-hidden="true"></span>
      <span class="pulse-name">${escapeHtml(tile.name)}${selfBadge}</span>
      <span class="pulse-state">${escapeHtml(tile.stateLabel)}</span>
    </div>
    <div class="pulse-mascot-wrap">
      <span class="context-ring" aria-label="${escapeHtml(labels.context)} ${ringPct.toFixed(0)}%" style="--context-pct:${ringPct};"></span>
      <img class="pulse-mascot" src="${escapeHtml(tile.mascotSrc)}" alt="" loading="lazy">
    </div>
    <div class="pulse-now">
      <span class="pulse-tool-glyph" aria-hidden="true">${escapeHtml(tile.glyph)}</span>
      <span class="pulse-verb">${escapeHtml(tile.activity)}</span>
    </div>
    <div class="pulse-tile-bottom">
      <span class="pulse-cost">${escapeHtml(tile.costLabel)}</span>
      <svg class="pulse-sparkline" viewBox="0 0 48 20" aria-hidden="true"><polyline points="${escapeHtml(tile.sparkline)}"></polyline></svg>
      <span class="pulse-last-seen">${escapeHtml(labels.lastSeen)} ${escapeHtml(tile.lastSeenLabel)}</span>
    </div>
    ${reason}
  </a>`;
}

function renderPulseWallViewHtml(view) {
  const { labels } = view;
  if (view.tiles.length === 0) {
    return `<section class="pulse-wall"><p class="empty-state">${escapeHtml(labels.empty)}</p></section>`;
  }
  const summary = `${view.counts.busy} ${labels.busy} · ${view.counts.idle} ${labels.idle} · ${view.counts.stuck} ${labels.stuck}`;
  return `<section class="pulse-wall" data-fleet-count="${view.tiles.length}">
    <div class="pulse-heartbeat-bar">
      <div>
        <h2>${escapeHtml(labels.title)}</h2>
        <p>${escapeHtml(labels.subtitle)}</p>
      </div>
      <div class="fleet-pulse-meter" style="--fleet-pulse:${view.activePulse};">
        <span class="fleet-pulse-dot" aria-hidden="true"></span>
        <strong>${escapeHtml(summary)}</strong>
      </div>
      <div class="fleet-cost">
        <span>${escapeHtml(labels.totalCost)}</span>
        <strong>${escapeHtml(view.totalCostLabel)}</strong>
      </div>
    </div>
    <div class="pulse-grid">
      ${view.tiles.map((tile) => renderTile(tile, labels)).join('')}
    </div>
  </section>`;
}

export function renderPulseWallHtml(fleet, options = {}) {
  return renderPulseWallViewHtml(buildPulseWallView(fleet, options));
}

export function renderPulseWall(container, fleet, options = {}) {
  if (!container) return null;
  const view = buildPulseWallView(fleet, options);
  container.innerHTML = renderPulseWallViewHtml(view);
  return view;
}
