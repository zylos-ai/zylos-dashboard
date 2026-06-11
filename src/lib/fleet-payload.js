const SECRET_PATTERNS = [
  'read_api_key',
  'read_session_token',
  'zylos_ak_',
  'zylos_st_'
];

export function assertFleetPayloadSafe(payload) {
  const serialized = JSON.stringify(payload);
  if (SECRET_PATTERNS.some((pattern) => serialized.includes(pattern))) {
    const err = new Error('fleet_secret_leak_guard');
    err.code = 'fleet_secret_leak_guard';
    throw err;
  }
}

export function buildFleetPayload({ remoteFleet, selfRecord, nowIso = new Date().toISOString() }) {
  const remoteAgents = Array.isArray(remoteFleet?.agents) ? remoteFleet.agents : [];
  const agents = [
    { ...selfRecord, self: true, access: 'admin' },
    ...remoteAgents.map((agent) => ({
      ...agent,
      self: agent.self === true,
      access: agent.access === 'admin' ? 'admin' : 'read'
    }))
  ];
  const payload = {
    ...(remoteFleet || {}),
    agents,
    count: agents.length,
    updated_at: remoteFleet?.updated_at || nowIso
  };
  assertFleetPayloadSafe(payload);
  return payload;
}
