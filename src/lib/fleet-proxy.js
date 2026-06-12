import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { browserPath, browserBaseFromRequest } from './browser-base.js';
import { sendHtml, sendJson, sendText, serveStatic } from './http.js';
import { validateMemoryQueryPath } from './memory-browser.js';

const SECRET_PATTERN = /\b(?:Bearer\s+zylos_st_[A-Za-z0-9_-]+|zylos_st_[A-Za-z0-9_-]+|zylos_ak_[A-Za-z0-9_-]+|read_api_key|read_session_token)\b/i;
const STREAM_GUARD_TAIL_CHARS = 128;
const MAX_WRITE_BODY_BYTES = 1024 * 1024;
const MAX_MEMORY_WRITE_BODY_BYTES = 2 * 1024 * 1024 + 64 * 1024;

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
    'set-cookie',
    // undici fetch decompresses upstream bodies; forwarding the upstream
    // content-encoding (e.g. gzip added by Cloudflare in front of a producer)
    // would make browsers decode plain bytes and fail (#255). Stripping
    // accept-encoding from forwarded requests keeps undici's own negotiation
    // (and therefore its auto-decompression) deterministic.
    'accept-encoding',
    'content-encoding'
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

function isAllowedProxyWrite(method, suffix) {
  return method === 'POST' && /^\/api\/actions\/[^/]+$/.test(suffix) ||
    method === 'PUT' && (suffix === '/api/settings' || suffix === '/api/memory/file');
}

function isLocalOnlyEndpoint(suffix) {
  return suffix === '/api/fleet/agents' ||
    suffix.startsWith('/api/fleet/agents/') ||
    suffix === '/api/agent/name' ||
    suffix === '/api/keys' ||
    suffix.startsWith('/api/keys/');
}

function normalizeProxySuffix(suffix) {
  const value = String(suffix || '/');
  if (/%2f/i.test(value)) return null;
  try {
    const decoded = decodeURIComponent(value);
    const normalized = path.posix.normalize(decoded);
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  } catch {
    return null;
  }
}

function validateMemoryProxyQuery(suffix, search) {
  if (suffix !== '/api/memory/file' && suffix !== '/api/memory/git') return true;
  try {
    const params = new URLSearchParams(search || '');
    validateMemoryQueryPath(params.get('path') || '');
    return true;
  } catch {
    return false;
  }
}

async function readBodyBuffer(req, maxBytes = MAX_WRITE_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const err = new Error('request_body_too_large');
      err.status = 413;
      throw err;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
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

    const normalizedSuffix = normalizeProxySuffix(suffix);
    if (!normalizedSuffix || isLocalOnlyEndpoint(normalizedSuffix)) {
      sendJson(res, 403, { error: 'local_endpoint_not_proxyable' });
      return true;
    }

    if (!validateMemoryProxyQuery(normalizedSuffix, url.search)) {
      sendJson(res, 400, { error: 'invalid_memory_path' });
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

    if (suffix === '/' || suffix === '/index.html' || suffix === '/trends' || suffix === '/memory') {
      // Include the reverse-proxy base path (X-Forwarded-Prefix, e.g. /dashboard)
      // so the browser requests assets/API under it. Caddy forwards everything
      // under /dashboard/* and strips the prefix before this handler runs, so
      // internal routing is unaffected; locally (no prefix) browserBase is '' and
      // the paths fall back to /fleet/<name>. See issue #159.
      const browserBase = browserBaseFromRequest(req);
      const prefix = browserPath(browserBase, `fleet/${encodeURIComponent(agent.name)}`);
      let access = 'read';
      try {
        await this.poller.getSessionToken(agent.name);
        access = this.poller.getAgentAccess?.(agent.name) === 'admin' ? 'admin' : 'read';
      } catch {
        access = 'read';
      }
      const html = fs.readFileSync(path.join(this.rootDir, 'index.html'), 'utf8')
        .replaceAll('__BASE_PATH__', prefix)
        .replaceAll('__ASSET_ROOT__', browserPath(prefix, '_assets'))
        .replaceAll('__REMOTE_ACCESS__', access);
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
    if (!['GET', 'HEAD'].includes(req.method) && !isAllowedProxyWrite(req.method, suffix)) {
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

    // Owns the upstream fetch lifetime: aborting it is the only reliable way
    // to release the upstream connection when a relay is torn down (#257).
    const upstreamControl = new AbortController();
    let remoteResp;
    try {
      remoteResp = await this._fetchUpstream(req, agent, suffix, search, token, upstreamControl.signal);
      if (remoteResp.status === 401) {
        token = await this.poller.getSessionToken(agent.name, { force: true });
        remoteResp = await this._fetchUpstream(req, agent, suffix, search, token, upstreamControl.signal);
      }
    } catch (err) {
      if (err.status === 413) sendJson(res, 413, { error: 'request_body_too_large' });
      else sendJson(res, 502, { error: 'upstream_unreachable' });
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
      // pipe() does not propagate errors: an unhandled 'error' on any stream in
      // this chain would crash the whole process (#257). A failed relay must
      // only tear down its own connection; the browser's EventSource reconnects.
      const abortRelay = (err) => {
        if (err && err.name !== 'AbortError') {
          process.stderr.write(`[fleet-proxy] SSE relay from ${agent.name} aborted: ${err.message || err}\n`);
        }
        upstreamControl.abort();
        upstream.destroy();
        guarded.destroy();
        if (!res.destroyed && !res.writableEnded) res.end();
      };
      upstream.on('error', abortRelay);
      guarded.on('error', abortRelay);
      res.on('error', () => { /* client write failures surface via 'close' */ });
      res.on('close', () => abortRelay());
      upstream.pipe(guarded).pipe(res);
    } else {
      let buffer;
      try {
        buffer = Buffer.from(await remoteResp.arrayBuffer());
      } catch (err) {
        process.stderr.write(`[fleet-proxy] upstream body read from ${agent.name} ${suffix} failed: ${err.message || err}\n`);
        sendJson(res, 502, { error: 'upstream_body_error' });
        return;
      }
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

  async _fetchUpstream(req, agent, suffix, search, token, signal) {
    const headers = stripHopByHop(req.headers);
    headers.authorization = `Bearer ${token}`;
    const options = {
      method: req.method,
      headers,
      signal
    };
    if (!['GET', 'HEAD'].includes(req.method)) {
      const maxBodyBytes = req.method === 'PUT' && suffix === '/api/memory/file'
        ? MAX_MEMORY_WRITE_BODY_BYTES
        : MAX_WRITE_BODY_BYTES;
      if (!req._fleetProxyBody) req._fleetProxyBody = await readBodyBuffer(req, maxBodyBytes);
      options.body = req._fleetProxyBody;
    }
    return this.fetch(remoteUrl(agent, suffix, search), options);
  }
}
