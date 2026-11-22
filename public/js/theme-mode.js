// Theme mode chosen by the user ('system' follows prefers-color-scheme) and
// the light/dark theme it resolves to. The dashboard (app.js) runs initTheme();
// the login page only reuses THEME_KEY. The inline bootstrap in index.html
// repeats the resolution because it must run before first paint, without modules.
export const THEME_KEY = 'zylos-dashboard-theme-mode';
export const THEME_MODES = Object.freeze(['system', 'light', 'dark']);
// Pre-dark-mode builds always wrote 'light' here, so it never meant a choice.
export const LEGACY_THEME_KEY = 'zylos-dashboard-theme';

export function normalizeThemeMode(mode) {
  return THEME_MODES.includes(mode) ? mode : 'system';
}

export function resolveTheme(mode, systemDark) {
  const normalized = normalizeThemeMode(mode);
  return normalized === 'dark' || (normalized === 'system' && Boolean(systemDark)) ? 'dark' : 'light';
}

export function nextThemeMode(mode) {
  return THEME_MODES[(THEME_MODES.indexOf(normalizeThemeMode(mode)) + 1) % THEME_MODES.length];
}

// Applies `mode` to the root element and toggle button; returns the normalized mode.
export function applyTheme(mode, { root, darkQuery, toggle, t, onApply }) {
  const themeMode = normalizeThemeMode(mode);
  root.dataset.theme = resolveTheme(themeMode, darkQuery?.matches);
  root.dataset.themeMode = themeMode;
  if (toggle) {
    toggle.dataset.i18nTitle = `theme.${themeMode}`;
    toggle.title = t(toggle.dataset.i18nTitle);
  }
  onApply?.();
  return themeMode;
}

// Adopts the mode the inline bootstrap set on `root`, follows system changes
// while in system mode, and wires the toggle to cycle and persist the mode.
// getStorage is called inside try: reading window.localStorage itself can throw.
export function initTheme({ root, getStorage, darkQuery, toggle, t, onApply }) {
  const env = { root, darkQuery, toggle, t, onApply };
  try { getStorage().removeItem(LEGACY_THEME_KEY); } catch { /* storage unavailable */ }
  let themeMode = applyTheme(root.dataset.themeMode, env);
  darkQuery?.addEventListener?.('change', () => {
    if (themeMode === 'system') themeMode = applyTheme('system', env);
  });
  toggle?.addEventListener('click', () => {
    const next = nextThemeMode(themeMode);
    try { getStorage().setItem(THEME_KEY, next); } catch { /* best-effort */ }
    themeMode = applyTheme(next, env);
  });
}
