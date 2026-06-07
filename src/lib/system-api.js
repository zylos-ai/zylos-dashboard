export function buildSystemPayload({ pm2Data, sysData, pm2State = [], systemSummary = null, scheduler = null }) {
  const pm2UpdatedAt = pm2State
    .map(p => p.updated_at)
    .filter(Boolean)
    .sort()
    .at(-1);

  return {
    pm2: pm2Data ? pm2Data.processes : (pm2State.length > 0 ? pm2State : null),
    system: sysData || systemSummary?.dimensions || null,
    scheduler: scheduler || null,
    collected_at: {
      pm2: pm2Data ? new Date(pm2Data.collectedAt).toISOString() : (pm2UpdatedAt || null),
      system: sysData ? new Date(sysData.collectedAt).toISOString() : (systemSummary?.timestamp || null)
    }
  };
}
