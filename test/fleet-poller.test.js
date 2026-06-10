import assert from 'node:assert/strict';
import test from 'node:test';
import { agentColor } from '../src/lib/agent-color.js';
import { FleetPoller, SseEventParser, stateToFleetRecord } from '../src/lib/fleet-poller.js';
import { buildFleetPayload } from '../src/lib/fleet-payload.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function makeConfig(agents, fleet = {}) {
  return {
    fleet: {
      agents,
      timeout_ms: 50,
      jitter_ms: 0,
      ...fleet
    }
  };
}

function streamResponse(text, status = 200) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  }), { status, headers: { 'content-type': 'text/event-stream' } });
}

test('fleet poller exchanges token and derives safe agent records', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization });
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_secret', expires_at: new Date(120000).toISOString() });
    }
    assert.equal(options.headers.Authorization, 'Bearer zylos_st_secret');
    return jsonResponse({
      state: 'BUSY',
      running_tools: [{ tool_name: 'Bash', tool_detail: 'npm test' }],
      runtime_info: { model: 'GPT-5', effort: 'high', zylos_update: '1.2.3' },
      new_session_threshold: 75,
      system_metrics: { cpu_pct: 12, mem_pct: 34, disk_pct: 56 },
      session_cost: 1.23,
      daily_cost: 4.56,
      weekly_cost: 7.89,
      active_subagents: [{ last_activity: 'Worker running' }],
      metrics: {
        context_pct: { value: 42 },
        session_cost: { value: 1.23 }
      }
    });
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test/dashboard', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => 0 });

  await poller.pollOnce();
  const fleet = poller.getFleet();
  assert.equal(fleet.count, 1);
  assert.equal(fleet.agents[0].name, 'Remote');
  assert.equal(fleet.agents[0].color, agentColor('Remote').color);
  assert.equal(fleet.agents[0].hue, agentColor('Remote').hue);
  assert.equal(fleet.agents[0].state, 'BUSY');
  assert.equal(fleet.agents[0].activity, 'npm test');
  assert.equal(fleet.agents[0].context_pct, 42);
  assert.equal(fleet.agents[0].cost, 1.23);
  assert.equal(fleet.agents[0].session_cost, 1.23);
  assert.equal(fleet.agents[0].daily_cost, 4.56);
  assert.equal(fleet.agents[0].weekly_cost, 7.89);
  assert.equal(fleet.agents[0].model, 'GPT-5');
  assert.equal(fleet.agents[0].effort, 'high');
  assert.equal(fleet.agents[0].new_session_threshold, 75);
  assert.equal(fleet.agents[0].cpu_pct, 12);
  assert.equal(fleet.agents[0].mem_pct, 34);
  assert.equal(fleet.agents[0].disk_pct, 56);
  assert.equal(fleet.agents[0].has_upgrade, true);
  assert.equal(fleet.agents[0].has_subagent, true);
  assert.equal(fleet.agents[0].health_reason, 'ok');
  assert.equal(JSON.stringify(fleet).includes('zylos_ak_secret'), false);
  assert.equal(JSON.stringify(fleet).includes('zylos_st_secret'), false);
  assert.equal(calls[0].authorization, 'Bearer zylos_ak_secret');
  assert.equal(fleet.agents[0].self, false, 'external records must not be flagged self');
});

test('fleet poller refreshes token after expiry and on state 401', async () => {
  let now = 0;
  let tokenCount = 0;
  let stateCount = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/auth/token')) {
      tokenCount += 1;
      return jsonResponse({ token: `zylos_st_${tokenCount}`, expires_at: new Date(now + 120000).toISOString() });
    }
    stateCount += 1;
    if (stateCount === 3) return jsonResponse({ error: 'expired' }, 401);
    return jsonResponse({ state: 'IDLE' });
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => now });

  await poller.pollOnce();
  assert.equal(tokenCount, 1);
  now = 70000;
  await poller.pollOnce();
  assert.equal(tokenCount, 2, 'token should refresh inside skew window');
  await poller.pollOnce();
  assert.equal(tokenCount, 3, 'state 401 should force token refresh');
  assert.equal(poller.getFleet().agents[0].health_reason, 'idle');
});

test('fleet poller falls back to ttl when expires_at is invalid', async () => {
  let now = 0;
  let tokenCount = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) {
      tokenCount += 1;
      return jsonResponse({ token: `zylos_st_${tokenCount}`, expires_at: 'not-a-date', ttl_seconds: 3600 });
    }
    return jsonResponse({ state: 'IDLE' });
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => now });

  await poller.pollOnce();
  now = 3000;
  await poller.pollOnce();
  assert.equal(tokenCount, 1, 'invalid expires_at should not force every poll to exchange a token');
});

test('fleet poller maps token 404 and invalid key 401 without blocking other agents', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('old.example.test')) return jsonResponse({ error: 'not_found' }, 404);
    if (url.includes('bad.example.test')) return jsonResponse({ error: 'invalid_api_key' }, 401);
    if (url.endsWith('/api/auth/token')) return jsonResponse({ token: 'zylos_st_ok', expires_at: new Date(120000).toISOString() });
    return jsonResponse({ state: 'IDLE' });
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Old', base_url: 'https://old.example.test', read_api_key: 'zylos_ak_old' },
    { name: 'Bad', base_url: 'https://bad.example.test', read_api_key: 'zylos_ak_bad' },
    { name: 'Good', base_url: 'https://good.example.test', read_api_key: 'zylos_ak_good' }
  ]), { fetch: fetchImpl, now: () => 0 });

  await poller.pollOnce();
  const byName = Object.fromEntries(poller.getFleet().agents.map(a => [a.name, a]));
  assert.equal(byName.Old.health_reason, 'version_unsupported');
  assert.equal(byName.Old.state, 'UNKNOWN');
  assert.equal(byName.Old.hue, agentColor('Old').hue);
  assert.equal(byName.Bad.health_reason, 'auth_failed');
  assert.equal(byName.Bad.state, 'OFFLINE');
  assert.equal(byName.Bad.hue, agentColor('Bad').hue);
  assert.equal(byName.Good.health_reason, 'idle');
  assert.equal(byName.Good.hue, agentColor('Good').hue);
});

test('fleet poller keeps quiet records online — no event-rate staleness (#180)', async () => {
  let now = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) return jsonResponse({ token: 'zylos_st_ok', expires_at: new Date(120000).toISOString() });
    return jsonResponse({ state: 'IDLE' });
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => now });

  await poller.pollOnce();
  assert.equal(poller.getFleet().agents[0].health_reason, 'idle');
  // An idle agent legitimately pushes nothing for long stretches; elapsed
  // time without events must not flip it offline while the channel is alive.
  now = 10 * 60_000;
  assert.equal(poller.getFleet().agents[0].health_reason, 'idle');
  assert.equal(poller.getFleet().agents[0].state, 'IDLE');
});

test('fleet poller marks agent OFFLINE on poll failure, recovers on success (#180)', async () => {
  let fail = false;
  const fetchImpl = async (url) => {
    if (fail) throw new Error('connection refused');
    if (url.endsWith('/api/auth/token')) return jsonResponse({ token: 'zylos_st_ok', expires_at: new Date(120000).toISOString() });
    return jsonResponse({ state: 'IDLE' });
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => 0 });

  await poller.pollOnce();
  assert.equal(poller.getFleet().agents[0].state, 'IDLE');

  fail = true;
  await poller.pollOnce();
  assert.equal(poller.getFleet().agents[0].state, 'OFFLINE');
  assert.equal(poller.getFleet().agents[0].health_reason, 'unreachable');
  // Last-known metrics are preserved for display alongside the OFFLINE state.
  fail = false;
  await poller.pollOnce();
  assert.equal(poller.getFleet().agents[0].state, 'IDLE');
});

test('fleet poller idle watchdog aborts half-open SSE and starts fallback polling (#180)', async () => {
  const timers = [];
  let sseController;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_stream', expires_at: new Date(120000).toISOString() });
    }
    if (url.endsWith('/api/state')) return jsonResponse({ state: 'IDLE' });
    if (url.endsWith('/api/stream')) {
      // Half-open connection: stream opens, then goes silent forever.
      return new Response(new ReadableStream({ start(c) { sseController = c; } }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ], { sse_idle_timeout_ms: 45_000 }), {
    fetch: fetchImpl,
    now: () => 0,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; }
  });

  const agent = poller.agents[0];
  poller.running = true;
  const stream = poller._streamState(agent);
  const controller = new AbortController();
  stream.controller = controller; // _connectSse wires this; mirrored here for a direct _runSse call
  const run = poller._runSse(agent, stream, controller.signal).catch(err => err);
  await new Promise(resolve => setTimeout(resolve, 0));

  const watchdog = timers.find(t => t.ms === 45_000 && !t.cleared);
  assert.ok(watchdog, 'idle watchdog should be armed after connect');
  assert.equal(stream.idleTimer, watchdog);

  watchdog.fn();
  assert.equal(controller.signal.aborted, true, 'watchdog should abort the half-open stream');
  assert.ok(stream.pollTimer, 'watchdog should start fallback polling');
  assert.ok(stream.reconnectTimer, 'watchdog should schedule a reconnect');
  poller.running = false;
  // A directly-constructed Response body does not observe fetch abort signals,
  // so close the stream to let the read loop notice signal.aborted and exit.
  sseController.close();
  await run;
});

test('stateToFleetRecord produces a secret-free self record from local API state', () => {
  const name = 'zylos01';
  const record = stateToFleetRecord({
    name,
    color: agentColor(name)
  }, {
      state: 'BUSY',
      running_tools: [{ tool_name: 'Bash', tool_detail: 'npm test' }],
      active_subagents: [{ last_activity: 'Subagent active' }],
      runtime_info: { model: 'Opus 4.6', effort: 'high', codex_update: '0.137.0' },
      context_pct: 42,
      new_session_threshold: 75,
      session_cost: 1.23,
      daily_cost: 4.56,
      weekly_cost: 7.89,
      system_metrics: { cpu_pct: 12, mem_pct: 34, disk_pct: 56 }
  }, {
    self: true,
    base_url: null,
    nowMs: 0
  });

  assert.equal(record.self, true);
  assert.equal(record.name, name);
  assert.equal(record.color, agentColor(name).color);
  assert.equal(record.hue, agentColor(name).hue);
  assert.equal(record.state, 'BUSY');
  assert.equal(record.activity, 'npm test');
  assert.equal(record.context_pct, 42);
  assert.equal(record.cost, 1.23);
  assert.equal(record.session_cost, 1.23);
  assert.equal(record.daily_cost, 4.56);
  assert.equal(record.weekly_cost, 7.89);
  assert.equal(record.model, 'Opus 4.6');
  assert.equal(record.effort, 'high');
  assert.equal(record.new_session_threshold, 75);
  assert.equal(record.cpu_pct, 12);
  assert.equal(record.mem_pct, 34);
  assert.equal(record.disk_pct, 56);
  assert.equal(record.has_upgrade, true);
  assert.equal(record.has_subagent, true);
  assert.equal(record.base_url, null);
  assert.equal(record.pulse_rate, 1);
  assert.equal(record.health_reason, 'ok');
  assert.equal(record.last_seen, new Date(0).toISOString());
  assert.equal(JSON.stringify(record).includes('zylos_ak_'), false);
  assert.equal(JSON.stringify(record).includes('zylos_st_'), false);
});

test('stateToFleetRecord consumes API snake_case cost tiers directly (#174)', () => {
  const record = stateToFleetRecord({
    name: 'test',
    color: agentColor('test')
  }, {
    state: 'IDLE',
    session_cost: 1.23,
    daily_cost: 4.56,
    weekly_cost: 7.89
  }, {
    self: true,
    nowMs: 0
  });
  assert.equal(record.session_cost, 1.23);
  assert.equal(record.daily_cost, 4.56);
  assert.equal(record.weekly_cost, 7.89);
});

test('stateToFleetRecord maps idle and self offline/unknown states', () => {
  const agent = { name: 'a', color: agentColor('a') };
  const idle = stateToFleetRecord(agent, { state: 'IDLE' }, { self: true, nowMs: 0 });
  assert.equal(idle.health_reason, 'idle');
  assert.equal(idle.pulse_rate, 1);

  const offline = stateToFleetRecord(agent, { state: 'OFFLINE' }, { self: true, nowMs: 0 });
  assert.equal(offline.health_reason, 'offline');
  assert.equal(offline.pulse_rate, 0);

  const unknown = stateToFleetRecord(agent, { state: 'UNKNOWN' }, { self: true, nowMs: 0 });
  assert.equal(unknown.health_reason, 'offline');
  assert.equal(unknown.pulse_rate, 0);
});

test('self record injected into fleet is first, flagged, and order-independent', () => {
  // Simulate the /api/fleet handler composition: self prepended to poller output.
  const self = stateToFleetRecord({ name: 'local', color: agentColor('local') }, { state: 'IDLE' }, { self: true, nowMs: 0 });
  const external = [
    { name: 'remote1', self: false },
    { name: 'remote2', self: false }
  ];
  const agents = [self, ...external];
  assert.equal(agents[0].self, true);
  assert.equal(agents[0].name, 'local');
  assert.equal(agents.filter((a) => a.self === true).length, 1);
  assert.ok(agents.slice(1).every((a) => a.self === false));
});

test('buildFleetPayload includes self first and rejects leaked secrets', () => {
  const self = stateToFleetRecord({ name: 'local', color: agentColor('local') }, { state: 'IDLE' }, { self: true, nowMs: 0 });
  const payload = buildFleetPayload({
    selfRecord: self,
    remoteFleet: { agents: [{ name: 'remote', self: false }], count: 1, updated_at: '2026-06-09T00:00:00.000Z' }
  });
  assert.equal(payload.count, 2);
  assert.equal(payload.agents[0].name, 'local');
  assert.equal(payload.agents[0].self, true);
  assert.equal(payload.agents[1].name, 'remote');
  assert.equal(payload.agents[1].self, false);

  assert.throws(() => buildFleetPayload({
    selfRecord: self,
    remoteFleet: { agents: [{ name: 'bad', read_api_key: 'zylos_ak_secret' }] }
  }), /fleet_secret_leak_guard/);
});

test('SseEventParser handles events, ids, comments, CRLF, bare CR, and multi-line data', () => {
  const events = [];
  const parser = new SseEventParser((event) => events.push(event));
  parser.push(': keepalive\r\nid: 7\r\nevent: fleet_state\r\ndata: {"state":"BUSY"');
  parser.push('\r\ndata: ,"context_pct":42}\r\n\r\n');
  parser.push('event: fleet_state\rdata: {"state":"IDLE"}\r\r');
  parser.flush();
  assert.deepEqual(events, [
    {
      event: 'fleet_state',
      data: '{"state":"BUSY"\n,"context_pct":42}',
      id: '7'
    },
    {
      event: 'fleet_state',
      data: '{"state":"IDLE"}',
      id: null
    }
  ]);
});

test('SseEventParser preserves event type when CRLF splits across chunks', () => {
  const events = [];
  const parser = new SseEventParser((event) => events.push(event));
  parser.push('event: fleet_state\r');
  parser.push('\ndata: {"state":"BUSY"}\r\n\r\n');
  parser.flush();
  assert.deepEqual(events, [{
    event: 'fleet_state',
    data: '{"state":"BUSY"}',
    id: null
  }]);
});

test('fleet poller SSE uses Bearer auth and fleet_state updates records', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, authorization: options.headers?.Authorization });
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_stream', expires_at: new Date(120000).toISOString() });
    }
    if (url.endsWith('/api/state')) return jsonResponse({ state: 'IDLE', context_pct: 1 });
    if (url.endsWith('/api/stream')) {
      assert.equal(options.headers.Authorization, 'Bearer zylos_st_stream');
      assert.equal(url.includes('token='), false);
      return streamResponse('event: fleet_state\ndata: {"state":"BUSY","context_pct":55,"session_cost":0.75}\n\n');
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => 0 });

  await poller._runSse(poller.agents[0], poller._streamState(poller.agents[0]), new AbortController().signal).catch(() => {});
  const record = poller.getFleet().agents[0];
  assert.equal(record.state, 'BUSY');
  assert.equal(record.context_pct, 55);
  assert.equal(record.session_cost, 0.75);
  assert.ok(calls.some(c => c.url.endsWith('/api/stream') && c.authorization === 'Bearer zylos_st_stream'));
});

test('fleet poller SSE auth_expired forces token refresh on reconnect', async () => {
  let tokenCount = 0;
  let streamCount = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) {
      tokenCount += 1;
      return jsonResponse({ token: `zylos_st_${tokenCount}`, expires_at: new Date(120000).toISOString() });
    }
    if (url.endsWith('/api/state')) return jsonResponse({ state: 'IDLE' });
    if (url.endsWith('/api/stream')) {
      streamCount += 1;
      return streamResponse(streamCount === 1
        ? 'event: auth_expired\ndata: {}\n\n'
        : 'event: fleet_state\ndata: {"state":"BUSY"}\n\n');
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => 0 });
  const agent = poller.agents[0];

  await assert.rejects(
    () => poller._runSse(agent, poller._streamState(agent), new AbortController().signal),
    /auth_expired/
  );
  await poller._runSse(agent, poller._streamState(agent), new AbortController().signal).catch(() => {});
  assert.equal(tokenCount, 2);
  assert.equal(poller.getFleet().agents[0].state, 'BUSY');
});

test('fleet poller stop aborts active SSE fetch streams', async () => {
  let signal;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_stream', expires_at: new Date(120000).toISOString() });
    }
    if (url.endsWith('/api/state')) return jsonResponse({ state: 'IDLE' });
    if (url.endsWith('/api/stream')) {
      signal = options.signal;
      return new Promise(() => {});
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => 0 });

  poller.start();
  await new Promise(resolve => setTimeout(resolve, 10));
  poller.stop();
  assert.equal(signal.aborted, true);
});

test('fleet poller resumes fallback polling when SSE has no fleet_state and stops after recovery', async () => {
  const timers = [];
  const cleared = new Set();
  let stateFetches = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_stream', expires_at: new Date(120000).toISOString() });
    }
    if (url.endsWith('/api/state')) {
      stateFetches += 1;
      return jsonResponse({ state: 'IDLE', context_pct: stateFetches });
    }
    if (url.endsWith('/api/stream')) {
      return streamResponse(': connected\n\n');
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), {
    fetch: fetchImpl,
    now: () => 0,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => cleared.add(timer)
  });
  const agent = poller.agents[0];
  poller.running = true;
  const stream = poller._streamState(agent);
  const run = poller._runSse(agent, stream, new AbortController().signal).catch(err => err);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(timers[0].ms, 3000);

  timers[0].fn();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(stream.pollTimer, 'compatibility fallback should start polling');

  poller._handleSseEvent(agent, { event: 'fleet_state', data: '{"state":"BUSY"}' });
  assert.equal(stream.pollTimer, null);
  assert.ok(cleared.has(timers[0]));
  poller.running = false;
  await run;
});

test('fleet poller onPoll receives safe remote fleet after poll cycle completion', async () => {
  let onPollFleet = null;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_ok', expires_at: new Date(120000).toISOString() });
    }
    return jsonResponse({ state: 'IDLE' });
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), {
    fetch: fetchImpl,
    now: () => 0,
    onPoll: (fleet) => { onPollFleet = fleet; }
  });

  await poller.pollOnce();
  assert.equal(onPollFleet.count, 1);
  assert.equal(onPollFleet.agents[0].name, 'Remote');
  assert.equal(JSON.stringify(onPollFleet).includes('zylos_ak_secret'), false);
  assert.equal(JSON.stringify(onPollFleet).includes('zylos_st_ok'), false);
});

test('fleet poller reads top-level context_pct when metrics object is absent (#171)', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_ok', expires_at: new Date(120000).toISOString() });
    }
    return jsonResponse({
      state: 'IDLE',
      context_pct: 63.5,
      session_cost: 0.50
    });
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => 0 });

  await poller.pollOnce();
  const record = poller.getFleet().agents[0];
  assert.equal(record.context_pct, 63.5);
});

// --- Fleet tile iteration 2: name-keyed identity color, activity feed, rate limits ---

test('stateToFleetRecord keys color/hue to the configured display name, not remote self-identity', () => {
  const record = stateToFleetRecord({
    name: 'Jinglever',
    base_url: 'https://example.com/dashboard'
  }, {
    state: 'IDLE',
    agent: { name: 'some-hostname.local', color: '#4f46e5', hue: 330 }
  }, { self: false, nowMs: 0 });

  assert.equal(record.color, agentColor('Jinglever').color);
  assert.equal(record.hue, agentColor('Jinglever').hue);
});

test('stateToFleetRecord still honours explicit per-agent color overrides from fleet config', () => {
  const record = stateToFleetRecord({
    name: 'Jinglever',
    color: '#123456',
    hue: 42
  }, {
    state: 'IDLE',
    agent: { hue: 330 }
  }, { self: false, nowMs: 0 });

  assert.equal(record.color, '#123456');
  assert.equal(record.hue, 42);
});

test('stateToFleetRecord derives activity_feed from running tools', () => {
  const record = stateToFleetRecord({ name: 'a' }, {
    state: 'BUSY',
    running_tools: [
      { tool_name: 'Bash', tool_detail: 'npm test', started_at: '2026-06-10T00:00:00Z' },
      { tool_name: 'Read', tool_detail: 'foo.js', started_at: '2026-06-10T00:00:05Z' }
    ]
  }, { self: false, nowMs: 0 });

  assert.equal(record.activity_feed.length, 2);
  assert.deepEqual(record.activity_feed[0], {
    kind: 'tool', label: 'Bash: npm test', started_at: '2026-06-10T00:00:00Z'
  });
  assert.deepEqual(record.activity_feed[1], {
    kind: 'tool', label: 'Read: foo.js', started_at: '2026-06-10T00:00:05Z'
  });
});

test('stateToFleetRecord activity_feed shows thinking when busy without tools, empty when idle', () => {
  const busy = stateToFleetRecord({ name: 'a' }, { state: 'BUSY', running_tools: [] }, { self: false, nowMs: 0 });
  assert.deepEqual(busy.activity_feed, [{ kind: 'thinking', label: null, started_at: null }]);

  const idle = stateToFleetRecord({ name: 'a' }, { state: 'IDLE' }, { self: false, nowMs: 0 });
  assert.deepEqual(idle.activity_feed, []);
});

test('stateToFleetRecord passes rate limit percentages through, defaulting to null', () => {
  const withRates = stateToFleetRecord({ name: 'a' }, {
    state: 'IDLE', rate_limit_pct: 13, rate_limit_7d_pct: 9
  }, { self: false, nowMs: 0 });
  assert.equal(withRates.rate_limit_pct, 13);
  assert.equal(withRates.rate_limit_7d_pct, 9);

  const without = stateToFleetRecord({ name: 'a' }, { state: 'IDLE' }, { self: false, nowMs: 0 });
  assert.equal(without.rate_limit_pct, null);
  assert.equal(without.rate_limit_7d_pct, null);
});
