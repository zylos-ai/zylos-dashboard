import crypto from 'node:crypto';
import fs from 'node:fs';
import { browserBaseFromRequest, browserPath, browserRoot, isPathWithinBase } from './browser-base.js';
import { sendHtml, sendJson, sendText } from './http.js';

const SCRYPT_KEYLEN = 64;
const COOKIE_NAME = '__Host-zylos_dashboard_session';
const SESSION_ABSOLUTE_MS = 86_400_000;
const SESSION_IDLE_MS = 3_600_000;
const REMEMBER_ABSOLUTE_MS = 30 * 86_400_000;
const REMEMBER_IDLE_MS = 7 * 86_400_000;
const CLEANUP_INTERVAL_MS = 300_000;
const MAX_FAILURES = 5;
const WINDOW_MS = 60_000;
const LOCKOUT_MS = 600_000;
const GLOBAL_MAX_PER_MIN = 30;
const MAX_LOGIN_BODY_BYTES = 4096;
const API_SESSION_TTL_MS = 86_400_000;
const API_KEY_PREFIX = 'zylos_ak_';
const API_SESSION_PREFIX = 'zylos_st_';

let _store = null;

const failedAttempts = new Map();
let globalFailures = { count: 0, resetAt: Date.now() + 60_000 };

export function hashPassword(plaintext) {
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(plaintext, stored) {
  try {
    if (!stored || !stored.startsWith('scrypt:')) return false;
    const parts = stored.split(':');
    if (parts.length !== 3) return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (expected.length !== SCRYPT_KEYLEN) return false;
    const actual = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function isPlaintext(password) {
  return typeof password === 'string' && password.length > 0 && !password.startsWith('scrypt:');
}

export function migratePasswordIfNeeded(config) {
  if (!isPlaintext(config.auth?.password)) return;
  const hashed = hashPassword(config.auth.password);
  try {
    const existing = fs.existsSync(config.configPath)
      ? JSON.parse(fs.readFileSync(config.configPath, 'utf8'))
      : {};
    existing.auth = { ...(existing.auth || {}), password: hashed };
    fs.writeFileSync(config.configPath, `${JSON.stringify(existing, null, 2)}\n`);
    config.auth.password = hashed;
    console.log('[dashboard] Auth: migrated plaintext password to scrypt hash');
  } catch (err) {
    console.error(`[dashboard] Auth: failed to migrate password: ${err.message}`);
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function createSession(remember = false) {
  const token = crypto.randomBytes(64).toString('hex');
  const now = Date.now();
  if (_store) {
    _store.insertSession(sha256(token), now, remember);
  }
  return token;
}

function validateSession(token) {
  if (!token) return false;
  if (!_store) return false;
  const hash = sha256(token);
  const session = _store.getSession(hash);
  if (!session) return false;
  const now = Date.now();
  const absoluteMs = session.remember ? REMEMBER_ABSOLUTE_MS : SESSION_ABSOLUTE_MS;
  const idleMs = session.remember ? REMEMBER_IDLE_MS : SESSION_IDLE_MS;
  if (now - session.created_at > absoluteMs ||
      now - session.last_activity_at > idleMs) {
    _store.deleteSession(hash);
    return false;
  }
  _store.touchSession(hash, now);
  return true;
}

function destroySession(token) {
  if (token && _store) _store.deleteSession(sha256(token));
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=');
  }
  return cookies;
}

function getSessionCookie(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] || null;
}

function setSessionCookie(res, token, remember = false) {
  const maxAge = remember ? 30 * 86400 : 86400;
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
}

function getClientIp(req) {
  const remoteIp = req.socket.remoteAddress || '';
  if (remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1') {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
  }
  return remoteIp;
}

function isLockedOut(ip) {
  const record = failedAttempts.get(ip);
  if (!record) return false;
  const now = Date.now();
  if (record.count >= MAX_FAILURES) {
    if (now - record.firstFailAt < LOCKOUT_MS) return true;
    failedAttempts.delete(ip);
    return false;
  }
  if (now - record.firstFailAt > WINDOW_MS) {
    failedAttempts.delete(ip);
    return false;
  }
  return false;
}

function isGlobalLimited() {
  const now = Date.now();
  if (now > globalFailures.resetAt) {
    globalFailures = { count: 0, resetAt: now + 60_000 };
  }
  return globalFailures.count >= GLOBAL_MAX_PER_MIN;
}

function recordFailure(ip) {
  const now = Date.now();
  const record = failedAttempts.get(ip);
  if (!record || now - record.firstFailAt > WINDOW_MS) {
    failedAttempts.set(ip, { count: 1, firstFailAt: now });
  } else {
    record.count += 1;
  }
  if (now > globalFailures.resetAt) {
    globalFailures = { count: 1, resetAt: now + 60_000 };
  } else {
    globalFailures.count += 1;
  }
}

function clearFailures(ip) {
  failedAttempts.delete(ip);
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function loginPageHtml(base, error = '', next = '') {
  const safeNext = next && isPathWithinBase(next, base) ? next : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Login - Zylos Dashboard</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; background: #f7faf9; color: #101827; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
      .login-shell { width: 100%; max-width: 380px; padding: 1rem; }
      .login-panel { background: rgba(255,255,255,0.88); backdrop-filter: blur(12px); border-radius: 12px; padding: 2.5rem 2rem; box-shadow: 0 18px 42px rgba(15,23,42,0.08), inset 0 1px 0 rgba(255,255,255,0.9); border: 1px solid rgba(15,118,110,0.1); }
      .eyebrow { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.15em; color: #0d9488; margin: 0 0 0.25rem; font-weight: 600; }
      h1 { margin: 0 0 1.5rem; font-size: 1.5rem; font-weight: 600; color: #101827; }
      .login-error { color: #dc2626; font-size: 0.85rem; margin: 0 0 1rem; }
      .login-label { display: block; font-size: 0.85rem; color: #526170; margin-bottom: 0.5rem; }
      .login-input { width: 100%; padding: 0.6rem 0.75rem; border: 1px solid rgba(15,118,110,0.16); border-radius: 8px; background: #fff; color: #101827; font-size: 1rem; box-sizing: border-box; transition: border-color 200ms, box-shadow 200ms; outline: none; }
      .login-input:focus { border-color: #0d9488; box-shadow: 0 0 0 3px rgba(13,148,136,0.12); }
      .login-remember { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.75rem; font-size: 0.85rem; color: #526170; cursor: pointer; }
      .login-remember input { accent-color: #0d9488; cursor: pointer; }
      .login-button { width: 100%; padding: 0.7rem; margin-top: 1rem; border: none; border-radius: 8px; background: #0d9488; color: #fff; font-size: 1rem; font-weight: 500; cursor: pointer; transition: background 200ms; }
      .login-button:hover { background: #0f766e; }
    </style>
  </head>
  <body>
    <main class="login-shell">
      <form class="login-panel" method="POST" action="${browserPath(base, 'login')}">
        <p class="eyebrow">Zylos</p>
        <h1>Dashboard</h1>
        ${error ? `<p class="login-error">${htmlEscape(error)}</p>` : ''}
        <label class="login-label" for="password">Password</label>
        <input class="login-input" id="password" name="password" type="password" autocomplete="current-password" autofocus required>
        ${safeNext ? `<input type="hidden" name="next" value="${htmlEscape(safeNext)}">` : ''}
        <label class="login-remember"><input type="checkbox" name="remember"> Remember me</label>
        <button class="login-button" type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>`;
}

function parseFormBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > MAX_LOGIN_BODY_BYTES) {
        reject(new Error('request_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(body))));
    req.on('error', reject);
  });
}

function redirect(res, location) {
  res.writeHead(302, {
    location,
    'cache-control': 'no-store'
  });
  res.end();
}

function extractHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function verifyLogoutCsrf(req) {
  const expectedHost = req.headers.host;
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if (origin) return extractHost(origin) === expectedHost;
  if (referer) return extractHost(referer) === expectedHost;
  return false;
}

function nextTarget(req, base) {
  const raw = req.url || '/';
  const target = raw === '/' ? browserRoot(base) : browserPath(base, raw);
  return isPathWithinBase(target, base) ? target : browserRoot(base);
}

function needsAdminApiAccess(pathname, method) {
  if (pathname.startsWith('/api/actions')) return true;
  if (pathname === '/api/settings' && method === 'PUT') return true;
  const proxiedWrite = pathname.match(/^\/fleet\/[^/]+\/api\/(.+)$/);
  if (!proxiedWrite) return false;
  const remotePath = `/api/${proxiedWrite[1]}`;
  return method === 'POST' && remotePath.startsWith('/api/actions/') ||
    method === 'PUT' && remotePath === '/api/settings';
}

export function generateApiKey() {
  return API_KEY_PREFIX + crypto.randomBytes(32).toString('hex');
}

function generateSessionToken() {
  return API_SESSION_PREFIX + crypto.randomBytes(32).toString('hex');
}

export function hashApiKey(key) {
  return hashPassword(key);
}

export function exchangeApiKeyForToken(apiKey) {
  if (!_store || !apiKey) return null;
  const candidates = _store.listActiveApiKeys();
  const row = candidates.find(k => verifyPassword(apiKey, k.key_hash));
  if (!row) return null;
  _store.touchApiKey(row.id);
  const token = generateSessionToken();
  const now = Date.now();
  const expiresAt = now + API_SESSION_TTL_MS;
  _store.insertApiSession({
    tokenHash: sha256(token),
    apiKeyId: row.id,
    scope: row.scope,
    createdAt: now,
    expiresAt,
  });
  return { token, expires_at: new Date(expiresAt).toISOString(), ttl_seconds: API_SESSION_TTL_MS / 1000, scope: row.scope };
}

export function validateApiSession(token) {
  if (!_store || !token) return null;
  const hash = sha256(token);
  const session = _store.getApiSession(hash);
  if (!session) return null;
  if (session.key_revoked_at) return null;
  if (Date.now() > session.expires_at) return null;
  return { scope: session.scope };
}

function getBearerToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

export class AuthGate {
  constructor(config, store) {
    this.config = config;
    _store = store || null;
    migratePasswordIfNeeded(this.config);
    if (_store) {
      this._cleanupTimer = setInterval(() => {
        const now = Date.now();
        _store.cleanupSessions(now - REMEMBER_ABSOLUTE_MS, now - REMEMBER_IDLE_MS);
        _store.cleanupExpiredApiSessions();
      }, CLEANUP_INTERVAL_MS);
      this._cleanupTimer.unref?.();
    }
  }

  get enabled() {
    return Boolean(this.config.auth?.enabled) && Boolean(this.config.auth?.password);
  }

  getApiAuth(req) {
    const bearer = getBearerToken(req);
    if (!bearer) return null;
    if (bearer.startsWith(API_SESSION_PREFIX)) {
      const result = validateApiSession(bearer);
      if (result) req._apiToken = bearer;
      return result;
    }
    return null;
  }

  isAuthenticated(req) {
    if (!this.enabled) return true;
    if (validateSession(getSessionCookie(req))) return true;
    return !!this.getApiAuth(req);
  }

  async handle(req, res, url) {
    const base = browserBaseFromRequest(req);
    const pathname = url.pathname;

    if (pathname === '/api/health' || (req.method === 'GET' && pathname.startsWith('/_assets/'))) {
      return false;
    }

    if (pathname === '/login') {
      return this.handleLogin(req, res, base, url);
    }

    if (pathname === '/logout') {
      return this.handleLogout(req, res, base);
    }

    if (!this.enabled) return false;

    if (validateSession(getSessionCookie(req))) {
      res.setHeader('Cache-Control', 'no-store');
      return false;
    }

    const apiAuth = this.getApiAuth(req);
    if (apiAuth && (pathname.startsWith('/api/') || pathname.startsWith('/fleet/'))) {
      const needsAdmin = needsAdminApiAccess(pathname, req.method);
      if (needsAdmin && apiAuth.scope !== 'admin') {
        sendJson(res, 403, { error: 'insufficient_scope', required: 'admin' });
        return true;
      }
      req._apiScope = apiAuth.scope;
      return false;
    }

    if (pathname === '/api/auth/token' && req.method === 'POST') {
      return false;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 401, { error: 'unauthorized' });
      return true;
    }

    const safeNext = nextTarget(req, base);
    redirect(res, `${browserPath(base, 'login')}?next=${encodeURIComponent(safeNext)}`);
    return true;
  }

  async handleLogin(req, res, base, url) {
    if (!this.enabled) {
      redirect(res, browserRoot(base));
      return true;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (validateSession(getSessionCookie(req))) {
        redirect(res, browserRoot(base));
        return true;
      }
      sendHtml(res, 200, loginPageHtml(base, '', url.searchParams.get('next') || ''));
      return true;
    }

    if (req.method !== 'POST') {
      sendText(res, 405, 'method not allowed');
      return true;
    }

    const ip = getClientIp(req);
    let body;
    try {
      body = await parseFormBody(req);
    } catch {
      sendText(res, 400, 'bad request');
      return true;
    }

    if (isLockedOut(ip) || isGlobalLimited()) {
      sendHtml(res, 429, loginPageHtml(base, 'Too many attempts. Try again later.', body.next));
      return true;
    }

    if (!verifyPassword(body.password || '', this.config.auth.password)) {
      recordFailure(ip);
      sendHtml(res, 200, loginPageHtml(base, 'Incorrect password.', body.next));
      return true;
    }

    clearFailures(ip);
    const remember = body.remember === 'on';
    setSessionCookie(res, createSession(remember), remember);
    const redirectTo = body.next && isPathWithinBase(body.next, base) ? body.next : browserRoot(base);
    redirect(res, redirectTo);
    return true;
  }

  async handleLogout(req, res, base) {
    if (req.method !== 'POST') {
      sendText(res, 405, 'method not allowed');
      return true;
    }
    if (this.enabled && !validateSession(getSessionCookie(req))) {
      redirect(res, browserPath(base, 'login'));
      return true;
    }
    if (!verifyLogoutCsrf(req)) {
      sendText(res, 403, 'forbidden');
      return true;
    }
    destroySession(getSessionCookie(req));
    clearSessionCookie(res);
    redirect(res, browserPath(base, 'login'));
    return true;
  }
}
