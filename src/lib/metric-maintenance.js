export function runMetricMaintenance(store, { now = new Date(), lastVacuumDate = null, vacuumMaxBytes = 2 * 1024 * 1024 * 1024 } = {}) {
  store.deleteMetricsByNameAndSource('usage_event', '%', 90);
  store.deleteMetricsByNameAndSource('ttft%', '%', 90);
  store.deleteMetricsByNameAndSource('turn_duration%', '%', 90);
  store.deleteMetricsByNameAndSource('statusline_summary', '%', 30);
  store.deleteMetricsByNameAndSource('system_summary', '%', 14);
  store.deleteMetricsByNameAndSource('pm2_summary', '%', 7);
  store.deleteMetricsByNameAndSource('pm2_%', '%', 7);
  store.deleteOtherLegacyMetricsOlderThan(90);
  store.deleteEventsOlderThan(30);
  store.deleteSnapshotsOlderThan(7);
  store.deleteFactsOlderThan(365);
  store.walCheckpoint();

  const dateKey = now.toISOString().slice(0, 10);
  const shouldVacuum = now.getUTCDay() === 0 && lastVacuumDate !== dateKey;
  if (!shouldVacuum) return { vacuum: null, lastVacuumDate };
  const vacuum = store.vacuumIfSmall(vacuumMaxBytes);
  return { vacuum, lastVacuumDate: dateKey };
}
