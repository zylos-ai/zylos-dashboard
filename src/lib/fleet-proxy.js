import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { browserPath, browserBaseFromRequest } from './browser-base.js';
import { sendHtml, sendJson, sendText, serveStatic } from './http.js';

const SECRET_PATTERN = /\b(?:Bearer\s+zylos_st_[A-Za-z0-9_-]+|zylos_st_[A-Za-z0-9_-]+|zylos_ak_[A-Za-z0-9_-]+|read_api_key|read_session_token)\b/i;
const STREAM_GUARD_TAIL_CHARS = 128;

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

function remoteUrl(agent, remotePath, search = '') {
  const base = String(agent.base_url || '').replace(/\/+$/, '');
  const cleanPath = String(remotePath || '').replace(/^\/+/, '');
  return `${base}/${cleanPath}${search || ''}`;
}

function containsSecret(value) {
  return SECRET_PATTERN.test(String(value || ''));
}

function isSseResponse(resp) {
  return /\btext\/event-stream\b/i.test(resp.headers.get('content-type') || '');
}

function createSecretGuard(token) {
  const tokenLiteral = String(token || '');
  return {
    minTailChars: Math.max(STREAM_GUARD_TAIL_CHARS, Math.max(0, tokenLiteral.length - 1)),
    contains(value) {
      const text = String(value || '');
      return (tokenLiteral && text.includes(tokenLiteral)) || containsSecret(text);
    }
  };
}

function headersContainSecret(headers, guard) {
  for (const [name, value] of Object.entries(headers || {})) {
    if (guard.contains(name)) return true;
    const values = Array.isArray(value) ? value : [value];
    if (values.some(v => guard.contains(v))) return true;
  }
  return false;
}

function guardedSseStream(guard, upstreamStream, onLeak) {
  let tail = '';
  let leaked = false;
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (leaked) {
        callback();
        return;
      }
      const text = chunk.toString('utf8');
      const combined = tail + text;
      if (guard.contains(combined)) {
        leaked = true;
        try { upstreamStream?.unpipe?.(this); } catch { /* upstream already closed */ }
        try { upstreamStream?.destroy?.(); } catch { /* upstream already closed */ }
        onLeak();
        this.push('event: proxy_error\ndata: {"error":"secret_leak_blocked"}\n\n');
        this.push(null);
        callback();
        return;
      }
      const tailChars = guard.minTailChars || STREAM_GUARD_TAIL_CHARS;
      if (combined.length <= tailChars) {
        tail = combined;
        callback();
        return;
      }
      const safeLength = combined.length - tailChars;
      this.push(combined.slice(0, safeLength));
      tail = combined.slice(safeLength);
      callback();
    },
    flush(callback) {
      if (!leaked && tail) this.push(tail);
      callback();
    }
  });
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
      // Include the reverse-proxy base path (X-Forwarded-Prefix, e.g. /dashboard)
      // so the browser requests assets/API under it. Caddy forwards everything
      // under /dashboard/* and strips the prefix before this handler runs, so
      // internal routing is unaffected; locally (no prefix) browserBase is '' and
      // the paths fall back to /fleet/<name>. See issue #159.
      const browserBase = browserBaseFromRequest(req);
      const prefix = browserPath(browserBase, `fleet/${encodeURIComponent(agent.name)}`);
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
    if (!['GET', 'HEAD'].includes(req.method)) {
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

    let remoteResp;
    try {
      remoteResp = await this._fetchUpstream(req, agent, suffix, search, token);
      if (remoteResp.status === 401) {
        token = await this.poller.getSessionToken(agent.name, { force: true });
        remoteResp = await this._fetchUpstream(req, agent, suffix, search, token);
      }
    } catch {
      sendJson(res, 502, { error: 'upstream_unreachable' });
      return;
    }

    const guard = createSecretGuard(token);
    if (req.method === 'HEAD') {
      const responseHeaders = stripHopByHop(Object.fromEntries(remoteResp.headers.entries()));
      responseHeaders['cache-control'] = 'no-store';
      if (headersContainSecret(responseHeaders, guard)) {
        process.stderr.write(`[fleet-proxy] blocked secret-bearing response headers from ${agent.name} ${suffix}\n`);
        sendJson(res, 502, { error: 'secret_leak_blocked' });
        return;
      }
      res.writeHead(remoteResp.status, responseHeaders);
      res.end();
      return;
    }
    if (!remoteResp.body) {
      const responseHeaders = stripHopByHop(Object.fromEntries(remoteResp.headers.entries()));
      responseHeaders['cache-control'] = 'no-store';
      if (headersContainSecret(responseHeaders, guard)) {
        process.stderr.write(`[fleet-proxy] blocked secret-bearing response headers from ${agent.name} ${suffix}\n`);
        sendJson(res, 502, { error: 'secret_leak_blocked' });
        return;
      }
      res.writeHead(remoteResp.status, responseHeaders);
      res.end();
      return;
    }
    if (isSseResponse(remoteResp)) {
      const responseHeaders = stripHopByHop(Object.fromEntries(remoteResp.headers.entries()));
      responseHeaders['cache-control'] = 'no-store';
      if (headersContainSecret(responseHeaders, guard)) {
        process.stderr.write(`[fleet-proxy] blocked secret-bearing SSE headers from ${agent.name} ${suffix}\n`);
        sendJson(res, 502, { error: 'secret_leak_blocked' });
        return;
      }
      res.writeHead(remoteResp.status, responseHeaders);
      const upstream = Readable.fromWeb(remoteResp.body);
      const guarded = guardedSseStream(guard, upstream, () => {
        process.stderr.write(`[fleet-proxy] blocked secret-bearing SSE response from ${agent.name}\n`);
      });
      upstream.pipe(guarded).pipe(res);
    } else {
      const buffer = Buffer.from(await remoteResp.arrayBuffer());
      const text = buffer.toString('utf8');
      if (guard.contains(text)) {
        process.stderr.write(`[fleet-proxy] blocked secret-bearing response from ${agent.name} ${suffix}\n`);
        sendJson(res, 502, { error: 'secret_leak_blocked' });
        return;
      }
      const responseHeaders = stripHopByHop(Object.fromEntries(remoteResp.headers.entries()));
      responseHeaders['cache-control'] = 'no-store';
      if (headersContainSecret(responseHeaders, guard)) {
        process.stderr.write(`[fleet-proxy] blocked secret-bearing response headers from ${agent.name} ${suffix}\n`);
        sendJson(res, 502, { error: 'secret_leak_blocked' });
        return;
      }
      res.writeHead(remoteResp.status, responseHeaders);
      res.end(buffer);
    }
  }

  _fetchUpstream(req, agent, suffix, search, token) {
    const headers = stripHopByHop(req.headers);
    headers.authorization = `Bearer ${token}`;
    return this.fetch(remoteUrl(agent, suffix, search), {
      method: req.method,
      headers
    });
  }
}
