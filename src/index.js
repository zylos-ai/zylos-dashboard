#!/usr/bin/env node
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AuthGate, exchangeApiKeyForToken, generateApiKey, validateApiSession } from './lib/auth.js';
import { browserBaseFromRequest } from './lib/browser-base.js';
import {
  DEFAULT_RUNTIME_SERVICE_TIER_MODEL_PRICES,
  DEFAULT_RUNTIME_MODEL_PRICES,
  ensureDataDirs,
  fastModeMultiplierForRuntime,
  loadConfig,
  modelPricesForRuntime,
  publicDir
} from './lib/config.js';
import { readJsonBody, sendHtml, sendJson, sendText, serveStatic } from './lib/http.js';
import { Store } from './lib/store.js';
import { Sanitizer } from './lib/sanitizer.js';
import { IngestHandler } from './lib/ingest-handler.js';
import { SpoolDrainer } from './lib/spool-drainer.js';
import { PM2Collector } from './lib/collectors/pm2-collector.js';
import { SystemCollector } from './lib/collectors/system-collector.js';
import { StatuslineCollector } from './lib/collectors/statusline-collector.js';
import { ConversationCollector } from './lib/collectors/conversation-collector.js';
import { CodexRolloutCollector } from './lib/collectors/codex-rollout-collector.js';
import { StateEngine } from './lib/state-engine.js';
import { MetricResolver } from './lib/metric-resolver.js';
import { resolveAggregateValue } from './lib/metric-aggregate.js';
import { runMetricMaintenance } from './lib/metric-maintenance.js';
import { buildSystemPayload } from './lib/system-api.js';
import { SseHub } from './lib/sse.js';
import { C4Reader } from './lib/c4-reader.js';
import { consumeZylosUpgradeMarker, handleAction, getActionsMeta, readCodexModels, readCodexRootString } from './lib/actions.js';
import { VersionChecker } from './lib/version-checker.js';
import { isNewerVersion } from './lib/version-utils.js';
import { applyVersionUpdateFields } from './lib/runtime-info.js';
import Database from 'better-sqlite3';

const startedAt = new Date();

let zylosVersion = null;
let ccInstalledVersion = null;
let codexInstalledVersion = null;
try {
  zylosVersion = execFileSync('zylos', ['--version'], { timeout: 5000 }).toString().trim();
} catch { /* zylos CLI not available */ }
try {
  const raw = execFileSync('claude', ['--version'], { timeout: 5000 }).toString().trim();
  ccInstalledVersion = raw.replace(/\s.*$/, '');
} catch { /* claude CLI not available */ }
try {
  const raw = execFileSync('codex', ['--version'], { timeout: 5000 }).toString().trim();
  codexInstalledVersion = raw.replace(/^codex-cli\s+/, '').replace(/\s.*$/, '');
} catch { /* codex CLI not available */ }

function readInstalledVersions() {
  try {
    zylosVersion = execFileSync('zylos', ['--version'], { timeout: 5000 }).toString().trim();
  } catch { /* ignore */ }
  try {
    const raw = execFileSync('claude', ['--version'], { timeout: 5000 }).toString().trim();
    ccInstalledVersion = raw.replace(/\s.*$/, '');
  } catch { /* ignore */ }
  try {
    const raw = execFileSync('codex', ['--version'], { timeout: 5000 }).toString().trim();
    codexInstalledVersion = raw.replace(/^codex-cli\s+/, '').replace(/\s.*$/, '');
  } catch { /* ignore */ }
}

function refreshInstalledVersions() {
  readInstalledVersions();
  const st = stateEngine?.getState();
  if (st) {
    st.runtime_info = buildRuntimeInfo();
    sse.broadcast('state_change', st);
  }
}

const config = loadConfig();
ensureDataDirs(config);
let zylosUpgradeResult = consumeZylosUpgradeMarker(config.zylosDir, zylosVersion);

const activeRuntime = loadZylosConfig(config.zylosDir).runtime || process.env.ZYLOS_RUNTIME || 'claude';
const isClaudeRuntime = activeRuntime === 'claude';
config.runtime = activeRuntime;

// 1-2. Store
const dbPath = path.join(config.dataDir, 'dashboard.db');
let store;
try {
  store = new Store(dbPath);
} catch (err) {
  console.error(`[dashboard] Failed to open database: ${err.message}`);
  process.exit(1);
}

const auth = new AuthGate(config, store);

// 3. Sanitizer
const sanitizer = new Sanitizer(config.zylosDir);

// 4. Spool drain (DB-only, before state engine)
const spoolDrainer = new SpoolDrainer(store, sanitizer, config);
const spoolResult = spoolDrainer.drainToDb();
if (spoolResult.processed > 0) {
  process.stderr.write(`[startup] Drained ${spoolResult.processed} spool events to DB\n`);
}

// 5-6. Collectors
const pm2Collector = new PM2Collector(store, config);
const systemCollector = new SystemCollector(store, config);
const statuslineCollector = isClaudeRuntime ? new StatuslineCollector(store, config) : null;
const conversationCollector = isClaudeRuntime ? new ConversationCollector(store, config) : null;
const codexRolloutCollector = activeRuntime === 'codex' ? new CodexRolloutCollector(store, config) : null;

const collectors = { pm2: pm2Collector, system: systemCollector };
if (statuslineCollector) collectors.statusline = statuslineCollector;
if (conversationCollector) collectors.conversation = conversationCollector;
if (codexRolloutCollector) collectors.codexRollout = codexRolloutCollector;
if (!isClaudeRuntime) process.stderr.write(`[startup] Runtime "${activeRuntime}" — Claude-only collectors skipped\n`);

// SSE hub
const sse = new SseHub(15_000);

// 6b. Version checker (polls GitHub + npm registry every 12h)
const versionChecker = new VersionChecker({
  onUpdate: () => {
    if (stateEngine) {
      const st = stateEngine.getState();
      st.runtime_info = buildRuntimeInfo();
      sse.broadcast('state_change', st);
    }
  },
});
versionChecker.start();

function readClaudeSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.zylosDir, '.claude', 'settings.json'), 'utf8'));
  } catch { return {}; }
}

function buildRuntimeInfo() {
  readInstalledVersions();
  const slInfo = statuslineCollector?.getRuntimeInfo();
  const latest = versionChecker.getLatest();
  const ccRunning = slInfo?.cc_version || null;

  const settings = isClaudeRuntime ? readClaudeSettings() : {};
  const codexModels = activeRuntime === 'codex' ? readCodexModels() : [];
  const codexRuntimeInfo = codexRolloutCollector?.getRuntimeInfo?.() || null;
  const codexModel = activeRuntime === 'codex' ? codexRuntimeInfo?.model_id || readCodexRootString('model', config.zylosDir) : null;
  const codexModelInfo = codexModels.find(m => m.id === codexModel) || codexModels[0] || null;
  const codexEffort = activeRuntime === 'codex' ? readCodexRootString('model_reasoning_effort', config.zylosDir) : null;
  const needsRestart = isClaudeRuntime &&
    ((settings.model && slInfo?.model_id && settings.model !== slInfo.model_id) ||
    (settings.effortLevel && slInfo?.effort && settings.effortLevel !== slInfo.effort) ||
    (ccInstalledVersion && ccRunning && isNewerVersion(ccInstalledVersion, ccRunning)));

  const info = {
    zylos_version: zylosVersion,
    runtime: activeRuntime,
    model: activeRuntime === 'codex' ? codexModelInfo?.display_name || codexRuntimeInfo?.model || codexModelInfo?.id || codexModel : slInfo?.model || null,
    model_id: activeRuntime === 'codex' ? codexModel || null : slInfo?.model_id || null,
    effort: activeRuntime === 'codex' ? codexEffort || codexModelInfo?.default_effort || null : slInfo?.effort || null,
    service_tier: activeRuntime === 'codex' ? codexRuntimeInfo?.service_tier || null : null,
    cc_version: ccRunning,
    cc_installed: ccInstalledVersion || null,
    codex_version: codexInstalledVersion || null,
    codex_installed: codexInstalledVersion || null,
    pending_restart: !!needsRestart,
    zylos_upgrade_result: zylosUpgradeResult,
  };
  // info bar: installed newer than running → show restart hint
  if (ccInstalledVersion && ccRunning && isNewerVersion(ccInstalledVersion, ccRunning)) {
    info.cc_restart = ccInstalledVersion;
  }
  // upgrade button: installed != latest → show upgrade dot
  const ccEffective = ccInstalledVersion || ccRunning;
  return applyVersionUpdateFields(info, latest, {
    zylosVersion,
    ccEffectiveVersion: ccEffective,
    codexInstalledVersion,
  });
}

// 7. State engine
const stateEngine = new StateEngine(store, collectors, config, {
  onStateChange: (st) => {
    st.runtime_info = buildRuntimeInfo();
    sse.broadcast('state_change', st);
  }
});

// Wire collector updates to state engine
pm2Collector._onUpdate = (data) => stateEngine.onPM2Update(data);
systemCollector._onUpdate = (data) => stateEngine.onSystemUpdate(data);
if (conversationCollector) {
  conversationCollector._stateEngine = stateEngine;
  conversationCollector._onEvent = (event) => stateEngine.onEvent(event);
}
if (codexRolloutCollector) {
  codexRolloutCollector._onEvent = (event) => stateEngine.onEvent(event);
  codexRolloutCollector._onRuntimeInfo = () => {
    const st = stateEngine.getState();
    st.runtime_info = buildRuntimeInfo();
    sse.broadcast('state_change', st);
  };
  codexRolloutCollector._onMetric = (metric) => {
    sse.broadcast('metric_update', {
      metric_name: metric.metric_name,
      value: Number(metric.metric_value),
      dimensions: metric.dimensions || null,
      source: metric.source || 'rollout',
      confidence: metric.confidence || 'actual',
      timestamp: metric.timestamp || new Date().toISOString()
    });
  };
}

// 8. Metric resolver
const metricResolver = new MetricResolver(store, collectors, config, { stateEngine });

// 9b. C4 reader (read-only access to comm-bridge DB)
const c4Reader = new C4Reader(config.zylosDir);

// 9. Ingest handler (with state engine reference)
const ingestHandler = new IngestHandler(store, sanitizer, stateEngine, config);

async function startupSequence() {
  // Initial collector runs
  try { await pm2Collector.collect(); } catch (err) {
    process.stderr.write(`[startup] PM2 collector initial run failed: ${err.message}\n`);
  }
  try { await systemCollector.warmup(); } catch (err) {
    process.stderr.write(`[startup] System collector warmup failed: ${err.message}\n`);
  }
  if (statuslineCollector) {
    try { await statuslineCollector.collect(); } catch (err) {
      process.stderr.write(`[startup] StatusLine collector initial run failed: ${err.message}\n`);
    }
  }
  if (conversationCollector) {
    try { conversationCollector.collect(); } catch (err) {
      process.stderr.write(`[startup] Conversation collector initial run failed: ${err.message}\n`);
    }
  }
  if (codexRolloutCollector) {
    try { codexRolloutCollector.collect(); } catch (err) {
      process.stderr.write(`[startup] Codex rollout collector initial run failed: ${err.message}\n`);
    }
  }

  // State engine initialize (snapshot restore + replay)
  await stateEngine.initialize();
}

function loadZylosConfig(zylosDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function extractFilePath(summary) {
  if (!summary) return null;
  const m = summary.match(/^(?:Read|Edit|Write):\s+(\S+)/);
  return m ? m[1] : null;
}

function extractProject(filePath) {
  if (!filePath) return null;
  const parts = filePath.replace(/^\/+/, '').split('/');
  const wsIdx = parts.indexOf('workspace');
  if (wsIdx >= 0 && parts[wsIdx + 1]) return parts[wsIdx + 1];
  const skillsIdx = parts.indexOf('skills');
  if (skillsIdx >= 0 && parts[skillsIdx + 1]) return parts[skillsIdx + 1];
  return null;
}

function readSchedulerTodayCount(zylosDir) {
  const dbFile = path.join(zylosDir, 'scheduler', 'scheduler.db');
  if (!fs.existsSync(dbFile)) return 0;
  try {
    const db = new Database(dbFile, { readonly: true });
    db.pragma('busy_timeout = 3000');
    const todayStart = Math.floor(new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime() / 1000);
    const row = db.prepare('SELECT COUNT(*) as count FROM task_history WHERE executed_at >= ?').get(todayStart);
    db.close();
    return row?.count || 0;
  } catch {
    return 0;
  }
}

function readSchedulerStatus(zylosDir) {
  const dbFile = path.join(zylosDir, 'scheduler', 'scheduler.db');
  if (!fs.existsSync(dbFile)) return null;
  try {
    const db = new Database(dbFile, { readonly: true });
    db.pragma('busy_timeout = 3000');
    const counts = db.prepare(
      `SELECT status, COUNT(*) as count FROM tasks WHERE status IN ('pending','paused','running') GROUP BY status`
    ).all();
    const upcoming = db.prepare(
      `SELECT id, name, next_run_at FROM tasks WHERE status = 'pending' ORDER BY next_run_at ASC LIMIT 5`
    ).all();
    db.close();
    const result = { pending: 0, paused: 0, running: 0 };
    for (const r of counts) result[r.status] = r.count;
    result.upcoming = upcoming.map((t) => ({ id: t.id, name: t.name, run_at: new Date(t.next_run_at * 1000).toISOString() }));
    return result;
  } catch {
    return null;
  }
}

function dayBoundariesUTC(tz, daysBack = 0) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(now)) {
    if (type !== 'literal') p[type] = parseInt(value);
  }
  const asIfUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offsetMs = asIfUTC - now.getTime();
  const midnightUTC = Date.UTC(p.year, p.month - 1, p.day) - offsetMs;
  const since = new Date(midnightUTC - daysBack * 86400000);
  return { since: since.toISOString(), until: now.toISOString() };
}

function periodBounds(period, tz, stateEngine) {
  const now = new Date().toISOString();
  if (period === 'session') {
    const sessionId = stateEngine.getCurrentSessionId();
    return sessionId ? { sessionId, until: now } : null;
  }
  if (period === 'today') return dayBoundariesUTC(tz);
  if (period === '7d') return dayBoundariesUTC(tz, 7);
  if (period === '30d') return dayBoundariesUTC(tz, 30);
  return undefined;
}

function latestMetricRow(metricName, source) {
  const rows = store.queryMetrics({
    name: metricName,
    since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    until: new Date().toISOString()
  }).filter(r => !source || r.source === source);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

function handleApi(req, res, pathname, url) {
  if (pathname === '/api/health') {
    const sourceHealth = stateEngine.getSourceHealth();
    sendJson(res, 200, {
      ok: true,
      service: 'zylos-dashboard',
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      phase: 'phase2a',
      source: sourceHealth
    });
    return true;
  }

  if (pathname === '/api/state') {
    const stateData = stateEngine.getState();
    stateData.runtime_info = buildRuntimeInfo();
    const zylosCfg = loadZylosConfig(config.zylosDir);
    const runtime = zylosCfg.runtime || 'claude';
    const thresholdKey = runtime === 'codex' ? 'codex_new_session_threshold' : 'new_session_threshold';
    stateData.new_session_threshold = parseInt(zylosCfg[thresholdKey], 10) || (runtime === 'codex' ? 75 : 70);
    sendJson(res, 200, stateData);
    return true;
  }

  if (pathname === '/api/timeline') {
    const since = url.searchParams.get('since') || undefined;
    const until = url.searchParams.get('until') || undefined;
    const types = url.searchParams.get('types')?.split(',').filter(Boolean) || undefined;
    const sessionId = url.searchParams.get('session_id') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const order = url.searchParams.get('order') === 'desc' ? 'desc' : 'asc';
    const events = store.queryEvents({ since, until, types, sessionId, limit, offset, order });
    sendJson(res, 200, { events, count: events.length });
    return true;
  }

  if (pathname === '/api/system') {
    const pm2Data = pm2Collector.getLatestPM2Data();
    const sysData = systemCollector.getLatestSystemData();
    const pm2State = store.getAllPm2State?.() || [];
    const systemSummary = sysData ? null : latestMetricRow('system_summary', 'system');
    const scheduler = readSchedulerStatus(config.zylosDir);
    sendJson(res, 200, buildSystemPayload({ pm2Data, sysData, pm2State, systemSummary, scheduler }));
    return true;
  }

  if (pathname.startsWith('/api/metrics/history/')) {
    const metricName = pathname.slice('/api/metrics/history/'.length);
    if (!metricName) {
      sendJson(res, 400, { error: 'missing metric name' });
      return true;
    }
    const since = url.searchParams.get('since') || new Date(Date.now() - 6 * 3600_000).toISOString();
    const until = url.searchParams.get('until') || new Date().toISOString();
    const rows = store.queryMetrics({ name: metricName, since, until });
    const points = rows.map(r => ({
      timestamp: r.timestamp,
      value: r.metric_value,
      source: r.source,
      confidence: r.confidence,
      dimensions: r.dimensions
    }));
    sendJson(res, 200, { metric: metricName, since, until, points, count: points.length });
    return true;
  }

  if (pathname === '/api/metrics/aggregate') {
    const metric = url.searchParams.get('metric');
    const period = url.searchParams.get('period') || 'session';
    const tz = url.searchParams.get('tz') || process.env.TZ || 'UTC';
    if (!metric || !['cost', 'cache', 'tokens'].includes(metric)) {
      sendJson(res, 400, { error: 'metric must be "cost", "cache", or "tokens"' });
      return true;
    }
    let bounds = periodBounds(period, tz, stateEngine);
    if (bounds === undefined) { sendJson(res, 400, { error: `invalid period: ${period}` }); return true; }
    const resolved = resolveAggregateValue(store, metric, bounds, { runtime: activeRuntime, period });
    const value = resolved.value;
    bounds = resolved.bounds;
    if (bounds === null) {
      sendJson(res, 200, { metric, period, value: null, since: null, until: null, sessionId: null });
      return true;
    }
    sendJson(res, 200, { metric, period, value, since: bounds.since, until: bounds.until, sessionId: bounds.sessionId || null });
    return true;
  }

  if (pathname === '/api/metrics/series') {
    const metric = url.searchParams.get('metric');
    const since = url.searchParams.get('since');
    const until = url.searchParams.get('until') || new Date().toISOString();
    const bucket = parseInt(url.searchParams.get('bucket') || '3600', 10);
    if (!metric || !['cost', 'cache', 'tokens', 'messages', 'projects'].includes(metric)) {
      sendJson(res, 400, { error: 'metric must be "cost", "cache", "tokens", "messages", or "projects"' });
      return true;
    }
    if (metric === 'projects') {
      const s = since || new Date(Date.now() - 7 * 86400_000).toISOString();
      const result = store.getProjectDistribution({ since: s, until });
      sendJson(res, 200, { metric, since: s, until, items: result.items, totalTokens: result.totalTokens, totalCost: result.totalCost });
      return true;
    }
    if (!since) { sendJson(res, 400, { error: 'since is required' }); return true; }
    let points, total;
    if (metric === 'messages') {
      const result = c4Reader.getMessageSeries({ since, until, bucketSeconds: bucket });
      sendJson(res, 200, { metric, since, until, bucket, points: result.points, total: result.total });
      return true;
    }
    if (metric === 'cost') { points = store.aggregateCostSeries({ since, until, bucketSeconds: bucket }); total = store.aggregateCost({ since, until }); }
    else if (metric === 'cache') { points = store.aggregateCacheRateSeries({ since, until, bucketSeconds: bucket }); total = store.aggregateCacheRate({ since, until }); }
    else { points = store.aggregateTokenSeries({ since, until, bucketSeconds: bucket }); total = store.aggregateTokens({ since, until }); }
    sendJson(res, 200, { metric, since, until, bucket, points, total });
    return true;
  }

  if (pathname.startsWith('/api/metrics/')) {
    const metricName = pathname.slice('/api/metrics/'.length);
    if (!metricName) {
      sendJson(res, 400, { error: 'missing metric name' });
      return true;
    }
    const result = metricResolver.resolve(metricName);
    sendJson(res, 200, result);
    return true;
  }

  if (pathname === '/api/summary') {
    const today = new Date().toISOString().slice(0, 10);
    const todayStart = `${today}T00:00:00.000Z`;
    const events = store.queryEvents({ since: todayStart, types: ['post_tool_use'], limit: 10000 });
    const toolCalls = events.length;
    const stopEvents = store.queryEvents({ since: todayStart, types: ['stop'], limit: 10000 });
    const sessions = stopEvents.length;

    const projectBreakdown = {};
    for (const e of events) {
      const fp = extractFilePath(e.summary);
      const project = extractProject(fp);
      if (project) projectBreakdown[project] = (projectBreakdown[project] || 0) + 1;
    }
    const topProject = Object.entries(projectBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    const c4Stats = c4Reader.getTodayStats();
    const messagesProcessed = c4Stats ? c4Stats.total_in + c4Stats.total_out : 0;

    sendJson(res, 200, {
      date: today,
      tool_calls: toolCalls,
      sessions,
      top_project: topProject,
      project_breakdown: projectBreakdown,
      messages_processed: messagesProcessed
    });
    return true;
  }

  if (pathname === '/api/communication') {
    const stats = c4Reader.getTodayStats();
    const pending = c4Reader.getPendingQueue();
    const lastOutbound = c4Reader.getLastOutbound();
    const avgResponse = c4Reader.getAvgResponseTime();

    sendJson(res, 200, {
      channels: stats?.channels || {},
      total_in: stats?.total_in || 0,
      total_out: stats?.total_out || 0,
      pending_depth: pending.depth,
      pending_oldest_age_s: pending.oldest_age_s,
      last_outbound: lastOutbound,
      avg_response_s: avgResponse
    });
    return true;
  }

  if (pathname === '/api/actions/meta') {
    const zylosConfig = loadZylosConfig(config.zylosDir);
    zylosConfig.zylosDir = config.zylosDir;
    const runtimeMeta = activeRuntime === 'codex'
      ? buildRuntimeInfo()
      : statuslineCollector?.getRuntimeInfo();
    const meta = getActionsMeta(zylosConfig, runtimeMeta);
    meta.zylos_version = zylosVersion;
    meta.runtime_cli = activeRuntime === 'codex' ? 'codex' : 'claude';
    meta.cc_version = activeRuntime === 'codex'
      ? codexInstalledVersion || null
      : ccInstalledVersion || runtimeMeta?.cc_version || null;
    sendJson(res, 200, meta);
    return true;
  }

  if (pathname === '/api/stream') {
    const apiToken = req._apiToken;
    const validator = apiToken ? () => !!validateApiSession(apiToken) : null;
    sse.addClient(res, validator);
    return true;
  }

  return false;
}


function builtInModelsForRuntime(runtime) {
  return Object.keys(DEFAULT_RUNTIME_MODEL_PRICES[runtime === 'codex' ? 'codex' : 'claude'] || {});
}

function builtInServiceTierModelsForRuntime(runtime, serviceTier) {
  const rt = runtime === 'codex' ? 'codex' : 'claude';
  return Object.keys(DEFAULT_RUNTIME_SERVICE_TIER_MODEL_PRICES[rt]?.[serviceTier] || {});
}

function supportsFastMode(runtime) {
  return runtime === 'claude' || runtime === 'codex';
}

function settingsPayload(runtime) {
  const priceRuntime = runtime === 'codex' ? 'codex' : 'claude';
  const fastModeAvailable = supportsFastMode(priceRuntime);
  const fastModeMultiplier = priceRuntime === 'claude' ? fastModeMultiplierForRuntime(config, priceRuntime) : null;
  return {
    runtime: priceRuntime,
    builtInModels: builtInModelsForRuntime(priceRuntime),
    builtInPriorityModels: builtInServiceTierModelsForRuntime(priceRuntime, 'priority'),
    modelPrices: modelPricesForRuntime(config, priceRuntime),
    priorityModelPrices: priceRuntime === 'codex' ? modelPricesForRuntime(config, priceRuntime, 'priority') : null,
    runtimeModelPrices: config.runtimeModelPrices,
    runtimeServiceTierModelPrices: config.runtimeServiceTierModelPrices,
    fastMode: {
      available: fastModeAvailable,
      mode: priceRuntime === 'codex' ? 'service_tier' : 'multiplier',
      serviceTier: priceRuntime === 'codex' ? 'priority' : null,
      multiplier: fastModeMultiplier
    },
    fastModeMultiplier
  };
}

function validateModelPrices(modelPrices, runtime, requiredModels = builtInModelsForRuntime(runtime)) {
  const errors = [];
  if (typeof modelPrices !== 'object' || modelPrices === null || Array.isArray(modelPrices)) {
    errors.push('modelPrices must be an object');
    return errors;
  }
  for (const builtIn of requiredModels) {
    if (!(builtIn in modelPrices)) {
      errors.push(`Cannot remove built-in model: ${builtIn}`);
    }
  }
  for (const [prefix, prices] of Object.entries(modelPrices)) {
    if (!prefix || typeof prefix !== 'string') {
      errors.push('Model prefix must be a non-empty string');
      continue;
    }
    for (const field of ['input', 'output', 'cacheRead', 'cacheCreation']) {
      const v = prices?.[field];
      if (v == null || typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        errors.push(`${prefix}.${field} must be a finite number >= 0`);
      }
    }
  }
  return errors;
}

async function handleSettingsUpdate(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 16 * 1024);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message });
    return;
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: 'Request body must be a JSON object' });
    return;
  }

  const errors = [];
  const priceRuntime = activeRuntime === 'codex' ? 'codex' : 'claude';

  if (body.modelPrices !== undefined) {
    errors.push(...validateModelPrices(body.modelPrices, priceRuntime));
  }

  if (body.priorityModelPrices !== undefined) {
    if (priceRuntime !== 'codex') {
      errors.push(`priorityModelPrices is not supported for ${priceRuntime} runtime`);
    } else {
      const priorityBuiltIns = builtInServiceTierModelsForRuntime(priceRuntime, 'priority');
      errors.push(...validateModelPrices(body.priorityModelPrices, priceRuntime, priorityBuiltIns));
    }
  }

  if (body.fastModeMultiplier !== undefined) {
    const fm = body.fastModeMultiplier;
    if (priceRuntime !== 'claude') {
      errors.push(`fastModeMultiplier is not supported for ${priceRuntime} runtime`);
    } else if (typeof fm !== 'number' || !Number.isFinite(fm) || fm <= 0) {
      errors.push('fastModeMultiplier must be a finite number > 0');
    }
  }

  const allowedKeys = ['modelPrices', 'priorityModelPrices', 'fastModeMultiplier'];
  const unknownKeys = Object.keys(body).filter(k => !allowedKeys.includes(k));
  if (unknownKeys.length > 0) {
    errors.push(`Unknown keys not allowed: ${unknownKeys.join(', ')}`);
  }

  if (errors.length > 0) {
    sendJson(res, 400, { error: errors.join('; ') });
    return;
  }

  try {
    let existing = {};
    try {
      if (fs.existsSync(config.configPath)) {
        existing = JSON.parse(fs.readFileSync(config.configPath, 'utf8'));
      }
    } catch { /* start fresh if corrupt */ }

    if (body.modelPrices !== undefined) {
      existing.runtimeModelPrices = {
        ...(existing.runtimeModelPrices || {}),
        [priceRuntime]: body.modelPrices
      };
      if (priceRuntime === 'claude') existing.modelPrices = body.modelPrices;
    }
    if (body.fastModeMultiplier !== undefined) {
      existing.runtimeFastModeMultipliers = {
        ...(existing.runtimeFastModeMultipliers || {}),
        [priceRuntime]: body.fastModeMultiplier
      };
      if (priceRuntime === 'claude') existing.fastModeMultiplier = body.fastModeMultiplier;
    }
    if (body.priorityModelPrices !== undefined) {
      existing.runtimeServiceTierModelPrices = {
        ...(existing.runtimeServiceTierModelPrices || {}),
        codex: {
          ...(existing.runtimeServiceTierModelPrices?.codex || {}),
          priority: body.priorityModelPrices
        }
      };
    }

    const tmpPath = config.configPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmpPath, config.configPath);

    if (body.modelPrices !== undefined) {
      config.runtimeModelPrices = {
        ...(config.runtimeModelPrices || {}),
        [priceRuntime]: body.modelPrices
      };
      config.modelPrices = config.runtimeModelPrices.claude;
    }
    if (body.fastModeMultiplier !== undefined) {
      config.runtimeFastModeMultipliers = {
        ...(config.runtimeFastModeMultipliers || {}),
        [priceRuntime]: body.fastModeMultiplier
      };
      config.fastModeMultiplier = config.runtimeFastModeMultipliers.claude;
    }
    if (body.priorityModelPrices !== undefined) {
      config.runtimeServiceTierModelPrices = {
        ...(config.runtimeServiceTierModelPrices || {}),
        codex: {
          ...(config.runtimeServiceTierModelPrices?.codex || {}),
          priority: body.priorityModelPrices
        }
      };
    }

    sendJson(res, 200, {
      ok: true,
      ...settingsPayload(priceRuntime)
    });
  } catch (err) {
    sendJson(res, 500, { error: `Failed to save settings: ${err.message}` });
  }
}

async function handleStatuslineIngest(req, res) {
  const remote = req.socket.remoteAddress;
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message });
    return;
  }

  const metrics = body.metrics || [];
  let written = 0;
  for (const m of metrics) {
    if (!m.metric_name || m.metric_value == null) continue;
    try {
      store.insertMetric({
        timestamp: m.timestamp || new Date().toISOString(),
        runtime: m.runtime || activeRuntime,
        session_id: m.session_id || null,
        metric_name: m.metric_name,
        metric_value: Number(m.metric_value),
        dimensions: m.dimensions || null,
        source: m.source || 'statusline',
        confidence: m.confidence || 'actual'
      });
      written++;
    } catch {
      // skip invalid metric
    }
  }

  if (written > 0) {
    const now = new Date().toISOString();
    store.upsertSourceHealth('statusline', 'collector_liveness', 'healthy', { last_success: now });
    store.upsertSourceHealth('statusline', 'runtime_progress', 'healthy', {
      last_success: now,
      metrics_written: written,
      runtime: 'claude'
    });

    for (const m of metrics) {
      if (m.metric_name && m.metric_value != null) {
        sse.broadcast('metric_update', {
          metric_name: m.metric_name,
          value: Number(m.metric_value),
          dimensions: m.dimensions || null,
          source: m.source || 'statusline',
          confidence: m.confidence || 'actual',
          timestamp: m.timestamp || now
        });
      }
    }
  }

  sendJson(res, 200, { ok: true, written });
}

export function createServer() {
  const rootDir = publicDir();

  function renderIndex(req, res) {
    const browserBase = browserBaseFromRequest(req);
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8')
      .replaceAll('__BASE_PATH__', browserBase)
      .replaceAll('__ASSET_ROOT__', browserBase ? `${browserBase}/_assets` : '/_assets');
    sendHtml(res, 200, html);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    let pathname = url.pathname;

    // Ingest endpoints: local-only, reject proxied requests
    if ((pathname === '/api/ingest' || pathname === '/api/ingest/statusline') && req.method === 'POST') {
      const remote = req.socket.remoteAddress;
      const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      const isProxied = !!req.headers['x-forwarded-prefix'];
      if (!isLoopback || isProxied) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      if (pathname === '/api/ingest') {
        await ingestHandler.handle(req, res);
      } else {
        await handleStatuslineIngest(req, res);
      }
      return;
    }

    if (pathname === '/api/auth/token' && req.method === 'POST') {
      const bearer = req.headers.authorization;
      if (!bearer || !bearer.startsWith('Bearer zylos_ak_')) {
        sendJson(res, 401, { error: 'invalid_api_key' });
        return;
      }
      const result = exchangeApiKeyForToken(bearer.slice(7));
      if (!result) {
        sendJson(res, 401, { error: 'invalid_api_key' });
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    if (await auth.handle(req, res, url)) {
      return;
    }

    if (pathname === '/api/stream') {
      handleApi(req, res, pathname, url);
      return;
    }

    if (pathname.startsWith('/api/actions/') && req.method === 'POST') {
      const action = pathname.slice('/api/actions/'.length);
      if (action && action !== 'meta') {
        let body = {};
        try { body = await readJsonBody(req, 4096); } catch { /* no body is ok for some actions */ }
        const zylosConfig = loadZylosConfig(config.zylosDir);
        zylosConfig.zylosDir = config.zylosDir;
        const result = await handleAction(action, body, zylosConfig);
        if (result.ok && (action === 'upgrade-cc' || action === 'upgrade-zylos')) {
          refreshInstalledVersions();
        }
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }
    }

    if (pathname === '/api/settings' && req.method === 'GET') {
      const priceRuntime = activeRuntime === 'codex' ? 'codex' : 'claude';
      sendJson(res, 200, settingsPayload(priceRuntime));
      return;
    }

    if (pathname === '/api/settings' && req.method === 'PUT') {
      await handleSettingsUpdate(req, res);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'method not allowed');
      return;
    }

    if (pathname.startsWith('/api/')) {
      const handled = handleApi(req, res, pathname, url);
      if (!handled && !res.headersSent) sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      renderIndex(req, res);
      return;
    }

    if (!serveStatic(req, res, rootDir)) {
      sendText(res, 404, 'not found');
    }
  });
}

const isMain = (
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) ||
  (process.env.pm_exec_path && import.meta.url === pathToFileURL(process.env.pm_exec_path).href)
);

if (isMain && process.argv.includes('--smoke')) {
  await startupSequence();
  console.log(JSON.stringify({
    ok: true,
    port: config.port,
    host: config.host,
    phase: 'phase2a',
    db: dbPath,
    spoolDrained: spoolResult.processed,
    state: stateEngine.getState().state
  }, null, 2));
  store.close();
} else if (isMain) {
  await startupSequence();

  const server = createServer();
  server.on('error', (err) => {
    console.error(`[dashboard] Failed to start: ${err.message}`);
    process.exit(1);
  });

  // Start periodic collectors
  pm2Collector.start(60_000);
  systemCollector.start(30_000);
  if (statuslineCollector) statuslineCollector.start();
  if (conversationCollector) conversationCollector.start(5_000);
  if (codexRolloutCollector) codexRolloutCollector.start(5_000);

  // Start snapshot timer
  stateEngine.startSnapshotTimer();

  // Start periodic spool drain (live mode with state engine)
  spoolDrainer.startPeriodicDrain(stateEngine, 30_000);

  // Retention cleanup timer (hourly)
  let lastVacuumDate = null;
  const retentionTimer = setInterval(() => {
    try {
      const result = runMetricMaintenance(store, { lastVacuumDate });
      lastVacuumDate = result.lastVacuumDate;
      if (result.vacuum?.skipped) {
        process.stderr.write(`[retention] Skipped VACUUM: ${result.vacuum.reason} (${result.vacuum.sizeBytes} > ${result.vacuum.maxBytes})\n`);
      }
    } catch (err) {
      process.stderr.write(`[retention] Error: ${err.message}\n`);
    }
  }, 60 * 60 * 1000);
  retentionTimer.unref();

  server.listen(config.port, config.host, () => {
    console.log(`zylos-dashboard listening on http://${config.host}:${config.port}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      pm2Collector.stop();
      systemCollector.stop();
      if (statuslineCollector) statuslineCollector.stop();
      if (conversationCollector) conversationCollector.stop();
      stateEngine.stopSnapshotTimer();
      spoolDrainer.stopPeriodicDrain();
      sse.closeAll();
      server.close(() => {
        c4Reader.close();
        store.close();
        process.exit(0);
      });
    });
  }
}
