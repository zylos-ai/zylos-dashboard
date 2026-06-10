import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFleetTransitions, isWorkingMood } from '../public/js/fleet-sounds.js';

const agent = (name, state, extra = {}) => ({ name, state, ...extra });

test('working moods are busy and thinking only', () => {
  assert.equal(isWorkingMood('busy'), true);
  assert.equal(isWorkingMood('thinking'), true);
  assert.equal(isWorkingMood('idle'), false);
  assert.equal(isWorkingMood('stuck'), false);
  assert.equal(isWorkingMood('offline'), false);
});

test('first payload seeds silently', () => {
  const { moods, started, finished } = computeFleetTransitions(new Map(), [
    agent('a', 'BUSY'),
    agent('b', 'IDLE')
  ]);
  assert.deepEqual(started, []);
  assert.deepEqual(finished, []);
  assert.equal(moods.get('a'), 'busy');
  assert.equal(moods.get('b'), 'idle');
});

test('idle -> busy fires start', () => {
  const prev = new Map([['a', 'idle']]);
  const { started, finished } = computeFleetTransitions(prev, [agent('a', 'BUSY')]);
  assert.deepEqual(started, ['a']);
  assert.deepEqual(finished, []);
});

test('busy -> idle fires finish', () => {
  const prev = new Map([['a', 'busy']]);
  const { started, finished } = computeFleetTransitions(prev, [agent('a', 'IDLE')]);
  assert.deepEqual(started, []);
  assert.deepEqual(finished, ['a']);
});

test('busy <-> thinking is not a transition', () => {
  const prev = new Map([['a', 'busy']]);
  const { started, finished } = computeFleetTransitions(prev, [agent('a', 'THINKING')]);
  assert.deepEqual(started, []);
  assert.deepEqual(finished, []);
});

test('working -> stuck/offline does not fire finish', () => {
  const prev = new Map([['a', 'busy'], ['b', 'thinking']]);
  const { started, finished } = computeFleetTransitions(prev, [
    agent('a', 'STUCK'),
    agent('b', 'OFFLINE')
  ]);
  assert.deepEqual(started, []);
  assert.deepEqual(finished, []);
});

test('offline -> busy fires start (recovered agent picks up work)', () => {
  const prev = new Map([['a', 'offline']]);
  const { started } = computeFleetTransitions(prev, [agent('a', 'BUSY')]);
  assert.deepEqual(started, ['a']);
});

test('new agent mid-session seeds silently even when busy', () => {
  const prev = new Map([['a', 'idle']]);
  const { started, moods } = computeFleetTransitions(prev, [
    agent('a', 'IDLE'),
    agent('new', 'BUSY')
  ]);
  assert.deepEqual(started, []);
  assert.equal(moods.get('new'), 'busy');
});

test('removed agent drops out of the mood map', () => {
  const prev = new Map([['a', 'busy'], ['gone', 'busy']]);
  const { moods, finished } = computeFleetTransitions(prev, [agent('a', 'BUSY')]);
  assert.equal(moods.has('gone'), false);
  assert.deepEqual(finished, []);
});

test('same payload reprocessed is a no-op (hover-pause replay)', () => {
  const payload = [agent('a', 'BUSY'), agent('b', 'IDLE')];
  const first = computeFleetTransitions(new Map([['a', 'idle'], ['b', 'idle']]), payload);
  assert.deepEqual(first.started, ['a']);
  const second = computeFleetTransitions(first.moods, payload);
  assert.deepEqual(second.started, []);
  assert.deepEqual(second.finished, []);
});

test('multiple simultaneous transitions are all reported', () => {
  const prev = new Map([['a', 'idle'], ['b', 'busy'], ['c', 'thinking']]);
  const { started, finished } = computeFleetTransitions(prev, [
    agent('a', 'BUSY'),
    agent('b', 'IDLE'),
    agent('c', 'IDLE')
  ]);
  assert.deepEqual(started, ['a']);
  assert.deepEqual(finished, ['b', 'c']);
});

test('handles missing or malformed agent lists', () => {
  assert.deepEqual(computeFleetTransitions(new Map(), null).started, []);
  assert.deepEqual(computeFleetTransitions(new Map(), undefined).finished, []);
  const { moods } = computeFleetTransitions(new Map(), [{ state: 'BUSY' }]);
  assert.equal(moods.size, 0);
});
