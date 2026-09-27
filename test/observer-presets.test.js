import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import { OBSERVER_PRESET_DIMENSIONS } from '../public/js/observer-presets.js';
import { ObserverUpstream, OBSERVER_PRESET_DIMENSIONS as UPSTREAM_PRESETS } from '../src/lib/observer-upstream.js';
import { observerFrameDocument } from '../src/lib/observer-frame.js';

test('Observer renderer, upstream resizes and controls agree on all 40-row presets', () => {
  const expected = { standard: { cols: 80, rows: 40 }, wide: { cols: 110, rows: 40 }, large: { cols: 140, rows: 40 } };
  assert.deepEqual(OBSERVER_PRESET_DIMENSIONS, expected);
  assert.equal(UPSTREAM_PRESETS, OBSERVER_PRESET_DIMENSIONS);

  const rendererSizes = [];
  const context = {
    parent: {}, document: { getElementById: () => ({}) },
    Terminal: class {
      constructor(options) { rendererSizes.push({ cols: options.cols, rows: options.rows }); }
      open() {}
      resize(cols, rows) { rendererSizes.push({ cols, rows }); }
    },
    addEventListener() {}, removeEventListener() {},
  };
  const script = observerFrameDocument().split('<script nonce="observer-frame">').at(-1).split('</script>')[0];
  vm.runInNewContext(script, context);
  assert.deepEqual(rendererSizes[0], expected.standard, 'initial terminal dimensions');
  const channel = { start() {}, postMessage() {} };
  context.initialize({ source: context.parent, data: { type: 'observer-init' }, ports: [channel] });
  const messages = [];
  const upstream = new ObserverUpstream({ active: {} });
  upstream.webClientId = 'viewer';
  upstream.control = { sendText(message) { messages.push(JSON.parse(message)); return true; } };
  for (const [preset, dimensions] of Object.entries(expected)) {
    channel.onmessage({ data: { type: 'preset', preset } });
    assert.deepEqual(rendererSizes.at(-1), dimensions);
    assert.equal(upstream.resize(preset), true);
    assert.deepEqual(messages.at(-1).payload, { type: 'TerminalResize', ...dimensions });
  }

  const buttons = Object.keys(expected).map((preset) => ({ dataset: { observerPreset: preset }, addEventListener() {} }));
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const init = app.slice(app.indexOf('function initObserverControls()'), app.indexOf('function initMemoryControls()'));
  vm.runInNewContext(`${init}\ninitObserverControls();`, {
    OBSERVER_PRESET_DIMENSIONS, document: { querySelectorAll: () => buttons },
  });
  assert.deepEqual(buttons.map((button) => button.textContent), ['80×40', '110×40', '140×40']);
});
