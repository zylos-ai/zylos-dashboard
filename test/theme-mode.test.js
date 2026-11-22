import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { THEME_KEY, THEME_MODES, nextThemeMode, normalizeThemeMode, resolveTheme } from '../public/js/theme-mode.js';

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

function runIndexBootstrap({ stored, systemDark, storageThrows = false }) {
  const html = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const attrs = {};
  const storage = memoryStorage(stored === undefined ? {} : { [THEME_KEY]: stored });
  const context = {
    localStorage: storageThrows ? { getItem() { throw new Error('denied'); } } : storage,
    window: { matchMedia: (query) => ({ matches: query === '(prefers-color-scheme: dark)' && systemDark }) },
    document: { documentElement: { setAttribute: (name, value) => { attrs[name] = value; } } }
  };
  vm.runInNewContext(source, context);
  return attrs;
}

test('index.html bootstrap resolves the stored mode and system scheme before first paint', () => {
  for (const systemDark of [false, true]) {
    for (const stored of [undefined, 'system', 'light', 'dark', 'bogus']) {
      const mode = normalizeThemeMode(stored);
      assert.deepEqual(runIndexBootstrap({ stored, systemDark }), {
        'data-theme': resolveTheme(mode, systemDark),
        'data-theme-mode': mode
      }, `stored=${stored} systemDark=${systemDark}`);
    }
  }
  assert.deepEqual(runIndexBootstrap({ systemDark: true, storageThrows: true }), { 'data-theme': 'dark', 'data-theme-mode': 'system' });
});

function themeHarness({ bootMode, systemDark, storage = memoryStorage() }) {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  const start = app.indexOf('// ─── Theme ───');
  const source = app.slice(start, app.indexOf('// ─── Formatting ───', start));
  const query = fakeDarkQuery(systemDark);
  const button = { dataset: {}, listeners: {}, addEventListener(event, handler) { this.listeners[event] = handler; } };
  const root = { dataset: bootMode ? { themeMode: bootMode } : {} };
  let chartThemeCalls = 0;
  const context = {
    window: { matchMedia: () => query },
    document: { documentElement: root },
    $: (selector) => (selector === '#theme-toggle' ? button : null),
    t: (key) => `t:${key}`,
    localStorage: storage,
    applyChartTheme: () => { chartThemeCalls += 1; },
    LEGACY_THEME_KEY: 'zylos-dashboard-theme',
    THEME_KEY,
    normalizeThemeMode,
    resolveTheme,
    nextThemeMode
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.initTheme();
  return { root, button, query, storage, click: () => button.listeners.click(), chartThemeCalls: () => chartThemeCalls };
}

test('initTheme adopts the mode set by the bootstrap and drops the legacy key', () => {
  const storage = memoryStorage({ 'zylos-dashboard-theme': 'light' });
  const ui = themeHarness({ bootMode: 'dark', systemDark: false, storage });
  assert.equal(ui.root.dataset.theme, 'dark');
  assert.equal(ui.root.dataset.themeMode, 'dark');
  assert.equal(ui.button.title, 't:theme.dark');
  assert.equal('zylos-dashboard-theme' in storage.items, false);
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
});
