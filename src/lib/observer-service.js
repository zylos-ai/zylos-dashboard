import { observerFrameDocument } from './observer-frame.js';
import { readJsonBody, sendJson } from './http.js';
import { ObserverManagerError } from './observer-manager.js';
import { ObserverUpstream } from './observer-upstream.js';
import {
  acceptObserverWebSocket,
  rejectObserverUpgrade,
} from './observer-websocket.js';

const OBSERVER_PROTOCOL = 'zylos-observer-v1';
const LEASE_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const REVALIDATE_MS = 10_000;
const MAX_STARTUP_DISPLAY_BYTES = 2 * 1024 * 1024;

class ObserverHttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function firstHeader(value) {
  return String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();
}

function expectedOrigin(req) {
  const forwarded = firstHeader(req.headers['x-forwarded-proto']).toLowerCase();
  const protocol = forwarded === 'https' || forwarded === 'http'
    ? forwarded
    : req.socket.encrypted ? 'https' : 'http';
  const host = firstHeader(req.headers.host);
  return host ? `${protocol}://${host}` : null;
}

function hasExactOrigin(req) {
  const expected = expectedOrigin(req);
  if (!expected || typeof req.headers.origin !== 'string') return false;
  try { return new URL(req.headers.origin).origin === expected && req.headers.origin === expected; } catch { return false; }
}

function parseProtocol(value) {
  const parts = String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2 || parts[0] !== OBSERVER_PROTOCOL || !parts[1].startsWith('lease.')) return null;
  const leaseId = parts[1].slice('lease.'.length);
  return LEASE_ID_PATTERN.test(leaseId) ? leaseId : null;
}

function errorStatus(error) {
  if (error instanceof ObserverHttpError) return error.status;
  switch (error?.code) {
    case 'auth_required': return 401;
    case 'admin_required':
    case 'insufficient_scope':
    case 'origin_required': return 403;
    case 'lease_not_found':
    case 'lease_expired':
    case 'lease_mismatch':
    case 'observer_disabled':
    case 'artifact_unavailable':
    case 'not_installed': return 404;
    case 'capacity_exceeded': return 429;
    case 'lease_in_use': return 409;
    case 'invalid_preset':
    case 'target_mismatch': return 400;
    case 'unsupported_platform': return 501;
    default: return 503;
  }
}

function publicError(error) {
  const code = error?.code || 'observer_unavailable';
  return { status: errorStatus(error), code };
}

function publicStatus(status) {
  const { binaryPath: _binaryPath, ...installation } = status || {};
  return installation;
}

export class ObserverService {
  constructor({ coordinator, containment, manager, authGate, upstreamFactory, ensureCoordinatorOwnership }) {
    this.coordinator = coordinator;
    this.containment = containment;
    this.manager = manager;
    this.authGate = authGate;
    this.upstreamFactory = upstreamFactory || ((options) => new ObserverUpstream(options));
    this.ensureCoordinatorOwnership = ensureCoordinatorOwnership || (async () => {});
    this.streams = new Set();
    this._startup = null;
    this.startupError = null;
    this.containment.on?.('failure', (error) => {
      this._closeAllStreams(1011, 'child_failure');
      this.manager.handleContainmentFailure(error).catch(() => {});
    });
  }

  startup() {
    if (this._startup) return this._startup;
    this._startup = (async () => {
      await this.containment.reconcilePersisted();
      const status = await this.coordinator.reconcileStartup();
      this.startupError = null;
      return status;
    })().catch((error) => {
      this.startupError = error;
      return null;
    });
    return this._startup;
  }

  _authContext(req, { requireOrigin = false } = {}) {
    if (!this.authGate.enabled) throw new ObserverHttpError(401, 'auth_required');
    const context = req._authContext || this.authGate.resolveAuthContext(req);
    if (!context) throw new ObserverHttpError(401, 'unauthorized');
    if (context.scope !== 'admin') throw new ObserverHttpError(403, 'insufficient_scope');
    if (requireOrigin && context.kind === 'cookie' && !hasExactOrigin(req)) {
      throw new ObserverHttpError(403, 'origin_required');
    }
    return context;
  }

  async _ready({ allowRecovery = false } = {}) {
    await this.startup();
    if (this.startupError && !allowRecovery) throw this.startupError;
  }

  _closeLeaseStreams(leaseId, code = 1000, reason = 'lease_closed') {
    for (const stream of [...this.streams]) {
      if (stream.leaseId === leaseId) this._closeStream(stream, code, reason);
    }
  }

  _closeAllStreams(code = 1001, reason = 'observer_stopped') {
    for (const stream of [...this.streams]) this._closeStream(stream, code, reason);
  }

  _closeStream(stream, code, reason) {
    if (stream.closed) return;
    stream.closed = true;
    clearInterval(stream.timer);
    stream.startupDisplay = [];
    stream.startupDisplayBytes = 0;
    stream.upstream?.close();
    if (stream.downstream) stream.downstream.close(code, reason);
    else stream.socket?.destroy();
    this.streams.delete(stream);
    try { this.manager.releaseLease(stream.leaseId, stream.context); } catch {}
  }

  async handle(req, res, url) {
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/observer') && !pathname.startsWith('/observer/')) return false;
    try {
      if (pathname === '/observer/frame') {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new ObserverHttpError(405, 'method_not_allowed');
        await this._ready();
        const context = this._authContext(req);
        const leaseId = firstHeader(req.headers['x-observer-lease']);
        if (!LEASE_ID_PATTERN.test(leaseId)) throw new ObserverHttpError(404, 'lease_not_found');
        const lease = this.manager.validateLease(leaseId, context);
        const body = req.method === 'HEAD' ? '' : observerFrameDocument();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self'",
          'X-Frame-Options': 'SAMEORIGIN',
          'X-Observer-Preset': lease.preset,
        });
        res.end(body);
        return true;
      }

      const context = this._authContext(req, { requireOrigin: req.method !== 'GET' && req.method !== 'HEAD' });
      if (pathname === '/api/observer/status' && req.method === 'GET') {
        await this._ready({ allowRecovery: true });
        const status = await this.coordinator.status();
        sendJson(res, 200, { ...publicStatus(status), startupError: this.startupError?.code || null });
        return true;
      }
      if (pathname === '/api/observer/install' && req.method === 'POST') {
        await this._ready();
        await this.ensureCoordinatorOwnership();
        sendJson(res, 200, publicStatus(await this.coordinator.installAndEnable()));
        return true;
      }
      if (pathname === '/api/observer/enable' && req.method === 'POST') {
        await this._ready();
        await this.ensureCoordinatorOwnership();
        sendJson(res, 200, publicStatus(await this.coordinator.enable()));
        return true;
      }
      if (pathname === '/api/observer/disable' && req.method === 'POST') {
        await this._ready({ allowRecovery: true });
        await this.ensureCoordinatorOwnership();
        this._closeAllStreams(1001, 'disabled');
        const result = await this.manager.invalidateAndDisable();
        this.startupError = null;
        sendJson(res, 200, publicStatus(result));
        return true;
      }
      if (pathname === '/api/observer/install' && req.method === 'DELETE') {
        await this._ready({ allowRecovery: true });
        await this.ensureCoordinatorOwnership();
        this._closeAllStreams(1001, 'uninstalled');
        const result = await this.manager.invalidateAndUninstall();
        this.startupError = null;
        sendJson(res, 200, publicStatus(result));
        return true;
      }
      if (pathname === '/api/observer/leases' && req.method === 'POST') {
        await this._ready();
        await this.ensureCoordinatorOwnership();
        sendJson(res, 201, await this.manager.createLease(context));
        return true;
      }
      const leaseRoute = pathname.match(/^\/api\/observer\/leases\/([A-Za-z0-9_-]{32})\/(renew|release|preset)$/);
      if (leaseRoute && req.method === 'POST') {
        await this._ready();
        const [, leaseId, action] = leaseRoute;
        if (action === 'renew') {
          sendJson(res, 200, this.manager.renewLease(leaseId, context));
          return true;
        }
        if (action === 'release') {
          try { this.manager.releaseLease(leaseId, context); } catch (error) {
            if (!(error instanceof ObserverManagerError) || error.code !== 'lease_not_found') throw error;
          }
          this._closeLeaseStreams(leaseId, 1000, 'released');
          sendJson(res, 200, { released: true });
          return true;
        }
        const body = await readJsonBody(req, 4 * 1024);
        const lease = this.manager.setPreset(leaseId, context, body?.preset);
        for (const stream of this.streams) {
          stream.upstream.resize(lease.preset);
          stream.downstream?.sendText(JSON.stringify({ type: 'preset', preset: lease.preset }));
        }
        sendJson(res, 200, lease);
        return true;
      }
      throw new ObserverHttpError(404, 'not_found');
    } catch (error) {
      const result = publicError(error);
      sendJson(res, result.status, { error: result.code });
      return true;
    }
  }

  async handleUpgrade(req, socket, head) {
    let upstream;
    let stream;
    let aborted = false;
    let awaitingAdmission = true;
    const closeAbortedDownstream = () => {
      aborted = true;
      if (stream) this._closeStream(stream, 1001, 'client_aborted');
      else socket.destroy();
    };
    // Own socket failures before any rejection can write a response.
    socket.on('error', closeAbortedDownstream);
    socket.on('data', () => { if (awaitingAdmission) closeAbortedDownstream(); });
    socket.on('end', closeAbortedDownstream);
    socket.on('close', closeAbortedDownstream);
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      if (url.pathname !== '/observer/stream' || url.search) {
        rejectObserverUpgrade(socket, 404, 'not_found');
        return true;
      }
      await this._ready();
      if (aborted || socket.destroyed || socket.writableEnded) return true;
      const context = this._authContext(req, { requireOrigin: true });
      const leaseId = parseProtocol(req.headers['sec-websocket-protocol']);
      if (!leaseId) throw new ObserverHttpError(404, 'invalid_protocol');
      const lease = this.manager.validateLease(leaseId, context);
      if ([...this.streams].some((current) => current.leaseId === leaseId && !current.closed)) {
        throw Object.assign(new Error('Observer lease already has a stream'), { code: 'lease_in_use' });
      }
      upstream = this.upstreamFactory({ active: this.containment.active });
      stream = {
        leaseId, context, lease, upstream, socket,
        downstream: null, timer: null, closed: false, awaitingPong: false,
        startupDisplay: [], startupDisplayBytes: 0,
      };
      this.streams.add(stream);
      stream.timer = setInterval(() => {
        try {
          if (stream.downstream && stream.awaitingPong) throw new Error('pong_timeout');
          const refreshed = this.authGate.revalidateAuthContext(stream.context);
          if (!refreshed) throw new Error('auth_expired');
          stream.context = refreshed;
          stream.lease = this.manager.validateLease(stream.leaseId, refreshed);
          if (stream.downstream) {
            stream.awaitingPong = true;
            stream.downstream.ping();
          }
        } catch {
          this._closeStream(stream, 1008, 'lease_expired');
        }
      }, REVALIDATE_MS);
      stream.timer.unref?.();
      await upstream.connect({
        preset: lease.preset,
        onDisplay: (payload) => {
          if (stream.closed) return;
          if (stream.downstream) {
            stream.downstream.sendBinary(payload);
            return;
          }
          const buffered = Buffer.from(payload);
          stream.startupDisplayBytes += buffered.length;
          if (stream.startupDisplayBytes > MAX_STARTUP_DISPLAY_BYTES) {
            this._closeStream(stream, 1009, 'startup_display_overflow');
            return;
          }
          stream.startupDisplay.push(buffered);
        },
        onClose: () => this._closeStream(stream, 1011, 'upstream_closed'),
      });
      if (stream.closed || socket.destroyed || socket.writableEnded) {
        this._closeStream(stream, 1001, 'client_aborted');
        throw new Error('Observer downstream closed during handshake');
      }
      const refreshed = this.authGate.revalidateAuthContext(stream.context);
      if (!refreshed) throw new ObserverHttpError(401, 'unauthorized');
      stream.context = refreshed;
      stream.lease = this.manager.validateLease(stream.leaseId, refreshed);
      awaitingAdmission = false;
      stream.downstream = acceptObserverWebSocket(req, socket, head, OBSERVER_PROTOCOL);
      stream.downstream.on('message', () => this._closeStream(stream, 1008, 'input_forbidden'));
      stream.downstream.on('error', () => this._closeStream(stream, 1011, 'stream_error'));
      stream.downstream.on('close', () => this._closeStream(stream, 1000, 'client_closed'));
      stream.downstream.on('pong', () => { stream.awaitingPong = false; });
      stream.downstream.sendText(JSON.stringify({ type: 'preset', preset: stream.lease.preset }));
      for (const payload of stream.startupDisplay) {
        stream.downstream.sendBinary(payload);
        if (stream.downstream.closed || stream.downstream.closing) break;
      }
      stream.startupDisplay = [];
      stream.startupDisplayBytes = 0;
      stream.downstream.activate();
      return true;
    } catch (error) {
      upstream?.close();
      if (stream?.downstream) this._closeStream(stream, 1011, 'observer_unavailable');
      else if (stream?.closed) this.streams.delete(stream);
      else {
        clearInterval(stream?.timer);
        if (stream) this.streams.delete(stream);
        const result = publicError(error);
        if (!socket.destroyed && !socket.writableEnded) rejectObserverUpgrade(socket, result.status, result.code);
      }
      return true;
    }
  }

  async shutdown(reason = 'dashboard_shutdown') {
    this._closeAllStreams(1001, reason);
    return this.manager.shutdown(reason);
  }

  async preUninstall() {
    await this._ready({ allowRecovery: true });
    this._closeAllStreams(1001, 'component_uninstall');
    const result = await this.manager.invalidateAndUninstall();
    this.startupError = null;
    return result;
  }
}

export const OBSERVER_WEBSOCKET_PROTOCOL = OBSERVER_PROTOCOL;
