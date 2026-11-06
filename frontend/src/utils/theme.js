const THEME_KEY = 'sc_theme';

function readStoredTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

function systemTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** The saved choice, or the system preference when the user has not picked one. */
export function currentTheme() {
  return readStoredTheme() || systemTheme();
}

/** Runs before first render. With nothing saved, the CSS follows the system preference. */
export function applyStoredTheme() {
  const stored = readStoredTheme();
  if (stored) document.documentElement.dataset.theme = stored;
}

export function saveTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* The theme still applies for this page view. */
  }
}
