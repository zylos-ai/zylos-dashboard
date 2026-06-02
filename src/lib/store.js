import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const SCHEMA_V2_SESSIONS = `
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  remember INTEGER NOT NULL DEFAULT 0
);
`;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runtime_events (
  id TEXT PRIMARY KEY,
  ingest_id TEXT NOT NULL UNIQUE,
  event_seq INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  runtime TEXT NOT NULL DEFAULT 'claude',
  session_id TEXT,
  event_type TEXT NOT NULL,
  category TEXT NOT NULL,
  summary TEXT,
  duration_ms INTEGER,
  metadata TEXT,
  source TEXT NOT NULL DEFAULT 'hook',
  confidence TEXT NOT NULL DEFAULT 'actual'
);
CREATE INDEX IF NOT EXISTS idx_events_seq ON runtime_events(event_seq);
CREATE INDEX IF NOT EXISTS idx_events_type ON runtime_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON runtime_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_session ON runtime_events(session_id);

CREATE TABLE IF NOT EXISTS metric_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  runtime TEXT NOT NULL DEFAULT 'claude',
  session_id TEXT,
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  dimensions TEXT,
  source TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'actual'
);
CREATE INDEX IF NOT EXISTS idx_metrics_name_ts ON metric_points(metric_name, timestamp);

CREATE TABLE IF NOT EXISTS activity_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  runtime TEXT NOT NULL DEFAULT 'claude',
  session_id TEXT,
  project TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS idx_facts_type_ts ON activity_facts(fact_type, timestamp);

CREATE TABLE IF NOT EXISTS source_health (
  name TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  extra TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (name, signal_type)
);

CREATE TABLE IF NOT EXISTS state_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  runtime TEXT NOT NULL,
  session_id TEXT,
  running_tool TEXT,
  open_turn TEXT,
  pending_permission TEXT,
  possibly_stuck_since TEXT,
  last_progress_cursor INTEGER NOT NULL,
  last_message TEXT,
  snapshot_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_latest ON state_snapshots(runtime, session_id, snapshot_at DESC);
`;

export class Store {
  constructor(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
    this._prepareStatements();
  }

  migrate() {
    const hasTable = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
    ).get();

    let currentVersion = 0;

    if (hasTable) {
      const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
      currentVersion = row?.v || 0;
    }

    if (currentVersion < 1) {
      this.db.exec(SCHEMA_V1);
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(1);
    }
    if (currentVersion < 2) {
      this.db.exec(SCHEMA_V2_SESSIONS);
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(2);
    }
    if (currentVersion < 3) {
      const cols = this.db.pragma('table_info(state_snapshots)').map(c => c.name);
      if (!cols.includes('last_message')) {
        this.db.exec('ALTER TABLE state_snapshots ADD COLUMN last_message TEXT');
      }
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(3);
    }
    if (currentVersion < 4) {
      const cols = this.db.pragma('table_info(state_snapshots)').map(c => c.name);
      if (!cols.includes('last_prompt')) {
        this.db.exec('ALTER TABLE state_snapshots ADD COLUMN last_prompt TEXT');
      }
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(4);
    }
    if (currentVersion < 5) {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_metric_points_name_session_ts
        ON metric_points (metric_name, session_id, timestamp)
      `);
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(5);
    }
    if (currentVersion < 6) {
      const cols = this.db.pragma('table_info(state_snapshots)').map(c => c.name);
      if (!cols.includes('last_progress_at')) {
        this.db.exec('ALTER TABLE state_snapshots ADD COLUMN last_progress_at TEXT');
      }
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(6);
    }
    if (currentVersion < 7) {
      const cols = this.db.pragma('table_info(auth_sessions)').map(c => c.name);
      if (!cols.includes('remember')) {
        this.db.exec('ALTER TABLE auth_sessions ADD COLUMN remember INTEGER NOT NULL DEFAULT 0');
      }
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(7);
    }
    if (currentVersion < 8) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS codex_rollout_paths (
          runtime TEXT NOT NULL,
          session_id TEXT NOT NULL,
          transcript_path TEXT NOT NULL,
          last_event_at TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (runtime, session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_codex_rollout_paths_updated
        ON codex_rollout_paths (runtime, updated_at DESC);

        CREATE TABLE IF NOT EXISTS codex_rollout_cursors (
          transcript_path TEXT PRIMARY KEY,
          byte_offset INTEGER NOT NULL DEFAULT 0,
          session_id TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(8);
    }
  }

  _prepareStatements() {
    this._insertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO runtime_events
        (id, ingest_id, event_seq, timestamp, runtime, session_id, event_type, category, summary, duration_ms, metadata, source, confidence)
      VALUES
        (@id, @ingest_id, @event_seq, @timestamp, @runtime, @session_id, @event_type, @category, @summary, @duration_ms, @metadata, @source, @confidence)
    `);

    this._nextSeq = this.db.prepare('SELECT COALESCE(MAX(event_seq), 0) + 1 AS seq FROM runtime_events');

    this._queryEvents = this.db.prepare(`
      SELECT * FROM runtime_events
      WHERE timestamp >= @since AND timestamp <= @until
      ORDER BY event_seq ASC
      LIMIT @limit OFFSET @offset
    `);

    this._queryEventsDesc = this.db.prepare(`
      SELECT * FROM runtime_events
      WHERE timestamp >= @since AND timestamp <= @until
      ORDER BY event_seq DESC
      LIMIT @limit OFFSET @offset
    `);

    this._queryEventsByType = this.db.prepare(`
      SELECT * FROM runtime_events
      WHERE timestamp >= @since AND timestamp <= @until AND event_type = @event_type
      ORDER BY event_seq ASC
      LIMIT @limit OFFSET @offset
    `);

    this._queryEventsByTypeDesc = this.db.prepare(`
      SELECT * FROM runtime_events
      WHERE timestamp >= @since AND timestamp <= @until AND event_type = @event_type
      ORDER BY event_seq DESC
      LIMIT @limit OFFSET @offset
    `);

    this._latestEventByType = this.db.prepare(`
      SELECT * FROM runtime_events WHERE event_type = ? ORDER BY event_seq DESC LIMIT 1
    `);

    this._eventsSince = this.db.prepare(`
      SELECT * FROM runtime_events WHERE event_seq > ? ORDER BY event_seq ASC
    `);

    this._deleteOldEvents = this.db.prepare(`
      DELETE FROM runtime_events WHERE timestamp < datetime('now', '-' || ? || ' days')
    `);

    this._insertMetric = this.db.prepare(`
      INSERT INTO metric_points (timestamp, runtime, session_id, metric_name, metric_value, dimensions, source, confidence)
      VALUES (@timestamp, @runtime, @session_id, @metric_name, @metric_value, @dimensions, @source, @confidence)
    `);

    this._metricExistsByEventId = this.db.prepare(`
      SELECT 1 FROM metric_points
      WHERE metric_name = @metric_name
        AND COALESCE(session_id, '') = COALESCE(@session_id, '')
        AND source = @source
        AND json_extract(dimensions, '$.event_id') = @event_id
      LIMIT 1
    `);

    this._queryMetrics = this.db.prepare(`
      SELECT * FROM metric_points
      WHERE metric_name = @name AND timestamp >= @since AND timestamp <= @until
      ORDER BY timestamp ASC
    `);

    this._deleteOldMetrics = this.db.prepare(`
      DELETE FROM metric_points WHERE timestamp < datetime('now', '-' || ? || ' days')
    `);

    this._insertFact = this.db.prepare(`
      INSERT INTO activity_facts (timestamp, fact_type, runtime, session_id, project, data)
      VALUES (@timestamp, @fact_type, @runtime, @session_id, @project, @data)
    `);

    this._queryFacts = this.db.prepare(`
      SELECT * FROM activity_facts
      WHERE timestamp >= @since AND timestamp <= @until
      ORDER BY timestamp DESC
      LIMIT @limit
    `);

    this._deleteOldFacts = this.db.prepare(`
      DELETE FROM activity_facts WHERE timestamp < datetime('now', '-' || ? || ' days')
    `);

    this._upsertSourceHealth = this.db.prepare(`
      INSERT INTO source_health (name, signal_type, status, extra, updated_at)
      VALUES (@name, @signal_type, @status, @extra, datetime('now'))
      ON CONFLICT(name, signal_type) DO UPDATE SET
        status = @status, extra = @extra, updated_at = datetime('now')
    `);

    this._getSourceHealth = this.db.prepare('SELECT * FROM source_health');

    this._getCollectorLiveness = this.db.prepare(
      "SELECT * FROM source_health WHERE signal_type = 'collector_liveness'"
    );

    this._saveSnapshot = this.db.prepare(`
      INSERT INTO state_snapshots
        (runtime, session_id, running_tool, open_turn, pending_permission, possibly_stuck_since, last_progress_cursor, last_message, last_prompt, last_progress_at)
      VALUES
        (@runtime, @session_id, @running_tool, @open_turn, @pending_permission, @possibly_stuck_since, @last_progress_cursor, @last_message, @last_prompt, @last_progress_at)
    `);

    this._latestSnapshot = this.db.prepare(`
      SELECT * FROM state_snapshots
      WHERE runtime = @runtime AND (session_id = @session_id OR (@session_id IS NULL AND session_id IS NULL))
      ORDER BY snapshot_at DESC LIMIT 1
    `);

    this._insertSession = this.db.prepare(
      'INSERT OR REPLACE INTO auth_sessions (token_hash, created_at, last_activity_at, remember) VALUES (?, ?, ?, ?)'
    );
    this._getSession = this.db.prepare(
      'SELECT * FROM auth_sessions WHERE token_hash = ?'
    );
    this._touchSession = this.db.prepare(
      'UPDATE auth_sessions SET last_activity_at = ? WHERE token_hash = ?'
    );
    this._deleteSession = this.db.prepare(
      'DELETE FROM auth_sessions WHERE token_hash = ?'
    );
    this._cleanupSessions = this.db.prepare(
      'DELETE FROM auth_sessions WHERE created_at < ? OR last_activity_at < ?'
    );

    this._upsertCodexRolloutPath = this.db.prepare(`
      INSERT INTO codex_rollout_paths (runtime, session_id, transcript_path, last_event_at, updated_at)
      VALUES (@runtime, @session_id, @transcript_path, @last_event_at, datetime('now'))
      ON CONFLICT(runtime, session_id) DO UPDATE SET
        transcript_path = @transcript_path,
        last_event_at = @last_event_at,
        updated_at = datetime('now')
    `);

    this._latestCodexRolloutPath = this.db.prepare(`
      SELECT * FROM codex_rollout_paths
      WHERE runtime = @runtime
      ORDER BY updated_at DESC
      LIMIT 1
    `);

    this._getCodexRolloutCursor = this.db.prepare(`
      SELECT * FROM codex_rollout_cursors WHERE transcript_path = ?
    `);

    this._upsertCodexRolloutCursor = this.db.prepare(`
      INSERT INTO codex_rollout_cursors (transcript_path, byte_offset, session_id, updated_at)
      VALUES (@transcript_path, @byte_offset, @session_id, datetime('now'))
      ON CONFLICT(transcript_path) DO UPDATE SET
        byte_offset = @byte_offset,
        session_id = @session_id,
        updated_at = datetime('now')
    `);
  }

  insertEvent(event) {
    const seq = this._nextSeq.get().seq;
    const info = this._insertEvent.run({
      id: event.id,
      ingest_id: event.ingest_id,
      event_seq: seq,
      timestamp: event.timestamp,
      runtime: event.runtime || 'claude',
      session_id: event.session_id || null,
      event_type: event.event_type,
      category: event.category,
      summary: event.summary || null,
      duration_ms: event.duration_ms || null,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
      source: event.source || 'hook',
      confidence: event.confidence || 'actual'
    });
    return { inserted: info.changes > 0, event_seq: seq };
  }

  queryEvents({ since, until, types, sessionId, limit = 100, offset = 0, order = 'asc' }) {
    const s = since || '1970-01-01T00:00:00Z';
    const u = until || '2099-12-31T23:59:59Z';
    const desc = order === 'desc';

    if (types && types.length === 1) {
      const stmt = desc ? this._queryEventsByTypeDesc : this._queryEventsByType;
      return stmt.all({ since: s, until: u, event_type: types[0], limit, offset })
        .map(this._parseEventRow);
    }

    let rows = (desc ? this._queryEventsDesc : this._queryEvents).all({ since: s, until: u, limit, offset });
    if (types && types.length > 0) {
      const typeSet = new Set(types);
      rows = rows.filter(r => typeSet.has(r.event_type));
    }
    if (sessionId) {
      rows = rows.filter(r => r.session_id === sessionId);
    }
    return rows.map(this._parseEventRow);
  }

  latestEventByType(eventType) {
    const row = this._latestEventByType.get(eventType);
    return row ? this._parseEventRow(row) : null;
  }

  eventsSince(eventSeq) {
    return this._eventsSince.all(eventSeq).map(this._parseEventRow);
  }

  deleteEventsOlderThan(days) {
    return this._deleteOldEvents.run(days);
  }

  insertMetric(point) {
    this._insertMetric.run({
      timestamp: point.timestamp,
      runtime: point.runtime || 'claude',
      session_id: point.session_id || null,
      metric_name: point.metric_name,
      metric_value: point.metric_value,
      dimensions: point.dimensions ? JSON.stringify(point.dimensions) : null,
      source: point.source,
      confidence: point.confidence || 'actual'
    });
  }

  hasMetricEventId({ metricName, sessionId, source, eventId }) {
    if (!metricName || !source || !eventId) return false;
    return !!this._metricExistsByEventId.get({
      metric_name: metricName,
      session_id: sessionId || null,
      source,
      event_id: eventId
    });
  }

  queryMetrics({ name, since, until }) {
    const s = since || '1970-01-01T00:00:00Z';
    const u = until || '2099-12-31T23:59:59Z';
    return this._queryMetrics.all({ name, since: s, until: u }).map(row => ({
      ...row,
      dimensions: row.dimensions ? JSON.parse(row.dimensions) : null
    }));
  }

  deleteMetricsOlderThan(days) {
    return this._deleteOldMetrics.run(days);
  }

  insertFact(fact) {
    this._insertFact.run({
      timestamp: fact.timestamp,
      fact_type: fact.fact_type,
      runtime: fact.runtime || 'claude',
      session_id: fact.session_id || null,
      project: fact.project || null,
      data: fact.data ? JSON.stringify(fact.data) : null
    });
  }

  queryFacts({ since, until, types, project, limit = 100 }) {
    const s = since || '1970-01-01T00:00:00Z';
    const u = until || '2099-12-31T23:59:59Z';
    let rows = this._queryFacts.all({ since: s, until: u, limit });
    if (types && types.length > 0) {
      const typeSet = new Set(types);
      rows = rows.filter(r => typeSet.has(r.fact_type));
    }
    if (project) {
      rows = rows.filter(r => r.project === project);
    }
    return rows.map(row => ({
      ...row,
      data: row.data ? JSON.parse(row.data) : null
    }));
  }

  deleteFactsOlderThan(days) {
    return this._deleteOldFacts.run(days);
  }

  upsertSourceHealth(name, signalType, status, extra) {
    this._upsertSourceHealth.run({
      name,
      signal_type: signalType,
      status,
      extra: extra ? JSON.stringify(extra) : null
    });
  }

  getSourceHealth() {
    return this._getSourceHealth.all().map(row => ({
      ...row,
      extra: row.extra ? JSON.parse(row.extra) : null
    }));
  }

  getCollectorLiveness() {
    return this._getCollectorLiveness.all().map(row => ({
      ...row,
      extra: row.extra ? JSON.parse(row.extra) : null
    }));
  }

  saveSnapshot(snapshot) {
    this._saveSnapshot.run({
      runtime: snapshot.runtime,
      session_id: snapshot.session_id || null,
      running_tool: snapshot.running_tool ? JSON.stringify(snapshot.running_tool) : null,
      open_turn: snapshot.open_turn ? JSON.stringify(snapshot.open_turn) : null,
      pending_permission: snapshot.pending_permission ? JSON.stringify(snapshot.pending_permission) : null,
      possibly_stuck_since: snapshot.possibly_stuck_since || null,
      last_progress_cursor: snapshot.last_progress_cursor,
      last_message: snapshot.last_message || null,
      last_prompt: snapshot.last_prompt || null,
      last_progress_at: snapshot.last_progress_at || null
    });
  }

  latestSnapshot(runtime, sessionId) {
    const row = this._latestSnapshot.get({ runtime, session_id: sessionId || null });
    if (!row) return null;
    return {
      ...row,
      running_tool: row.running_tool ? JSON.parse(row.running_tool) : null,
      open_turn: row.open_turn ? JSON.parse(row.open_turn) : null,
      pending_permission: row.pending_permission ? JSON.parse(row.pending_permission) : null
    };
  }

  insertSession(tokenHash, now, remember = false) {
    this._insertSession.run(tokenHash, now, now, remember ? 1 : 0);
  }

  getSession(tokenHash) {
    return this._getSession.get(tokenHash) || null;
  }

  touchSession(tokenHash, now) {
    this._touchSession.run(now, tokenHash);
  }

  deleteSession(tokenHash) {
    this._deleteSession.run(tokenHash);
  }

  cleanupSessions(absoluteCutoff, idleCutoff) {
    return this._cleanupSessions.run(absoluteCutoff, idleCutoff);
  }

  upsertCodexRolloutPath({ runtime = 'codex', sessionId, transcriptPath, lastEventAt }) {
    if (!sessionId || !transcriptPath || typeof transcriptPath !== 'string') return { changes: 0 };
    if (!transcriptPath.endsWith('.jsonl')) return { changes: 0 };
    const info = this._upsertCodexRolloutPath.run({
      runtime,
      session_id: sessionId,
      transcript_path: transcriptPath,
      last_event_at: lastEventAt || null
    });
    return { changes: info.changes };
  }

  latestCodexRolloutPath(runtime = 'codex') {
    const row = this._latestCodexRolloutPath.get({ runtime });
    return row ? {
      runtime: row.runtime,
      session_id: row.session_id,
      transcript_path: row.transcript_path,
      last_event_at: row.last_event_at,
      updated_at: row.updated_at
    } : null;
  }

  getCodexRolloutCursor(transcriptPath) {
    if (!transcriptPath) return null;
    const row = this._getCodexRolloutCursor.get(transcriptPath);
    return row ? {
      transcript_path: row.transcript_path,
      byte_offset: row.byte_offset,
      session_id: row.session_id,
      updated_at: row.updated_at
    } : null;
  }

  upsertCodexRolloutCursor({ transcriptPath, byteOffset, sessionId }) {
    if (!transcriptPath || !Number.isFinite(byteOffset) || byteOffset < 0) return { changes: 0 };
    const info = this._upsertCodexRolloutCursor.run({
      transcript_path: transcriptPath,
      byte_offset: Math.floor(byteOffset),
      session_id: sessionId || null
    });
    return { changes: info.changes };
  }

  aggregateCost({ since, until, sessionId } = {}) {
    let sql = `SELECT SUM(metric_value) AS total, COUNT(*) AS cnt FROM metric_points WHERE metric_name = 'api_request_cost'`;
    const params = {};
    if (since) { sql += ' AND timestamp >= @since'; params.since = since; }
    if (until) { sql += ' AND timestamp <= @until'; params.until = until; }
    if (sessionId) { sql += ' AND session_id = @sessionId'; params.sessionId = sessionId; }
    const row = this.db.prepare(sql).get(params);
    if (!row || row.cnt === 0) return null;
    return row.total;
  }

  aggregateCacheRate({ since, until, sessionId } = {}) {
    let sql = `
      SELECT COALESCE(SUM(json_extract(dimensions, '$.cache_read')), 0) AS cache_read,
             COALESCE(SUM(metric_value), 0) AS total_input
      FROM metric_points WHERE metric_name = 'api_request_tokens'`;
    const params = {};
    if (since) { sql += ' AND timestamp >= @since'; params.since = since; }
    if (until) { sql += ' AND timestamp <= @until'; params.until = until; }
    if (sessionId) { sql += ' AND session_id = @sessionId'; params.sessionId = sessionId; }
    const row = this.db.prepare(sql).get(params);
    if (!row || row.total_input === 0) return null;
    return row.cache_read / row.total_input;
  }

  aggregateTokens({ since, until, sessionId } = {}) {
    let sql = `
      SELECT COALESCE(SUM(json_extract(dimensions, '$.input')), 0) AS input,
             COALESCE(SUM(json_extract(dimensions, '$.cache_read')), 0) AS cache_read,
             COALESCE(SUM(json_extract(dimensions, '$.cache_creation')), 0) AS cache_creation,
             COALESCE(SUM(json_extract(dimensions, '$.output')), 0) AS output,
             COALESCE(SUM(metric_value), 0) AS total_input,
             COUNT(*) AS cnt
      FROM metric_points WHERE metric_name = 'api_request_tokens'`;
    const params = {};
    if (since) { sql += ' AND timestamp >= @since'; params.since = since; }
    if (until) { sql += ' AND timestamp <= @until'; params.until = until; }
    if (sessionId) { sql += ' AND session_id = @sessionId'; params.sessionId = sessionId; }
    const row = this.db.prepare(sql).get(params);
    if (!row || row.cnt === 0) return null;
    return {
      input: row.total_input,
      output: row.output,
      cache_read: row.cache_read,
      cache_rate: row.total_input > 0 ? row.cache_read / row.total_input : 0
    };
  }

  aggregateTokenSeries({ since, until, bucketSeconds = 3600 } = {}) {
    const sql = `
      SELECT (CAST(CAST(strftime('%s', timestamp) AS INTEGER) / @bucket AS INTEGER) * @bucket) AS bucket_start,
             COALESCE(SUM(metric_value), 0) AS input_sum,
             COALESCE(SUM(json_extract(dimensions, '$.output')), 0) AS output_sum,
             COALESCE(SUM(json_extract(dimensions, '$.cache_read')), 0) AS cache_read_sum,
             COALESCE(SUM(metric_value), 0) AS total_input_sum
      FROM metric_points
      WHERE metric_name = 'api_request_tokens'
        AND timestamp >= @since AND timestamp <= @until
      GROUP BY bucket_start ORDER BY bucket_start`;
    const rows = this.db.prepare(sql).all({ since, until, bucket: bucketSeconds });
    return rows.map(r => ({
      ...r,
      cache_rate: r.total_input_sum > 0 ? r.cache_read_sum / r.total_input_sum : null
    }));
  }

  aggregateCostSeries({ since, until, bucketSeconds = 3600 } = {}) {
    const sql = `
      SELECT (CAST(CAST(strftime('%s', timestamp) AS INTEGER) / @bucket AS INTEGER) * @bucket) AS bucket_start,
             SUM(metric_value) AS cost_sum,
             COUNT(*) AS request_count
      FROM metric_points
      WHERE metric_name = 'api_request_cost'
        AND timestamp >= @since AND timestamp <= @until
      GROUP BY bucket_start ORDER BY bucket_start`;
    return this.db.prepare(sql).all({ since, until, bucket: bucketSeconds });
  }

  aggregateCacheRateSeries({ since, until, bucketSeconds = 3600 } = {}) {
    const sql = `
      SELECT (CAST(CAST(strftime('%s', timestamp) AS INTEGER) / @bucket AS INTEGER) * @bucket) AS bucket_start,
             COALESCE(SUM(json_extract(dimensions, '$.cache_read')), 0) AS cache_read_sum,
             COALESCE(SUM(metric_value), 0) AS total_input_sum
      FROM metric_points
      WHERE metric_name = 'api_request_tokens'
        AND timestamp >= @since AND timestamp <= @until
      GROUP BY bucket_start ORDER BY bucket_start`;
    const rows = this.db.prepare(sql).all({ since, until, bucket: bucketSeconds });
    return rows.map(r => ({ ...r, rate: r.total_input_sum > 0 ? r.cache_read_sum / r.total_input_sum : null }));
  }

  getProjectDistribution({ since, until } = {}) {
    const s = since || '1970-01-01T00:00:00Z';
    const u = until || '2099-12-31T23:59:59Z';

    // Get rows with project attribution from JSONL-ingested metrics
    const rows = this.db.prepare(`
      SELECT metric_value, dimensions FROM metric_points
      WHERE metric_name = 'api_request_tokens'
        AND timestamp >= @since AND timestamp <= @until
    `).all({ since: s, until: u });

    let totalTokens = 0;
    let totalOutput = 0;
    const projectOutputTokens = {};

    for (const row of rows) {
      let dims;
      try { dims = JSON.parse(row.dimensions); } catch { continue; }
      const output = dims.output || 0;
      const totalInput = Number(row.metric_value) || dims.total_input || 0;
      totalTokens += totalInput + output;
      totalOutput += output;

      const projects = dims.projects;
      if (Array.isArray(projects) && projects.length > 0) {
        const share = output / projects.length;
        for (const p of projects) {
          projectOutputTokens[p] = (projectOutputTokens[p] || 0) + share;
        }
      } else {
        // Fall back to hook-based project extraction for older data without project attribution
        // (these records were ingested before the project extraction was added)
      }
    }

    // Distribute unattributed output tokens using hook tool call proportions
    const attributedOutput = Object.values(projectOutputTokens).reduce((a, b) => a + b, 0);
    const unattributedOutput = totalOutput - attributedOutput;

    if (unattributedOutput > 0) {
      const events = this.db.prepare(`
        SELECT summary FROM runtime_events
        WHERE event_type IN ('post_tool_use', 'tool_call', 'tool_result')
          AND timestamp >= @since AND timestamp <= @until
      `).all({ since: s, until: u });

      const hookCounts = {};
      for (const e of events) {
        for (const project of this._extractProjectsFromSummary(e.summary)) {
          hookCounts[project] = (hookCounts[project] || 0) + 1;
        }
      }
      for (const [project, count] of Object.entries(this._projectWeightsFromCodexRollouts({ since: s, until: u }))) {
        hookCounts[project] = (hookCounts[project] || 0) + count;
      }
      const totalHookCalls = Object.values(hookCounts).reduce((a, b) => a + b, 0) || 1;
      for (const [p, count] of Object.entries(hookCounts)) {
        projectOutputTokens[p] = (projectOutputTokens[p] || 0) + unattributedOutput * (count / totalHookCalls);
      }
    }

    const costRow = this.db.prepare(`
      SELECT COALESCE(SUM(metric_value), 0) AS total_cost
      FROM metric_points
      WHERE metric_name = 'api_request_cost'
        AND timestamp >= @since AND timestamp <= @until
    `).get({ since: s, until: u });
    const totalCost = costRow?.total_cost || 0;

    const items = Object.entries(projectOutputTokens)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, outputTok]) => {
        const pct = totalOutput > 0 ? outputTok / totalOutput : 0;
        return {
          name,
          outputTokens: Math.round(outputTok),
          cost: +(totalCost * pct).toFixed(4),
          percentage: +(pct * 100).toFixed(1)
        };
      });

    return { items, totalTokens, totalOutput, totalCost };
  }

  _extractProjectsFromSummary(summary) {
    const projects = new Set();
    for (const filePath of this._extractFilePaths(summary)) {
      const project = this._extractProject(filePath);
      if (project) projects.add(project);
    }
    return [...projects];
  }

  _extractFilePaths(summary) {
    if (!summary) return [];
    const paths = new Set();
    const pathPattern = /(?:~\/|\/)?(?:Users\/[^/\s]+\/zylos\/|zylos\/)?(?:workspace|\.claude\/skills|skills)\/[^\s,'")]+/g;
    for (const match of summary.matchAll(pathPattern)) {
      paths.add(match[0]);
    }
    return [...paths];
  }

  _projectWeightsFromCodexRollouts({ since, until } = {}) {
    const rows = this.db.prepare(`
      SELECT transcript_path FROM codex_rollout_paths
      WHERE runtime = 'codex'
        AND last_event_at >= @since AND last_event_at <= @until
    `).all({ since, until });

    const weights = {};
    for (const row of rows) {
      const transcriptPath = row.transcript_path;
      if (!transcriptPath || !fs.existsSync(transcriptPath)) continue;
      let content;
      try {
        content = fs.readFileSync(transcriptPath, 'utf8');
      } catch {
        continue;
      }
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        const payload = event.type === 'session_meta'
          ? { ...(event.payload || {}), type: 'session_meta' }
          : event.payload || {};
        for (const project of this._extractProjectsFromRolloutPayload(payload)) {
          weights[project] = (weights[project] || 0) + 1;
        }
      }
    }
    return weights;
  }

  _extractProjectsFromRolloutPayload(payload) {
    const projects = new Set();
    const addFromValue = (value) => {
      if (!value) return;
      if (typeof value === 'string') {
        for (const filePath of this._extractFilePaths(value)) {
          const project = this._extractProject(filePath);
          if (project) projects.add(project);
        }
        const directProject = this._extractProject(value);
        if (directProject) projects.add(directProject);
      } else if (Array.isArray(value)) {
        for (const item of value) addFromValue(item);
      } else if (typeof value === 'object') {
        for (const item of Object.values(value)) addFromValue(item);
      }
    };

    if (payload.type === 'session_meta') addFromValue(payload.cwd);
    if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call') return [...projects];

    addFromValue(payload.name);
    addFromValue(payload.input);
    if (payload.arguments) {
      try {
        addFromValue(JSON.parse(payload.arguments));
      } catch {
        addFromValue(payload.arguments);
      }
    }

    return [...projects];
  }

  _extractProject(filePath) {
    if (!filePath) return null;
    const parts = filePath.replace(/^\/+/, '').split('/');
    const wsIdx = parts.indexOf('workspace');
    if (wsIdx >= 0 && parts[wsIdx + 1]) return parts[wsIdx + 1];
    const skillsIdx = parts.indexOf('skills');
    if (skillsIdx >= 0 && parts[skillsIdx + 1]) return parts[skillsIdx + 1];
    return null;
  }

  close() {
    this.db.close();
  }

  _parseEventRow(row) {
    return {
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    };
  }
}
