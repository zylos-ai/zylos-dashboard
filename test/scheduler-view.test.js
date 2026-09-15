import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSchedulerView } from '../public/js/scheduler-view.js';

test('scheduler view distinguishes unavailable data from an empty queue', () => {
  assert.deepEqual(buildSchedulerView({
    health: 'unknown',
    pending: null,
    upcoming: []
  }), {
    state: 'unknown',
    pending: null,
    upcoming: []
  });

  assert.deepEqual(buildSchedulerView({
    health: 'healthy',
    pending: 0,
    upcoming: []
  }), {
    state: 'empty',
    pending: 0,
    upcoming: []
  });
});

test('scheduler view labels upcoming work with opaque IDs only', () => {
  assert.deepEqual(buildSchedulerView({
    health: 'degraded',
    pending: 1,
    upcoming: [{
      id: 'task-opaque-id',
      name: 'private name',
      prompt: 'private prompt',
      run_at: '2026-08-18T12:00:00.000Z'
    }]
  }), {
    state: 'tasks',
    pending: 1,
    upcoming: [{
      label: 'task-opaque-id',
      run_at: '2026-08-18T12:00:00.000Z'
    }]
  });
});
