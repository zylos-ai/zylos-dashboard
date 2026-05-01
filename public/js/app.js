import { connectEvents } from './events.js';
import { updateOverviewChart } from './charts.js';

const $ = (selector) => document.querySelector(selector);

function metric(summary, path) {
  return path.reduce((node, key) => (node == null ? null : node[key]), summary);
}

function value(result, fallback = null) {
  return result?.value ?? fallback;
}

function text(selector, content) {
  const node = $(selector);
  if (node) node.textContent = content == null || content === '' ? 'n/a' : String(content);
}

function badge(selector, availability) {
  const node = $(selector);
  if (!node) return;
  node.textContent = availability || 'unknown';
  node.className = `badge ${availability || 'unknown'}`;
}

function formatMoney(number) {
  const valueNumber = Number(number);
  if (!Number.isFinite(valueNumber)) return 'n/a';
  return `$${valueNumber.toFixed(4)}`;
}

function formatPercent(number) {
  const valueNumber = Number(number);
  if (!Number.isFinite(valueNumber)) return 'n/a';
  return `${Math.round(valueNumber)}%`;
}

function formatBytes(bytes) {
  const valueNumber = Number(bytes);
  if (!Number.isFinite(valueNumber)) return '0 MB';
  return `${Math.round(valueNumber / 1024 / 1024)} MB`;
}

function formatEpoch(seconds) {
  const valueNumber = Number(seconds);
  if (!Number.isFinite(valueNumber) || valueNumber <= 0) return 'n/a';
  return new Date(valueNumber * 1000).toLocaleString();
}

function rows(tbodySelector, items, render) {
  const tbody = $(tbodySelector);
  if (!tbody) return;
  tbody.replaceChildren();
  if (!items || items.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = 'No data';
    tr.append(td);
    tbody.append(tr);
    return;
  }
  for (const item of items) {
    const tr = document.createElement('tr');
    for (const cell of render(item)) {
      const td = document.createElement('td');
      td.textContent = cell == null ? 'n/a' : String(cell);
      tr.append(td);
    }
    tbody.append(tr);
  }
}

function summarizeQuality(summary) {
  const results = Object.values(summary.metrics || {});
  const ok = results.filter((item) => item.availability === 'ok').length;
  const stale = results.filter((item) => item.availability === 'stale').length;
  const missing = results.filter((item) => item.availability === 'missing').length;
  return `${ok} ok / ${stale} stale / ${missing} missing`;
}

export function render(summary) {
  const agent = metric(summary, ['status', 'agent']);
  const context = metric(summary, ['status', 'context']);
  const cost = metric(summary, ['cost', 'session']);
  const pm2 = metric(summary, ['operations', 'pm2Services']);
  const tools = metric(summary, ['tools', 'calls']);
  const failures = metric(summary, ['tools', 'failures']);
  const duration = metric(summary, ['tools', 'duration']);
  const messages = metric(summary, ['operations', 'messages']);
  const tasks = metric(summary, ['operations', 'scheduledTasks']);

  const agentValue = value(agent, {});
  text('#agent-state', agentValue.state || 'unknown');
  text('#agent-meta', `${agent.availability} from ${agent.source || 'none'}`);

  const contextValue = value(context, {});
  text('#context-usage', formatPercent(contextValue.usedPercentage));
  text('#context-meta', `${context.availability} from ${context.source || 'none'}`);

  const costValue = value(cost, {});
  text('#session-cost', formatMoney(costValue.usd));
  text('#cost-meta', cost.availability);

  const pm2Value = value(pm2, {});
  text('#pm2-summary', `${pm2Value.online ?? 0}/${pm2Value.count ?? 0}`);
  text('#pm2-meta', pm2.availability);

  const health = metric(summary, ['status', 'health']);
  const healthValue = value(health, {});
  const pill = $('#health-pill');
  if (pill) {
    const ok = healthValue.health === 'ok' || health?.availability === 'ok';
    pill.textContent = ok ? 'Online' : 'Degraded';
    pill.className = `status-pill ${ok ? 'ok' : 'error'}`;
  }

  text('#last-updated', `Updated ${new Date(summary.generatedAt).toLocaleTimeString()}`);
  text('#data-quality', summarizeQuality(summary));
  badge('#tools-availability', tools?.availability);
  badge('#messages-availability', messages?.availability);
  badge('#tasks-availability', tasks?.availability);
  badge('#services-availability', pm2?.availability);

  text('#tool-call-count', value(tools, {}).count ?? 0);
  text('#tool-failure-count', value(failures, {}).count ?? 0);
  text('#tool-duration', value(duration, {}).averageMs == null ? 'n/a' : `${value(duration, {}).averageMs} ms`);

  rows('#messages-table', value(messages, {}).totals?.slice(0, 8), (row) => [row.channel, row.direction, row.status, row.count]);
  rows('#tasks-table', value(tasks, {}).upcoming?.slice(0, 8), (row) => [row.name, row.status, formatEpoch(row.next_run_at)]);
  rows('#services-table', value(pm2, {}).processes?.slice(0, 10), (row) => [row.name, row.status, `${row.cpu}%`, formatBytes(row.memory)]);

  updateOverviewChart({
    context: contextValue.usedPercentage,
    cache: value(metric(summary, ['cost', 'cacheHitRate']), {}).percentage,
    servicesOnline: pm2Value.online,
    servicesTotal: pm2Value.count,
    toolFailures: value(failures, {}).count
  });
}

async function fetchSummary() {
  const response = await fetch('/api/summary');
  if (!response.ok) throw new Error(`summary ${response.status}`);
  return response.json();
}

async function refresh() {
  render(await fetchSummary());
}

connectEvents(render, refresh);
refresh().catch((err) => {
  text('#last-updated', err.message);
  const pill = $('#health-pill');
  if (pill) {
    pill.textContent = 'Error';
    pill.className = 'status-pill error';
  }
});
