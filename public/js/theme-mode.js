// Theme mode chosen by the user ('system' follows prefers-color-scheme) and
// the light/dark theme it resolves to. The inline bootstrap in index.html
// repeats this logic because it must run before first paint, without modules.
export const THEME_KEY = 'zylos-dashboard-theme-mode';
export const THEME_MODES = Object.freeze(['system', 'light', 'dark']);

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
