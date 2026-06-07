import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { browserPath } from './browser-base.js';
import { sendHtml, sendJson, sendText, serveStatic } from './http.js';

function decodeAgentName(value) {
  try {
    return decodeURIComponent(value || '');
  } catch {
    return '';
  }
}

function stripHopByHop(headers) {
  const result = {};
  const blocked = new Set([
    'connection',
    'content-length',
    'host',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'authorization',
    'cookie',
    'set-cookie'
  ]);
  for (const [key, value] of Object.entries(headers || {})) {
    if (!blocked.has(key.toLowerCase()) && value !== undefined) result[key] = value;
  }
  return result;
}

function requestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
    req.on('error', reject);
  });
}

function remoteUrl(agent, remotePath, search = '') {
  const base = String(agent.base_url || '').replace(/\/+$/, '');
  const cleanPath = String(remotePath || '').replace(/^\/+/, '');
  return `${base}/${cleanPath}${search || ''}`;
}

export class FleetProxy {
  constructor({ config, rootDir, poller, fetch }) {
    this.config = config;
    this.rootDir = rootDir;
    this.poller = poller;
    this.fetch = fetch || globalThis.fetch;
  }

  async handle(req, res, url) {
    const match = url.pathname.match(/^\/fleet\/([^/]+)(\/.*)?$/);
    if (!match) return false;
    const agentName = decodeAgentName(match[1]);
    const suffix = match[2] || '/';
    const agent = this.config.fleet?.agents?.find(a => a.name === agentName);
    if (!agent) {
      sendJson(res, 404, { error: 'unknown_agent' });
      return true;
    }

    if (suffix === '/api/stream' || suffix.startsWith('/api/')) {
      await this.proxyApi(req, res, agent, suffix, url.search);
      return true;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'method not allowed');
      return true;
    }

    if (suffix === '/' || suffix === '/index.html') {
      const prefix = `/fleet/${encodeURIComponent(agent.name)}`;
      const html = fs.readFileSync(path.join(this.rootDir, 'index.html'), 'utf8')
        .replaceAll('__BASE_PATH__', prefix)
        .replaceAll('__ASSET_ROOT__', browserPath(prefix, '_assets'));
      sendHtml(res, 200, html);
      return true;
    }

    const originalUrl = req.url;
    try {
      req.url = suffix;
      if (!serveStatic(req, res, this.rootDir)) {
        sendText(res, 404, 'not found');
      }
    } finally {
      req.url = originalUrl;
    }
    return true;
  }

  async proxyApi(req, res, agent, suffix, search) {
    if (req.method === 'POST' && suffix.startsWith('/api/actions/')) {
      sendJson(res, 403, { error: 'read_only_proxy' });
      return;
    }

    let token;
    try {
      token = await this.poller.getSessionToken(agent.name);
    } catch (err) {
      sendJson(res, err.status || 502, { error: err.reason || err.message || 'proxy_auth_failed' });
      return;
    }

    let body = null;
    if (!['GET', 'HEAD'].includes(req.method)) body = await requestBody(req);

    let remoteResp;
    try {
      remoteResp = await this._fetchUpstream(req, agent, suffix, search, token, body);
      if (remoteResp.status === 401) {
        token = await this.poller.getSessionToken(agent.name, { force: true });
        remoteResp = await this._fetchUpstream(req, agent, suffix, search, token, body);
      }
    } catch {
      sendJson(res, 502, { error: 'upstream_unreachable' });
      return;
    }

    const responseHeaders = stripHopByHop(Object.fromEntries(remoteResp.headers.entries()));
    responseHeaders['cache-control'] = 'no-store';
    res.writeHead(remoteResp.status, responseHeaders);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    if (remoteResp.body) {
      Readable.fromWeb(remoteResp.body).pipe(res);
    } else {
      res.end();
    }
  }

  _fetchUpstream(req, agent, suffix, search, token, body) {
    const headers = stripHopByHop(req.headers);
    headers.authorization = `Bearer ${token}`;
    return this.fetch(remoteUrl(agent, suffix, search), {
      method: req.method,
      headers,
      body
    });
  }
}
