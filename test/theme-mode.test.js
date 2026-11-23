import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { LEGACY_THEME_KEY, THEME_KEY, THEME_MODES, initTheme, nextThemeMode, normalizeThemeMode, resolveTheme } from '../public/js/theme-mode.js';

function memoryStorage(initial = {}) {
  const items = { ...initial };
  return {
    items,
    getItem: (key) => (key in items ? items[key] : null),
    setItem: (key, value) => { items[key] = String(value); },
    removeItem: (key) => { delete items[key]; }
  };
}

function fakeDarkQuery(matches) {
  const listeners = [];
  return {
    matches,
    addEventListener: (event, handler) => { if (event === 'change') listeners.push(handler); },
    change(next) { this.matches = next; for (const handler of listeners) handler({ matches: next }); }
  };
}

test('resolveTheme follows the system only in system mode', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme(null, true), 'dark');
  assert.equal(resolveTheme('bogus', false), 'light');
});

test('normalizeThemeMode falls back to system for unknown values', () => {
  for (const mode of THEME_MODES) assert.equal(normalizeThemeMode(mode), mode);
  for (const mode of [null, undefined, '', 'Light', 'auto']) assert.equal(normalizeThemeMode(mode), 'system');
});

test('nextThemeMode cycles system -> light -> dark -> system', () => {
  assert.equal(nextThemeMode('system'), 'light');
  assert.equal(nextThemeMode('light'), 'dark');
  assert.equal(nextThemeMode('dark'), 'system');
  assert.equal(nextThemeMode('bogus'), 'light');
});

// The inline bootstrap cannot import theme-mode.js and is not executed here;
// its behavior is only covered by the browser sweep. This guards the shared literals.
test('index.html bootstrap uses the same storage key and mode names as theme-mode.js', () => {
  const html = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const literals = new Set([...source.matchAll(/'([^']*)'/g)].map((m) => m[1]));
  assert.ok(literals.has(THEME_KEY), `inline script should read '${THEME_KEY}'`);
  for (const mode of THEME_MODES) assert.ok(literals.has(mode), `inline script should know mode '${mode}'`);
  for (const attr of ['data-theme', 'data-theme-mode']) assert.ok(literals.has(attr), `inline script should set ${attr}`);
});

function themeHarness({ bootMode, systemDark, storage = memoryStorage() }) {
  const query = fakeDarkQuery(systemDark);
  const button = { dataset: {}, listeners: {}, addEventListener(event, handler) { this.listeners[event] = handler; } };
  const root = { dataset: bootMode ? { themeMode: bootMode } : {} };
  let chartThemeCalls = 0;
  initTheme({
    root,
    getStorage: () => storage,
    darkQuery: query,
    toggle: button,
    t: (key) => `t:${key}`,
    onApply: () => { chartThemeCalls += 1; }
  });
  return { root, button, query, storage, click: () => button.listeners.click(), chartThemeCalls: () => chartThemeCalls };
}

test('initTheme adopts the mode set by the bootstrap and drops the legacy key', () => {
  const storage = memoryStorage({ [LEGACY_THEME_KEY]: 'light' });
  const ui = themeHarness({ bootMode: 'dark', systemDark: false, storage });
  assert.equal(ui.root.dataset.theme, 'dark');
  assert.equal(ui.root.dataset.themeMode, 'dark');
  assert.equal(ui.button.title, 't:theme.dark');
  assert.equal(LEGACY_THEME_KEY in storage.items, false);
  assert.equal(ui.chartThemeCalls(), 1);
});

test('system mode tracks prefers-color-scheme changes; a manual mode ignores them', () => {
  const ui = themeHarness({ bootMode: 'system', systemDark: false });
  assert.equal(ui.root.dataset.theme, 'light');
  ui.query.change(true);
  assert.equal(ui.root.dataset.theme, 'dark');
  assert.equal(ui.chartThemeCalls(), 2);

  const manual = themeHarness({ bootMode: 'light', systemDark: false });
  manual.query.change(true);
  assert.equal(manual.root.dataset.theme, 'light');
});

test('theme toggle cycles modes, persists each choice and re-themes the page', () => {
  const ui = themeHarness({ bootMode: 'system', systemDark: true });
  assert.equal(ui.root.dataset.theme, 'dark');
  const seen = [];
  for (let i = 0; i < 3; i += 1) {
    ui.click();
    seen.push([ui.root.dataset.themeMode, ui.root.dataset.theme, ui.storage.items[THEME_KEY], ui.button.title]);
  }
  assert.deepEqual(seen, [
    ['light', 'light', 'light', 't:theme.light'],
    ['dark', 'dark', 'dark', 't:theme.dark'],
    ['system', 'dark', 'system', 't:theme.system']
  ]);
  assert.equal(ui.chartThemeCalls(), 4);
});

test('initTheme and the toggle still work when storage access throws', () => {
  const root = { dataset: { themeMode: 'system' } };
  const button = { dataset: {}, addEventListener(event, handler) { this.click = handler; } };
  initTheme({ root, getStorage: () => { throw new Error('denied'); }, darkQuery: fakeDarkQuery(true), toggle: button, t: (key) => key });
  assert.equal(root.dataset.theme, 'dark');
  button.click();
  assert.deepEqual([root.dataset.themeMode, root.dataset.theme], ['light', 'light']);
});
