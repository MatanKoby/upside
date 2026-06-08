// Theme preference (Batch 15). The palette lives in styles/tokens.css as a
// light `:root` default plus a `[data-theme='dark']` override; switching themes
// is just flipping `document.documentElement.dataset.theme`. The user's choice
// persists in localStorage (a per-device UI concern, not a synced account
// pref), and index.html applies it before first paint to avoid a flash.

export type ThemePref = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'upside-theme';

// Keep in sync with --bg in styles/tokens.css (used for the browser chrome /
// PWA status-bar color via <meta name="theme-color">).
const META_COLOR: Record<'light' | 'dark', string> = {
  light: '#ffffff',
  dark: '#0f0f0f',
};

export function getThemePref(): ThemePref {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'light' || pref === 'dark') return pref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(pref: ThemePref): void {
  if (pref === 'system') localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, pref);

  const effective = resolveTheme(pref);
  document.documentElement.dataset.theme = effective;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', META_COLOR[effective]);
}
