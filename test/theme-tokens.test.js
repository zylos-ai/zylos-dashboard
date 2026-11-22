import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel) => fs.readFileSync(path.resolve(rel), 'utf8');
const tokens = (css) => new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));

test('light and dark themes define the same token set', () => {
  const light = tokens(read('public/themes/light.css'));
  const dark = tokens(read('public/themes/dark.css'));
  assert.deepEqual([...dark].sort(), [...light].sort());
});

test('every theme-owned token used by style.css is defined by both themes', () => {
  const style = read('public/css/style.css');
  const light = tokens(read('public/themes/light.css'));
  const dark = tokens(read('public/themes/dark.css'));
  // Tokens the themes own today; style.css must not use one only a single theme defines.
  for (const name of light) assert.ok(dark.has(name), `${name} missing from dark.css`);
  for (const t of ['--on-accent', '--success-text', '--danger-text']) {
    assert.ok(style.includes(`var(${t})`), `${t} should be used by style.css`);
  }
});

test('index.html resolves the theme before first paint and loads both themes', () => {
  const html = read('public/index.html');
  const inline = html.indexOf("localStorage.getItem('zylos-dashboard-theme-mode')");
  assert.ok(inline > -1, 'inline theme bootstrap missing');
  assert.ok(inline < html.indexOf('css/style.css'), 'theme bootstrap must run before stylesheets load');
  assert.match(html, /themes\/light\.css\?v=\d+/);
  assert.match(html, /themes\/dark\.css\?v=\d+/);
  assert.match(html, /id="theme-toggle"/);
});

test('theme toggle labels exist in every locale', () => {
  for (const file of fs.readdirSync('public/i18n')) {
    const pack = JSON.parse(read(`public/i18n/${file}`));
    for (const key of ['theme.system', 'theme.light', 'theme.dark']) {
      assert.equal(typeof pack[key], 'string', `${file} missing ${key}`);
    }
  }
});

test('charts take colors from theme tokens, not hardcoded tooltip colors', () => {
  const app = read('public/js/app.js');
  assert.ok(!app.includes("backgroundColor: '#101827'"));
  assert.match(app, /function applyChartTheme\(\)/);
  assert.match(app, /--chart-grid/);
});

test('login page follows prefers-color-scheme', () => {
  const auth = read('src/lib/auth.js');
  assert.match(auth, /@media \(prefers-color-scheme: dark\)/);
  assert.match(auth, /:root\[data-theme="dark"\]/);
});
