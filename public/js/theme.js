const storageKey = 'zylos-dashboard-theme';
const button = document.querySelector('#theme-toggle');

function apply(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(storageKey, theme);
  window.dispatchEvent(new Event('themechange'));
}

const initial = localStorage.getItem(storageKey) || document.documentElement.dataset.theme || 'default';
apply(initial);

button?.addEventListener('click', () => {
  apply(document.documentElement.dataset.theme === 'dark' ? 'default' : 'dark');
});
