#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AuthGate } from './lib/auth.js';
import { browserBaseFromRequest } from './lib/browser-base.js';
import { ensureDataDirs, loadConfig, publicDir } from './lib/config.js';
import { readJsonBody, sendHtml, sendJson, sendText, serveStatic } from './lib/http.js';
import { Store } from './lib/store.js';
import { Sanitizer } from './lib/sanitizer.js';
import { IngestHandler } from './lib/ingest-handler.js';
import { SpoolDrainer } from './lib/spool-drainer.js';
import { PM2Collector } from './lib/collectors/pm2-collector.js';
import { SystemCollector } from './lib/collectors/system-collector.js';
import { OTelCollector } from './lib/collectors/otel-collector.js';
import { StatuslineCollector } from './lib/collectors/statusline-collector.js';
import { StateEngine } from './lib/state-engine.js';
import { MetricResolver } from './lib/metric-resolver.js';
import { SseHub } from './lib/sse.js';
import { C4Reader } from './lib/c4-reader.js';
import Database from 'better-sqlite3';

const startedAt = new Date();
const config = loadConfig();
ensureDataDirs(config);

// 1-2. Store
const dbPath = path.join(config.dataDir, 'dashboard.db');
const store = new Store(dbPath);

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
const otelCollector = new OTelCollector(store, config);
const statuslineCollector = new StatuslineCollector(store, config);

const collectors = { pm2: pm2Collector, system: systemCollector, otel: otelCollector, statusline: statuslineCollector };

// SSE hub
const sse = new SseHub(15_000);

// 7. State engine
const stateEngine = new StateEngine(store, collectors, config, {
  onStateChange: (state) => sse.broadcast('state_change', state)
});

// Wire collector updates to state engine
pm2Collector._onUpdate = (data) => stateEngine.onPM2Update(data);
systemCollector._onUpdate = (data) => stateEngine.onSystemUpdate(data);

// 8. Metric resolver
const metricResolver = new MetricResolver(store, collectors, config);

// 9b. C4 reader (read-only access to comm-bridge DB)
const c4Reader = new C4Reader(config.zylosDir);

// 9. Ingest handler (with state engine reference)
const ingestHandler = new IngestHandler(store, sanitizer, stateEngine, config);

async function startupSequence() {
  // Initial collector runs
  try { await pm2Collector.collect(); } catch (err) {
    process.stderr.write(`[startup] PM2 collector initial run failed: ${err.message}\n`);
  }
  try { await systemCollector.collect(); } catch (err) {
    process.stderr.write(`[startup] System collector initial run failed: ${err.message}\n`);
  }
  try { await otelCollector.collect(); } catch (err) {
    process.stderr.write(`[startup] OTel collector initial run failed: ${err.message}\n`);
  }
  try { await statuslineCollector.collect(); } catch (err) {
    process.stderr.write(`[startup] StatusLine collector initial run failed: ${err.message}\n`);
  }

  // State engine initialize (snapshot restore + replay)
  await stateEngine.initialize();
}

function extractProject(filePath) {
  if (!filePath) return null;
  const parts = filePath.replace(/^\/+/, '').split('/');
  const wsIdx = parts.indexOf('workspace');
  if (wsIdx >= 0 && parts[wsIdx + 1]) return parts[wsIdx + 1];
  const srcIdx = parts.indexOf('src');
  if (srcIdx >= 2) return parts[srcIdx - 1];
  const skillsIdx = parts.indexOf('skills');
  if (skillsIdx >= 0 && parts[skillsIdx + 1]) return parts[skillsIdx + 1];
  if (parts.length >= 2) return parts[parts.length - 2];
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
    sendJson(res, 200, stateEngine.getState());
    return true;
  }

  if (pathname === '/api/timeline') {
    const since = url.searchParams.get('since') || undefined;
    const until = url.searchParams.get('until') || undefined;
    const types = url.searchParams.get('types')?.split(',').filter(Boolean) || undefined;
    const sessionId = url.searchParams.get('session_id') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const events = store.queryEvents({ since, until, types, sessionId, limit, offset });
    sendJson(res, 200, { events, count: events.length });
    return true;
  }

  if (pathname === '/api/system') {
    const pm2Data = pm2Collector.getLatestPM2Data();
    const sysData = systemCollector.getLatestSystemData();
    sendJson(res, 200, {
      pm2: pm2Data ? pm2Data.processes : null,
      system: sysData || null,
      collected_at: {
        pm2: pm2Data ? new Date(pm2Data.collectedAt).toISOString() : null,
        system: sysData ? new Date(sysData.collectedAt).toISOString() : null
      }
    });
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
    const activeTimeMs = events.reduce((sum, e) => sum + (e.duration_ms || 0), 0);

    const projectBreakdown = {};
    for (const e of events) {
      const fp = e.metadata?.file_path || '';
      const project = extractProject(fp);
      if (project) projectBreakdown[project] = (projectBreakdown[project] || 0) + 1;
    }
    const topProject = Object.entries(projectBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    const c4Stats = c4Reader.getTodayStats();
    const messagesProcessed = c4Stats ? c4Stats.total_in + c4Stats.total_out : 0;
    const schedulerTasks = readSchedulerTodayCount(config.zylosDir);

    sendJson(res, 200, {
      date: today,
      tool_calls: toolCalls,
      active_time_ms: activeTimeMs,
      active_time_h: Math.round(activeTimeMs / 36000) / 100,
      top_project: topProject,
      project_breakdown: projectBreakdown,
      messages_processed: messagesProcessed,
      scheduler_tasks: schedulerTasks
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

  if (pathname === '/api/stream') {
    sse.addClient(res);
    return true;
  }

  return false;
}

async function handleOtlpIngest(req, res, pathname) {
  let body;
  try {
    body = await readJsonBody(req, 512 * 1024);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message });
    return;
  }

  let processed = 0;
  if (pathname.includes('/v1/traces')) {
    processed = otelCollector.ingestTraces(body.resourceSpans);
  } else if (pathname.includes('/v1/logs')) {
    processed = otelCollector.ingestLogs(body.resourceLogs);
  } else if (pathname.includes('/v1/metrics')) {
    processed = otelCollector.ingestMetrics(body.resourceMetrics);
  }

  sendJson(res, 200, { partialSuccess: {} });
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
        runtime: m.runtime || process.env.ZYLOS_RUNTIME || 'claude',
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
    store.upsertSourceHealth('statusline', 'runtime_progress', 'healthy', { last_success: now, metrics_written: written });

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

    // /api/ingest must be checked before any base-path stripping or auth
    if (pathname === '/api/ingest' && req.method === 'POST') {
      await ingestHandler.handle(req, res);
      return;
    }

    if (pathname === '/api/ingest/statusline' && req.method === 'POST') {
      await handleStatuslineIngest(req, res);
      return;
    }

    // OTLP HTTP/JSON receiver (localhost only)
    if (pathname.startsWith('/v1/') && req.method === 'POST') {
      const remote = req.socket.remoteAddress;
      if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      await handleOtlpIngest(req, res, pathname);
      return;
    }

    // Reject ingest under base-path prefix
    const prefix = req.headers['x-forwarded-prefix'];
    if (prefix && pathname.startsWith(prefix + '/api/ingest')) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (await auth.handle(req, res, url)) {
      return;
    }

    if (pathname === '/api/stream') {
      handleApi(req, res, pathname, url);
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
    console.error(`zylos-dashboard failed to start: ${err.message}`);
    process.exitCode = 1;
  });

  // Start periodic collectors
  pm2Collector.start(15_000);
  systemCollector.start(30_000);
  otelCollector.start(10_000);
  statuslineCollector.start();

  // Start snapshot timer
  stateEngine.startSnapshotTimer();

  // Start periodic spool drain (live mode with state engine)
  spoolDrainer.startPeriodicDrain(stateEngine, 30_000);

  // Retention cleanup timer (hourly)
  const retentionTimer = setInterval(() => {
    try {
      store.deleteEventsOlderThan(30);
      store.deleteMetricsOlderThan(90);
      store.deleteFactsOlderThan(365);
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
      otelCollector.stop();
      statuslineCollector.stop();
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
