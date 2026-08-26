/**
 * Normalize the scheduler API payload into a privacy-safe display model.
 */
export function buildSchedulerView(scheduler) {
  if (!scheduler || scheduler.health === 'unknown') {
    return { state: 'unknown', pending: null, upcoming: [] };
  }

  const upcoming = Array.isArray(scheduler.upcoming)
    ? scheduler.upcoming.map((task) => ({
      label: String(task?.id ?? ''),
      run_at: task?.run_at ?? null
    }))
    : [];

  return {
    state: upcoming.length > 0 ? 'tasks' : 'empty',
    pending: Number.isInteger(scheduler.pending) ? scheduler.pending : 0,
    upcoming
  };
}
