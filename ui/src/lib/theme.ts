import { readStored, writeStored } from './storage'

export type Theme = 'dark' | 'light'
export const THEME_KEY = 'evals-ui-theme'

export function initialTheme(): Theme {
  return readStored(THEME_KEY) === 'light' ? 'light' : 'dark'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  const meta = document.querySelector('meta[name="theme-color"]')
  meta?.setAttribute('content', theme === 'light' ? '#F6F1E6' : '#12100D')
}

export function saveTheme(theme: Theme): void {
  writeStored(THEME_KEY, theme)
}
