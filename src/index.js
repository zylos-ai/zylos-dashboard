#!/usr/bin/env node
import http from 'node:http';
import { ensureDataDirs, loadConfig, publicDir } from './lib/config.js';
import { sendJson, sendText, serveStatic } from './lib/http.js';
import { Resolver } from './lib/resolver.js';
import { SseHub } from './lib/sse.js';

const startedAt = new Date();
const config = loadConfig();
ensureDataDirs(config);
const resolver = new Resolver(config);
const sse = new SseHub(config.refreshMs || 5000);

function safeConfig(configValue) {
  return {
    port: configValue.port,
    host: configValue.host,
    theme: configValue.theme,
    refreshMs: configValue.refreshMs,
    zylosDir: configValue.zylosDir,
    dataDir: configValue.dataDir,
    authEnabled: Boolean(configValue.auth?.enabled),
    configError: configValue.configError
  };
}

async function handleApi(req, res, pathname, url) {
  if (pathname === '/api/health') {
    const adapters = await resolver.adapterHealth();
    sendJson(res, 200, {
      ok: true,
      service: 'zylos-dashboard',
      version: '0.1.0',
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      phase: 'phase1',
      adapters
    });
    return true;
  }

  if (pathname === '/api/config') {
    sendJson(res, 200, safeConfig(config));
    return true;
  }

  if (pathname === '/api/summary') {
    sendJson(res, 200, await resolver.summary(url.searchParams.get('runtime') || 'auto'));
    return true;
  }

  if (pathname === '/api/metrics') {
    sendJson(res, 200, {
      catalog: resolver.metricCatalog(),
      metrics: await resolver.resolveAll(url.searchParams.get('runtime') || 'auto')
    });
    return true;
  }

  if (pathname.startsWith('/api/metrics/')) {
    const metric = pathname.slice('/api/metrics/'.length);
    sendJson(res, 200, await resolver.resolve(metric, url.searchParams.get('runtime') || 'auto'));
    return true;
  }

  if (pathname === '/api/adapters') {
    sendJson(res, 200, { adapters: await resolver.adapterHealth() });
    return true;
  }

  if (pathname === '/api/events') {
    sse.add(res, () => resolver.summary(url.searchParams.get('runtime') || 'auto'));
    return true;
  }

  return false;
}

export function createServer() {
  const rootDir = publicDir();

  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'method not allowed');
      return;
    }

    if (pathname.startsWith('/api/')) {
      handleApi(req, res, pathname, url)
        .then((handled) => {
          if (!handled && !res.headersSent) sendJson(res, 404, { error: 'not_found' });
        })
        .catch((err) => {
          if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message: err.message });
        });
      return;
    }

    if (!serveStatic(req, res, rootDir)) {
      sendText(res, 404, 'not found');
    }
  });
}

if (process.argv.includes('--smoke')) {
  console.log(JSON.stringify({
    ok: true,
    config: safeConfig(config)
  }, null, 2));
} else {
  const server = createServer();
  server.on('error', (err) => {
    console.error(`zylos-dashboard failed to start: ${err.message}`);
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`zylos-dashboard listening on http://${config.host}:${config.port}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => {
        process.exit(0);
      });
    });
  }
}
