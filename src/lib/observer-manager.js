import crypto from 'node:crypto';

const DEFAULT_MAX_VIEWERS = 4;
const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_IDLE_GRACE_MS = 5_000;
const DEFAULT_REVALIDATE_MS = 10_000;
const PRESETS = new Set(['standard', 'wide', 'large']);

export class ObserverManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ObserverManagerError';
    this.code = code;
  }
}

function samePrincipal(left, right) {
  return left?.kind === right?.kind && left?.principalId === right?.principalId &&
    left?.scope === 'admin' && right?.scope === 'admin';
}

export class ObserverManager {
  constructor({
    coordinator,
    containment,
    authGate,
    runtime,
    target = 'local',
    maxViewers = DEFAULT_MAX_VIEWERS,
    leaseTtlMs = DEFAULT_LEASE_TTL_MS,
    idleGraceMs = DEFAULT_IDLE_GRACE_MS,
    revalidateMs = DEFAULT_REVALIDATE_MS,
    defaultPreset = 'standard',
    now = () => Date.now(),
  }) {
    this.coordinator = coordinator;
    this.containment = containment;
    this.authGate = authGate;
    this.runtime = runtime;
    this.target = target;
    this.maxViewers = maxViewers;
    this.leaseTtlMs = leaseTtlMs;
    this.idleGraceMs = idleGraceMs;
    this.revalidateMs = revalidateMs;
    this.now = now;
    this.leases = new Map();
    this.generation = null;
    this.currentPreset = PRESETS.has(defaultPreset) ? defaultPreset : 'standard';
    this._starting = null;
    this._pendingLeases = 0;
    this._epoch = 0;
    this._idleTimer = null;
    this._idleStopping = null;
    this._revalidationTimer = null;
    this._runtimeError = null;
    this._shuttingDown = false;
    this._lifecycleTransitions = 0;
  }

  _requireAdmin(context) {
    if (!context || context.scope !== 'admin' || !['cookie', 'api'].includes(context.kind)) {
      throw new ObserverManagerError('admin_required', 'Observer requires a live administrator principal');
    }
  }

  async _ensureGeneration(context) {
    if (this._idleStopping) await this._idleStopping;
    if (this._shuttingDown || this._lifecycleTransitions > 0) {
      throw new ObserverManagerError('operation_obsolete', 'Observer lifecycle is changing');
    }
    if (this._runtimeError) throw new ObserverManagerError('teardown_failed', 'Observer cleanup requires administrator recovery');
    if (this.containment.active && this.generation !== null) return this.containment.active;
    if (this._starting) return this._starting;
    this._starting = this.coordinator.firstLease(context).then((active) => {
      this.generation = active.generation;
      this._startRevalidation();
      return active;
    }).finally(() => { this._starting = null; });
    return this._starting;
  }

  _startRevalidation() {
    if (this._revalidationTimer) return;
    this._revalidationTimer = setInterval(() => {
      this.revalidate().catch(() => {});
    }, this.revalidateMs);
    this._revalidationTimer.unref?.();
  }

  _stopRevalidation() {
    if (this._revalidationTimer) clearInterval(this._revalidationTimer);
    this._revalidationTimer = null;
  }

  _clearIdleTimer() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = null;
  }

  _scheduleIdleStop() {
    if (this.leases.size > 0 || this._pendingLeases > 0 || this._starting || this._shuttingDown ||
        this._lifecycleTransitions > 0 ||
        this._idleTimer || !this.containment.active) return;
    const expectedGeneration = this.generation;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (this.leases.size > 0 || this._pendingLeases > 0 || this._starting || this._shuttingDown ||
          this._lifecycleTransitions > 0 ||
          this.generation !== expectedGeneration) return;
      this._idleStopping = this.containment.stopGeneration({ reason: 'last_lease' }).then(() => {
        if (this.generation === expectedGeneration) this.generation = null;
        this._stopRevalidation();
      }).catch((error) => { this._runtimeError = error; }).finally(() => { this._idleStopping = null; });
    }, this.idleGraceMs);
    this._idleTimer.unref?.();
  }

  async createLease(context, { target = this.target } = {}) {
    this._requireAdmin(context);
    if (target !== this.target) throw new ObserverManagerError('target_mismatch', 'Observer target is not this producer');
    if (this._shuttingDown || this._lifecycleTransitions > 0) {
      throw new ObserverManagerError('operation_obsolete', 'Observer lifecycle is changing');
    }
    this._clearIdleTimer();
    const epoch = this._epoch;
    this._pendingLeases += 1;
    try {
      await this.revalidate();
      if (epoch !== this._epoch || this._shuttingDown || this._lifecycleTransitions > 0) {
        throw new ObserverManagerError('operation_obsolete', 'Observer lease start was superseded');
      }
      if (this.leases.size + this._pendingLeases > this.maxViewers) {
        throw new ObserverManagerError('capacity_exceeded', 'Observer viewer capacity reached');
      }
      const active = await this._ensureGeneration(context);
      if (epoch !== this._epoch || active !== this.containment.active || active.generation !== this.generation) {
        throw new ObserverManagerError('operation_obsolete', 'Observer lease start was superseded');
      }
      const id = crypto.randomBytes(24).toString('base64url');
      const createdAt = this.now();
      const lease = {
        id,
        principal: context,
        target,
        generation: active.generation,
        createdAt,
        expiresAt: createdAt + this.leaseTtlMs,
        preset: this.currentPreset,
      };
      this.leases.set(id, lease);
      return this.publicLease(lease);
    } finally {
      this._pendingLeases -= 1;
      this._scheduleIdleStop();
    }
  }

  publicLease(lease) {
    return {
      id: lease.id,
      expiresAt: lease.expiresAt,
      generation: lease.generation,
      preset: lease.preset,
      presets: [...PRESETS],
      resource: 'frame',
    };
  }

  validateLease(id, context, { target = this.target, renew = false } = {}) {
    this._requireAdmin(context);
    const lease = this.leases.get(id);
    if (!lease) throw new ObserverManagerError('lease_not_found', 'Observer lease was not found');
    if (lease.expiresAt <= this.now()) {
      this.leases.delete(id);
      this._scheduleIdleStop();
      throw new ObserverManagerError('lease_expired', 'Observer lease expired');
    }
    if (!samePrincipal(lease.principal, context) || lease.target !== target ||
        lease.generation !== this.generation || lease.generation !== this.containment.active?.generation) {
      throw new ObserverManagerError('lease_mismatch', 'Observer lease binding did not match');
    }
    lease.principal = context;
    if (renew) lease.expiresAt = this.now() + this.leaseTtlMs;
    return lease;
  }

  renewLease(id, context, options) {
    return this.publicLease(this.validateLease(id, context, { ...options, renew: true }));
  }

  releaseLease(id, context, options) {
    const lease = this.validateLease(id, context, options);
    this.leases.delete(id);
    this._scheduleIdleStop();
    return { released: true, id: lease.id };
  }

  setPreset(id, context, preset, options) {
    if (!PRESETS.has(preset)) throw new ObserverManagerError('invalid_preset', 'Observer preset is not allowlisted');
    const lease = this.validateLease(id, context, options);
    this.currentPreset = preset;
    for (const current of this.leases.values()) {
      if (current.generation === lease.generation) current.preset = preset;
    }
    return this.publicLease(lease);
  }

  async revalidate() {
    const now = this.now();
    for (const [id, lease] of this.leases) {
      const refreshed = this.authGate.revalidateAuthContext(lease.principal);
      if (lease.expiresAt <= now || !refreshed ||
          lease.generation !== this.generation || lease.generation !== this.containment.active?.generation) {
        this.leases.delete(id);
      } else {
        lease.principal = refreshed;
      }
    }
    this._scheduleIdleStop();
    return this.leases.size;
  }

  async invalidateAndDisable(reason = 'disabled') {
    this._lifecycleTransitions += 1;
    this._epoch += 1;
    this._clearIdleTimer();
    this._stopRevalidation();
    this.leases.clear();
    this.generation = null;
    try {
      if (this._idleStopping) await this._idleStopping;
      const starting = this._starting;
      if (starting) {
        try { await starting; } catch {}
      }
      this._stopRevalidation();
      const result = await this.coordinator.disable({ reason });
      this.generation = null;
      this._runtimeError = null;
      return result;
    } finally {
      this._lifecycleTransitions -= 1;
    }
  }

  async invalidateAndUninstall() {
    this._lifecycleTransitions += 1;
    this._epoch += 1;
    this._clearIdleTimer();
    this._stopRevalidation();
    this.leases.clear();
    this.generation = null;
    try {
      if (this._idleStopping) await this._idleStopping;
      const starting = this._starting;
      if (starting) {
        try { await starting; } catch {}
      }
      this._stopRevalidation();
      const result = await this.coordinator.uninstall();
      this.generation = null;
      this._runtimeError = null;
      return result;
    } finally {
      this._lifecycleTransitions -= 1;
    }
  }

  async shutdown(reason = 'dashboard_shutdown') {
    this._shuttingDown = true;
    this._epoch += 1;
    this._clearIdleTimer();
    this._stopRevalidation();
    this.leases.clear();
    if (this._idleStopping) await this._idleStopping;
    const starting = this._starting;
    if (starting) {
      try { await starting; } catch {}
    }
    this._stopRevalidation();
    const result = await this.containment.stopGeneration({ reason });
    this.generation = null;
    this._runtimeError = null;
    return result;
  }

  async handleContainmentFailure(error) {
    this._epoch += 1;
    this._clearIdleTimer();
    this._stopRevalidation();
    this.leases.clear();
    this._runtimeError = error || new Error('Observer containment failed');
    try { await this.containment.stopGeneration({ reason: 'child_failure' }); } catch (cleanupError) {
      this._runtimeError = cleanupError;
    }
    this.generation = null;
  }
}

export const OBSERVER_PRESETS = Object.freeze([...PRESETS]);
