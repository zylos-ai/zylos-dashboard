#!/usr/bin/env node
import http from 'node:http';
import { ensureDataDirs, loadConfig, publicDir } from './lib/config.js';
import { sendJson, sendText, serveStatic } from './lib/http.js';

const startedAt = new Date();
const config = loadConfig();
ensureDataDirs(config);

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

function handleApi(req, res, pathname) {
  if (pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'zylos-dashboard',
      version: '0.1.0',
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      phase: 'scaffold'
    });
    return true;
  }

  if (pathname === '/api/config') {
    sendJson(res, 200, safeConfig(config));
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
      if (!handleApi(req, res, pathname)) {
        sendJson(res, 404, { error: 'not_found' });
      }
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
