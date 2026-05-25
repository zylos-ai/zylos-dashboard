import crypto from 'node:crypto';
import { readJsonBody } from './http.js';
import { sendJson } from './http.js';

const ALLOWED_EVENTS = new Set([
  'SessionStart',
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest',
  'SubagentStart', 'SubagentStop'
]);

const EVENT_TYPE_MAP = {
  SessionStart: { event_type: 'session_start', category: 'session' },
  PreToolUse: { event_type: 'pre_tool_use', category: 'tool' },
  PostToolUse: { event_type: 'post_tool_use', category: 'tool' },
  UserPromptSubmit: { event_type: 'user_prompt_submit', category: 'turn' },
  Stop: { event_type: 'stop', category: 'turn' },
  PermissionRequest: { event_type: 'permission_request', category: 'permission' },
  SubagentStart: { event_type: 'subagent_start', category: 'subagent' },
  SubagentStop: { event_type: 'subagent_stop', category: 'subagent' }
};

export class IngestHandler {
  constructor(store, sanitizer, stateEngine, config) {
    this.store = store;
    this.sanitizer = sanitizer;
    this.stateEngine = stateEngine;
    this.config = config;
  }

  async handle(req, res) {
    const remote = req.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }

    if (this.config.ingestToken) {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${this.config.ingestToken}`) {
        sendJson(res, 403, { error: 'invalid_token' });
        return;
      }
    }

    let body;
    try {
      body = await readJsonBody(req, 64 * 1024);
    } catch (err) {
      const status = err.status || 400;
      sendJson(res, status, { error: err.message });
      return;
    }

    const { ingest_id, hook_event_name } = body;
    if (!ingest_id || !hook_event_name) {
      sendJson(res, 400, { error: 'missing ingest_id or hook_event_name' });
      return;
    }

    if (!ALLOWED_EVENTS.has(hook_event_name)) {
      sendJson(res, 200, { ok: true, ignored: true });
      return;
    }

    try {
      const sanitized = this.sanitizer.sanitizeHookPayload(hook_event_name, body);
      const { event_type, category } = EVENT_TYPE_MAP[hook_event_name];

      const event = {
        id: crypto.randomUUID(),
        ingest_id,
        timestamp: body.received_at || new Date().toISOString(),
        runtime: body.runtime || process.env.ZYLOS_RUNTIME || 'claude',
        session_id: sanitized.session_id,
        event_type,
        category,
        summary: sanitized.summary,
        duration_ms: sanitized.duration_ms,
        metadata: sanitized.metadata,
        source: 'hook',
        confidence: 'actual'
      };

      const { inserted } = this.store.insertEvent(event);

      if (event.runtime === 'codex' && sanitized.metadata?.transcript_path && sanitized.session_id) {
        this.store.upsertCodexRolloutPath?.({
          runtime: event.runtime,
          sessionId: sanitized.session_id,
          transcriptPath: sanitized.metadata.transcript_path,
          lastEventAt: event.timestamp
        });
      }

      if (inserted && this.stateEngine) {
        this.stateEngine.onEvent(event);
      }

      const now = new Date().toISOString();
      this.store.upsertSourceHealth('hook_handler', 'collector_liveness', 'healthy', { last_success: now });
      this.store.upsertSourceHealth('hook_events', 'runtime_progress', 'healthy', {
        last_success: now,
        runtime: event.runtime
      });

      sendJson(res, 200, { ok: true });
    } catch (err) {
      process.stderr.write(`[ingest-handler] Error: ${err.message}\n`);
      sendJson(res, 500, { error: 'internal_error' });
    }
  }
}
