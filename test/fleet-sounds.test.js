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

// ─── Suspended AudioContext: unmute confirmation must survive resume() ───
// Reproduces the review finding on #194: resume() is async, so a synchronous
// state check after unmute dropped the confirmation blip.

class FakeAudioContext {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 0;
    this.destination = {};
    this.resumeCalls = 0;
    this.oscillatorStarts = 0;
  }
  resume() {
    this.resumeCalls += 1;
    // Flip state in a microtask, like a real browser: a synchronous state
    // check right after resume() must still see 'suspended', which is
    // exactly what the original bug relied on.
    return Promise.resolve().then(() => { this.state = 'running'; });
  }
  createOscillator() {
    const ctx = this;
    return {
      type: '',
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect(node) { return node; },
      start() { ctx.oscillatorStarts += 1; },
      stop() {}
    };
  }
  createGain() {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect(node) { return node; }
    };
  }
}

function fakeButton() {
  const handlers = {};
  return {
    textContent: '',
    title: '',
    attrs: {},
    addEventListener(name, fn) { handlers[name] = fn; },
    setAttribute(name, value) { this.attrs[name] = value; },
    click() { handlers.click?.(); }
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('unmute confirmation plays after a suspended context resumes', async (t) => {
  const ctx = new FakeAudioContext();
  globalThis.window = { AudioContext: function () { return ctx; } };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  t.after(() => { delete globalThis.window; delete globalThis.localStorage; });

  const { createFleetSounds } = await import('../public/js/fleet-sounds.js');
  const button = fakeButton();
  const sounds = createFleetSounds({ button });
  assert.equal(sounds.isMuted(), true);

  button.click(); // unmute — the context is still suspended at this point
  assert.equal(sounds.isMuted(), false);
  assert.ok(ctx.resumeCalls >= 1);

  await flushMicrotasks();
  assert.equal(ctx.oscillatorStarts, 1, 'confirmation blip plays once resume() settles');
});

test('first cue after unmute is not dropped by a suspended context', async (t) => {
  const ctx = new FakeAudioContext();
  globalThis.window = { AudioContext: function () { return ctx; } };
  globalThis.localStorage = { getItem: () => 'false', setItem: () => {} }; // stored unmuted
  t.after(() => { delete globalThis.window; delete globalThis.localStorage; });

  const { createFleetSounds } = await import('../public/js/fleet-sounds.js');
  const sounds = createFleetSounds({});
  assert.equal(sounds.isMuted(), false);

  sounds.handleFleet({ agents: [{ name: 'a', state: 'IDLE' }] }); // seed
  sounds.handleFleet({ agents: [{ name: 'a', state: 'BUSY' }] }); // start cue, ctx suspended
  await flushMicrotasks();
  assert.equal(ctx.oscillatorStarts, 1, 'start cue plays after resume() settles');
});
